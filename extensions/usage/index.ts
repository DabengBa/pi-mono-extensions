/**
 * /usage — token & spend dashboard with sustainability impact.
 *
 * Walks the local pi sessions directory, aggregates assistant-message usage
 * blocks, and renders a tabbed inline panel:
 *
 *   • Summary  — totals, top providers, environmental footprint
 *   • Providers — per-provider / per-model breakdown
 *   • Patterns — cost-driver insights for the selected period
 *   • Tools    — per-extension / per-tool call breakdown
 *   • Activity — contribution-style heatmap of daily usage + streaks
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	CancellableLoader,
	Container,
	Spacer,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { estimateAiImpact, type AiEstimateResult } from "impact-equivalences";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Period = "day" | "week" | "month" | "all";
type View = "summary" | "providers" | "patterns" | "tools" | "activity";
type Metric = "tokens" | "cost";

interface TokenBucket {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface Aggregate {
	cost: number;
	calls: number;
	tokens: TokenBucket;
	sessions: Set<string>;
}

interface ModelBucket extends Aggregate {}

interface ProviderBucket extends Aggregate {
	models: Map<string, ModelBucket>;
}

interface ToolBucket {
	calls: number;
	resultTokens: number;
	sessions: Set<string>;
}

interface ToolGroupBucket extends ToolBucket {
	tools: Map<string, ToolBucket>;
}

type ToolRegistry = Map<string, string>;

interface RawTurn {
	sessionId: string;
	provider: string;
	model: string;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	ts: number;
}

interface RawToolUse {
	sessionId: string;
	name: string;
	resultTokens: number;
	ts: number;
}

interface InsightRow {
	weight: number;
	headline: string;
	hint: string;
}

interface PeriodReport {
	providers: Map<string, ProviderBucket>;
	toolGroups: Map<string, ToolGroupBucket>;
	totals: Aggregate;
	turns: RawTurn[];
	insights: InsightRow[];
}

interface SessionLifespan {
	first: number;
	last: number;
}

interface DayBucket {
	tokens: number;
	cost: number;
	calls: number;
}

interface UsageReport {
	day: PeriodReport;
	week: PeriodReport;
	month: PeriodReport;
	all: PeriodReport;
	lifespans: Map<string, SessionLifespan>;
	/** Daily totals keyed by local `YYYY-MM-DD`, across all history. */
	days: Map<string, DayBucket>;
}

interface SessionRecord {
	sessionId: string;
	turns: RawTurn[];
	tools: RawToolUse[];
}

interface PeriodBoundaries {
	dayStart: number;
	weekStart: number;
	monthStart: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PERIOD_ORDER: readonly Period[] = ["day", "week", "month", "all"];
const VIEW_ORDER: readonly View[] = [
	"summary",
	"providers",
	"patterns",
	"tools",
	"activity",
];

const PERIOD_LABELS: Record<Period, string> = {
	day: "Today",
	week: "This Week",
	month: "This Month",
	all: "All Time",
};

const VIEW_LABELS: Record<View, string> = {
	summary: "Summary",
	providers: "Providers",
	patterns: "Patterns",
	tools: "Tools",
	activity: "Activity",
};

const NAME_COL_MAX = 28;
const NAME_COL_MIN_FULL = NAME_COL_MAX;

const PARALLEL_RADIUS_MS = 2 * 60_000;
const PARALLEL_THRESHOLD = 4;
const HEAVY_CONTEXT = 150_000;
const HEAVY_UNCACHED = 100_000;
const LONG_SESSION_MS = 8 * 60 * 60 * 1000;
const TOP_SESSIONS_PROBE = 5;
const MIN_TURNS_FOR_PARALLEL = 10;
const MIN_INSIGHT_PERCENT = 1;

const SUMMARY_TOP_PROVIDERS = 3;
const BAR_WIDTH = 24;
const BAR_FILLED = "█";
const BAR_EMPTY = "░";
const BUILT_IN_TOOLS = new Set([
	"bash",
	"edit",
	"read",
	"write",
]);

// Activity heatmap -----------------------------------------------------------
const HEAT_CELL = "■";
const HEAT_CELL_GAP = " ";
const HEAT_CELL_WIDTH = 2;
const HEAT_ROWS = 7;
const HEAT_MAX_WEEKS = 53;
const HEAT_MIN_WEEKS = 8;
const HEAT_ROW_LABEL_WIDTH = 4;
/** Number of intensity tiers for days with activity (level 0 = empty day). */
const HEAT_TIERS = 4;
const HEAT_LEVELS = HEAT_TIERS + 1;
/** Density glyphs used when a theme color can't be resolved to RGB. */
const HEAT_DENSITY_GLYPHS = ["·", "░", "▒", "▓", "█"];
const HEAT_ROW_LABELS = ["Mon", "", "Wed", "", "Fri", "", "Sun"];
const MONTH_LABELS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const agentRoot = (): string => {
	const root = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return root;
};

const sessionRoots = (): string[] => {
	const root = agentRoot();
	return [
		join(root, "sessions"),
		// Team-mode runs durable subprocess workers with explicit --session files
		// under its own storage tree, not under pi's default sessions directory.
		// Include them so /usage reflects delegate/agent spend the same way tools
		// like ccusage do when they scan pi session history recursively.
		join(root, "extensions", "team-mode", "teammates"),
	];
};

async function listSessionFiles(root: string, signal?: AbortSignal): Promise<string[]> {
	const queue: string[] = [root];
	const out: string[] = [];

	while (queue.length > 0) {
		if (signal?.aborted) return [];
		const dir = queue.shift()!;
		let entries: import("node:fs").Dirent[];
		try {
			entries = (await readdir(dir, { withFileTypes: true })) as unknown as import("node:fs").Dirent[];
		} catch {
			continue;
		}
		for (const entry of entries) {
			const name = entry.name;
			const full = join(dir, name);
			if (entry.isDirectory()) queue.push(full);
			else if (entry.isFile() && name.endsWith(".jsonl")) out.push(full);
		}
	}

	return out.sort();
}

async function listFiles(root: string, predicate: (name: string) => boolean, signal?: AbortSignal): Promise<string[]> {
	const queue: string[] = [root];
	const out: string[] = [];

	while (queue.length > 0) {
		if (signal?.aborted) return [];
		const dir = queue.shift()!;
		let entries: import("node:fs").Dirent[];
		try {
			entries = (await readdir(dir, { withFileTypes: true })) as unknown as import("node:fs").Dirent[];
		} catch {
			continue;
		}
		for (const entry of entries) {
			const name = entry.name;
			if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
			const full = join(dir, name);
			if (entry.isDirectory()) queue.push(full);
			else if (entry.isFile() && predicate(name)) out.push(full);
		}
	}

	return out.sort();
}

async function buildToolRegistry(signal?: AbortSignal): Promise<ToolRegistry> {
	const registry: ToolRegistry = new Map();
	const extensionsDir = join(process.cwd(), "extensions");
	let entries: import("node:fs").Dirent[];
	try {
		entries = (await readdir(extensionsDir, { withFileTypes: true })) as unknown as import("node:fs").Dirent[];
	} catch {
		return registry;
	}

	for (const entry of entries) {
		if (signal?.aborted) return registry;
		if (!entry.isDirectory()) continue;
		const extensionDir = join(extensionsDir, entry.name);
		const group = await extensionGroupName(extensionDir, entry.name);
		const files = await listFiles(extensionDir, (name) => name.endsWith(".ts"), signal);
		for (const file of files) {
			if (signal?.aborted) return registry;
			let source = "";
			try {
				source = await readFile(file, "utf8");
			} catch {
				continue;
			}
			for (const toolName of extractRegisteredToolNames(source)) registry.set(toolName, group);
		}
	}

	return registry;
}

async function extensionGroupName(extensionDir: string, fallback: string): Promise<string> {
	try {
		const pkg = JSON.parse(await readFile(join(extensionDir, "package.json"), "utf8"));
		const name = typeof pkg.name === "string" ? pkg.name : fallback;
		return titleCaseWords(name.replace(/^pi-mono-/, ""));
	} catch {
		return titleCaseWords(fallback);
	}
}

function extractRegisteredToolNames(source: string): string[] {
	const names = new Set<string>();
	const patterns = [
		/registerTool\s*\(\s*{[\s\S]*?name:\s*["']([^"']+)["']/g,
	];
	for (const pattern of patterns) {
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(source))) names.add(match[1]!);
	}
	return [...names];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function turnFingerprint(turn: Omit<RawTurn, "sessionId" | "provider" | "model" | "cost">): string {
	return `${turn.ts}|${turn.input}|${turn.output}|${turn.cacheRead}|${turn.cacheWrite}`;
}

async function parseSessionFile(
	path: string,
	seen: Set<string>,
	signal?: AbortSignal,
): Promise<SessionRecord | null> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return null;
	}

	if (signal?.aborted) return null;

	const turns: RawTurn[] = [];
	const tools: RawToolUse[] = [];
	let sessionId = "";
	const lines = raw.trim().split("\n");

	for (let i = 0; i < lines.length; i++) {
		if (signal?.aborted) return null;
		if (i % 400 === 0) await new Promise<void>((resolve) => setImmediate(resolve));

		const line = lines[i]!;
		if (!line.trim()) continue;

		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry.type === "session" && typeof entry.id === "string") {
			sessionId = entry.id;
			continue;
		}

		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role === "toolResult" && typeof msg.toolName === "string") {
			const ts = timestampForMessage(entry, msg);
			tools.push({
				sessionId: "", // filled later once header parsed
				name: msg.toolName,
				resultTokens: estimateTextTokens(toolResultText(msg.content)),
				ts,
			});
			continue;
		}
		if (!msg || msg.role !== "assistant" || !msg.usage || !msg.provider || !msg.model) continue;

		const input = numeric(msg.usage.input);
		const output = numeric(msg.usage.output);
		const cacheRead = numeric(msg.usage.cacheRead);
		const cacheWrite = numeric(msg.usage.cacheWrite);
		const cost = numeric(msg.usage.cost?.total);

		const ts = timestampForMessage(entry, msg);

		const fp = turnFingerprint({ input, output, cacheRead, cacheWrite, ts });
		if (seen.has(fp)) continue;
		seen.add(fp);

		turns.push({
			sessionId: "", // filled later once header parsed
			provider: String(msg.provider),
			model: String(msg.model),
			cost,
			input,
			output,
			cacheRead,
			cacheWrite,
			ts,
		});
	}

	if (!sessionId) return null;
	for (const turn of turns) turn.sessionId = sessionId;
	for (const tool of tools) tool.sessionId = sessionId;
	return { sessionId, turns, tools };
}

function numeric(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : 0;
}

function timestampForMessage(entry: any, msg: any): number {
	const tsCandidate =
		typeof msg?.timestamp === "number"
			? msg.timestamp
			: entry.timestamp
				? Date.parse(entry.timestamp)
				: 0;
	return Number.isFinite(tsCandidate) ? Number(tsCandidate) : 0;
}

function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "");
			return "";
		})
		.join("\n");
}

function estimateTextTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

function groupForTool(name: string, registry: ToolRegistry): string {
	if (BUILT_IN_TOOLS.has(name)) return "Built-in";
	const registeredGroup = registry.get(name);
	if (registeredGroup) return registeredGroup;
	return "Other";
}

function titleCaseWords(value: string): string {
	return value
		.split(/[\s_-]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function emptyTokens(): TokenBucket {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function emptyAggregate(): Aggregate {
	return { cost: 0, calls: 0, tokens: emptyTokens(), sessions: new Set() };
}

function emptyProvider(): ProviderBucket {
	return { ...emptyAggregate(), models: new Map() };
}

function emptyToolBucket(): ToolBucket {
	return { calls: 0, resultTokens: 0, sessions: new Set() };
}

function emptyToolGroup(): ToolGroupBucket {
	return { ...emptyToolBucket(), tools: new Map() };
}

function emptyPeriod(): PeriodReport {
	return {
		providers: new Map(),
		toolGroups: new Map(),
		totals: emptyAggregate(),
		turns: [],
		insights: [],
	};
}

function applyTurn(target: Aggregate, sessionId: string, turn: RawTurn): void {
	target.calls += 1;
	target.cost += turn.cost;
	target.tokens.input += turn.input;
	target.tokens.output += turn.output;
	target.tokens.cacheRead += turn.cacheRead;
	target.tokens.cacheWrite += turn.cacheWrite;
	target.sessions.add(sessionId);
}

function applyTool(target: ToolBucket, sessionId: string, tool: RawToolUse): void {
	target.calls += 1;
	target.resultTokens += tool.resultTokens;
	target.sessions.add(sessionId);
}

function periodsFor(ts: number, b: PeriodBoundaries): Period[] {
	const periods: Period[] = ["all"];
	if (ts >= b.dayStart) periods.push("day");
	if (ts >= b.weekStart) periods.push("week");
	if (ts >= b.monthStart) periods.push("month");
	return periods;
}

function computeBoundaries(now = new Date()): PeriodBoundaries {
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);

	const week = new Date(now);
	const dow = week.getDay();
	const offsetToMonday = dow === 0 ? 6 : dow - 1;
	week.setDate(week.getDate() - offsetToMonday);
	week.setHours(0, 0, 0, 0);

	const month = new Date(now);
	month.setDate(1);
	month.setHours(0, 0, 0, 0);

	return {
		dayStart: day.getTime(),
		weekStart: week.getTime(),
		monthStart: month.getTime(),
	};
}

function dayKey(ts: number): string {
	const d = new Date(ts);
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${month}-${day}`;
}

function startOfDay(ts: number): number {
	const d = new Date(ts);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function placeDay(report: UsageReport, turn: RawTurn): void {
	if (turn.ts <= 0) return;
	const key = dayKey(turn.ts);
	const bucket = report.days.get(key) ?? { tokens: 0, cost: 0, calls: 0 };
	bucket.tokens += turn.input + turn.output + turn.cacheWrite;
	bucket.cost += turn.cost;
	bucket.calls += 1;
	report.days.set(key, bucket);
}

function placeTurn(
	report: UsageReport,
	turn: RawTurn,
	boundaries: PeriodBoundaries,
): void {
	placeDay(report, turn);
	const span = report.lifespans.get(turn.sessionId);
	if (turn.ts > 0) {
		if (!span) {
			report.lifespans.set(turn.sessionId, { first: turn.ts, last: turn.ts });
		} else {
			if (turn.ts < span.first) span.first = turn.ts;
			if (turn.ts > span.last) span.last = turn.ts;
		}
	}

	for (const period of periodsFor(turn.ts, boundaries)) {
		const slice = report[period];
		slice.turns.push(turn);

		const provider = slice.providers.get(turn.provider) ?? emptyProvider();
		applyTurn(provider, turn.sessionId, turn);

		const model = provider.models.get(turn.model) ?? emptyAggregate();
		applyTurn(model, turn.sessionId, turn);

		provider.models.set(turn.model, model);
		slice.providers.set(turn.provider, provider);

		applyTurn(slice.totals, turn.sessionId, turn);
	}
}

function placeTool(
	report: UsageReport,
	tool: RawToolUse,
	boundaries: PeriodBoundaries,
	toolRegistry: ToolRegistry,
): void {
	for (const period of periodsFor(tool.ts, boundaries)) {
		const slice = report[period];
		const groupName = groupForTool(tool.name, toolRegistry);
		const group = slice.toolGroups.get(groupName) ?? emptyToolGroup();
		applyTool(group, tool.sessionId, tool);

		const toolBucket = group.tools.get(tool.name) ?? emptyToolBucket();
		applyTool(toolBucket, tool.sessionId, tool);

		group.tools.set(tool.name, toolBucket);
		slice.toolGroups.set(groupName, group);
	}
}

async function buildReport(signal?: AbortSignal): Promise<UsageReport | null> {
	const boundaries = computeBoundaries();
	const toolRegistry = await buildToolRegistry(signal);
	if (signal?.aborted) return null;
	const report: UsageReport = {
		day: emptyPeriod(),
		week: emptyPeriod(),
		month: emptyPeriod(),
		all: emptyPeriod(),
		lifespans: new Map(),
		days: new Map(),
	};

	const roots = sessionRoots();
	const files = (
		await Promise.all(roots.map((root) => listSessionFiles(root, signal)))
	).flat();
	if (signal?.aborted) return null;

	const seen = new Set<string>();
	for (const file of files) {
		if (signal?.aborted) return null;
		const session = await parseSessionFile(file, seen, signal);
		if (!session) continue;
		for (const turn of session.turns) placeTurn(report, turn, boundaries);
		for (const tool of session.tools) placeTool(report, tool, boundaries, toolRegistry);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}

	const longSessions = new Set<string>();
	for (const [sessionId, span] of report.lifespans) {
		if (span.last - span.first >= LONG_SESSION_MS) longSessions.add(sessionId);
	}

	for (const period of PERIOD_ORDER) {
		report[period].insights = computeInsights(report[period], longSessions);
	}

	return report;
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

function computeInsights(slice: PeriodReport, longSessions: Set<string>): InsightRow[] {
	if (slice.turns.length === 0) return [];

	const total = slice.turns.reduce((acc, t) => acc + t.cost, 0);
	if (total <= 0) return [];

	const insights: InsightRow[] = [];

	const parallelCost = parallelCostShare(slice.turns);
	if (parallelCost !== null) {
		insights.push({
			weight: percent(parallelCost, total),
			headline: `Cost spent while ${PARALLEL_THRESHOLD}+ sessions overlapped`,
			hint:
				"Concurrent sessions all share one rate-limit bucket. Queueing them sequentially evens out throughput.",
		});
	}

	const heavyContextCost = sumWhere(
		slice.turns,
		(t) => t.input + t.cacheRead + t.cacheWrite > HEAVY_CONTEXT,
	);
	if (heavyContextCost > 0) {
		insights.push({
			weight: percent(heavyContextCost, total),
			headline: `Cost driven by turns over ${humanThreshold(HEAVY_CONTEXT)} of context`,
			hint: "Long-lived contexts stay expensive even when cached. /compact mid-task and /clear between tasks.",
		});
	}

	const uncachedCost = sumWhere(slice.turns, (t) => t.input + t.cacheWrite > HEAVY_UNCACHED);
	if (uncachedCost > 0) {
		insights.push({
			weight: percent(uncachedCost, total),
			headline: `Cost from large uncached prompts (>${humanThreshold(HEAVY_UNCACHED)} fresh tokens)`,
			hint: "Fresh prompt tokens skip the cache. Run /compact before stepping away to keep cold starts cheap.",
		});
	}

	const longCost = sumWhere(slice.turns, (t) => longSessions.has(t.sessionId));
	if (longCost > 0) {
		insights.push({
			weight: percent(longCost, total),
			headline: `Cost from sessions running ${LONG_SESSION_MS / 3_600_000}h+`,
			hint: "Often loops or background agents. Confirm the long-running session is doing intentional work.",
		});
	}

	const sessionCosts = bySession(slice.turns);
	if (sessionCosts.size > TOP_SESSIONS_PROBE) {
		const sorted = Array.from(sessionCosts.values()).sort((a, b) => b - a);
		const head = sorted.slice(0, TOP_SESSIONS_PROBE).reduce((acc, c) => acc + c, 0);
		insights.push({
			weight: percent(head, total),
			headline: `Cost concentrated in your top ${TOP_SESSIONS_PROBE} sessions`,
			hint: "A handful of sessions usually accounts for most spend. Use the Providers tab to drill in.",
		});
	}

	return insights
		.filter((row) => row.weight >= MIN_INSIGHT_PERCENT)
		.sort((a, b) => b.weight - a.weight);
}

function bySession(turns: RawTurn[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const t of turns) out.set(t.sessionId, (out.get(t.sessionId) ?? 0) + t.cost);
	return out;
}

function sumWhere(turns: RawTurn[], predicate: (t: RawTurn) => boolean): number {
	let sum = 0;
	for (const t of turns) if (predicate(t)) sum += t.cost;
	return sum;
}

function percent(part: number, whole: number): number {
	return whole > 0 ? (part / whole) * 100 : 0;
}

function parallelCostShare(turns: RawTurn[]): number | null {
	const timed = turns.filter((t) => t.ts > 0);
	if (timed.length < MIN_TURNS_FOR_PARALLEL) return null;

	const sessions = new Set(timed.map((t) => t.sessionId));
	if (sessions.size < PARALLEL_THRESHOLD) return null;

	const sorted = timed.slice().sort((a, b) => a.ts - b.ts);
	const counts = new Map<string, number>();
	let unique = 0;
	let head = 0;
	let tail = 0;
	let cost = 0;

	for (let i = 0; i < sorted.length; i++) {
		const probe = sorted[i]!;
		const upper = probe.ts + PARALLEL_RADIUS_MS;
		const lower = probe.ts - PARALLEL_RADIUS_MS;

		while (head < sorted.length && sorted[head]!.ts <= upper) {
			const sid = sorted[head]!.sessionId;
			const next = (counts.get(sid) ?? 0) + 1;
			counts.set(sid, next);
			if (next === 1) unique++;
			head++;
		}
		while (tail < head && sorted[tail]!.ts < lower) {
			const sid = sorted[tail]!.sessionId;
			const remaining = (counts.get(sid) ?? 0) - 1;
			if (remaining === 0) {
				counts.delete(sid);
				unique--;
			} else {
				counts.set(sid, remaining);
			}
			tail++;
		}

		if (unique >= PARALLEL_THRESHOLD) cost += probe.cost;
	}

	return cost;
}

// ---------------------------------------------------------------------------
// Impact equivalences
// ---------------------------------------------------------------------------

function chargedTokens(slice: PeriodReport): number {
	return slice.totals.tokens.input + slice.totals.tokens.output + slice.totals.tokens.cacheWrite;
}

function impactFor(slice: PeriodReport): AiEstimateResult | null {
	const tokens = chargedTokens(slice);
	if (tokens <= 0) return null;
	try {
		return estimateAiImpact({ tokens, maxEquivalents: 4 });
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Activity heatmap
// ---------------------------------------------------------------------------

interface Rgb {
	r: number;
	g: number;
	b: number;
}

/**
 * A monotonic intensity ramp: `levels[0]` is the empty-day swatch and each
 * subsequent entry is strictly brighter/more saturated than the last.
 */
interface HeatRamp {
	paint: (level: number, glyph: string) => string;
	glyph: (level: number) => string;
}

/** The 6x6x6 xterm cube channel values, mirroring pi's own 256-color mapping. */
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

/** Parses either a foreground (38) or background (48) SGR color sequence. */
function parseAnsiRgb(ansi: string): Rgb | null {
	const truecolor = ansi.match(/\x1b\[[34]8;2;(\d+);(\d+);(\d+)m/);
	if (truecolor) {
		return { r: Number(truecolor[1]), g: Number(truecolor[2]), b: Number(truecolor[3]) };
	}

	const indexed = ansi.match(/\x1b\[[34]8;5;(\d+)m/);
	if (!indexed) return null;
	const index = Number(indexed[1]);

	if (index >= 232 && index <= 255) {
		const gray = 8 + (index - 232) * 10;
		return { r: gray, g: gray, b: gray };
	}
	if (index >= 16 && index <= 231) {
		const offset = index - 16;
		return {
			r: CUBE_VALUES[Math.floor(offset / 36)]!,
			g: CUBE_VALUES[Math.floor((offset % 36) / 6)]!,
			b: CUBE_VALUES[offset % 6]!,
		};
	}
	return null;
}

function relativeLuminance({ r, g, b }: Rgb): number {
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function mix(from: Rgb, to: Rgb, t: number): Rgb {
	return {
		r: Math.round(from.r + (to.r - from.r) * t),
		g: Math.round(from.g + (to.g - from.g) * t),
		b: Math.round(from.b + (to.b - from.b) * t),
	};
}

function rgbToAnsi({ r, g, b }: Rgb, mode: "truecolor" | "256color"): string {
	if (mode === "truecolor") return `\x1b[38;2;${r};${g};${b}m`;
	const idx = (v: number) => {
		let best = 0;
		for (let i = 1; i < CUBE_VALUES.length; i++) {
			if (Math.abs(v - CUBE_VALUES[i]!) < Math.abs(v - CUBE_VALUES[best]!)) best = i;
		}
		return best;
	};
	return `\x1b[38;5;${16 + 36 * idx(r) + 6 * idx(g) + idx(b)}m`;
}

/**
 * Contrast tuning for the heatmap ramp.
 *
 * `LUMA_SPAN` sets how far the hot end is pushed away from the background,
 * `COLD_MIX` how close the empty-day swatch sits to it, and `RAMP_START` where
 * the first active tier begins. Lowering `RAMP_START` is what spreads the four
 * active tiers apart — widening the span alone leaves them bunched near the hot
 * end, close to the ~1.2 just-noticeable contrast ratio.
 */
const HEAT_MIN_LUMA_SPAN = 0.62;
const HEAT_COLD_MIX = 0.06;
const HEAT_RAMP_START = 0.16;

/**
 * Builds the heatmap intensity ramp.
 *
 * Theme roles like `muted` / `dim` / `border` are *semantic*, not ordered by
 * brightness — a theme may legitimately map `muted` to yellow — so using them
 * as gradient stops produces hue jumps and duplicate steps. Instead the ramp is
 * derived from a single hue (`accent`) swept away from the actual background,
 * which reads as "less → more" in any theme.
 *
 * Two things can still flatten the ramp, so both are checked and repaired:
 *   1. An accent whose luminance sits close to the background (many light
 *      themes), which is fixed by extending the hot end away from the bg.
 *   2. 256-color quantization collapsing neighbouring steps onto one index,
 *      which is fixed by falling back to density glyphs.
 */
function buildHeatRamp(theme: Theme): HeatRamp {
	const densityFallback: HeatRamp = {
		paint: (level, glyph) => theme.fg(level === 0 ? "border" : "accent", glyph),
		glyph: (level) => HEAT_DENSITY_GLYPHS[Math.min(level, HEAT_LEVELS - 1)]!,
	};

	const accent = parseAnsiRgb(theme.getFgAnsi("accent"));
	if (!accent) return densityFallback;

	// Anchor the cold end on the real panel background so empty days recede
	// into it instead of floating on an arbitrary dark tint.
	const background = parseAnsiRgb(theme.getBgAnsi("selectedBg")) ??
		parseAnsiRgb(theme.getFgAnsi("border")) ?? { r: 0, g: 0, b: 0 };
	const bgLuma = relativeLuminance(background);

	// Sweep the accent away from the background: darker bg -> brighten toward
	// white, lighter bg -> deepen toward black.
	const away = bgLuma > 0.5 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
	let hot = accent;
	if (Math.abs(relativeLuminance(accent) - bgLuma) < HEAT_MIN_LUMA_SPAN) {
		// Accent is too close to the background to carry a gradient on its own.
		for (let push = 0.05; push <= 0.95; push += 0.05) {
			hot = mix(accent, away, push);
			if (Math.abs(relativeLuminance(hot) - bgLuma) >= HEAT_MIN_LUMA_SPAN) break;
		}
	}

	const cold = mix(background, hot, HEAT_COLD_MIX);
	const mode = theme.getColorMode();
	const ansi: string[] = [];
	for (let level = 0; level < HEAT_LEVELS; level++) {
		const t =
			level === 0
				? 0
				: HEAT_RAMP_START + (1 - HEAT_RAMP_START) * ((level - 1) / (HEAT_TIERS - 1));
		ansi.push(rgbToAnsi(mix(cold, hot, t), mode));
	}

	// 256-color mode may quantize distinct RGB steps onto the same index. If
	// any two stops collapse, glyph density carries the gradient instead.
	if (new Set(ansi).size !== ansi.length) return densityFallback;

	return {
		paint: (level, glyph) => `${ansi[Math.min(level, HEAT_LEVELS - 1)]}${glyph}\x1b[39m`,
		glyph: () => HEAT_CELL,
	};
}

interface HeatCell {
	ts: number;
	value: number;
	/** Beyond today — rendered as empty padding. */
	future: boolean;
}

interface HeatGrid {
	/** Column-major: weeks[w][row] where row 0 = Monday. */
	weeks: HeatCell[][];
	max: number;
	/** Ascending value cut-offs; index i is the lower bound of level i+1. */
	thresholds: number[];
}

interface ActivityStats {
	total: number;
	peak: { key: string; value: number } | null;
	currentStreak: number;
	longestStreak: number;
}

function metricValue(bucket: DayBucket, metric: Metric): number {
	return metric === "tokens" ? bucket.tokens : bucket.cost;
}

/**
 * Builds a GitHub-style contribution grid ending on today, Monday-first,
 * spanning `weeks` columns.
 */
function buildHeatGrid(
	days: Map<string, DayBucket>,
	weeks: number,
	metric: Metric,
	now = new Date(),
): HeatGrid {
	const today = startOfDay(now.getTime());
	// Monday of the current week.
	const dow = new Date(today).getDay();
	const offsetToMonday = dow === 0 ? 6 : dow - 1;
	const lastMonday = today - offsetToMonday * DAY_MS;
	const firstMonday = lastMonday - (weeks - 1) * 7 * DAY_MS;

	const grid: HeatCell[][] = [];
	const active: number[] = [];
	let max = 0;

	for (let w = 0; w < weeks; w++) {
		const column: HeatCell[] = [];
		for (let row = 0; row < HEAT_ROWS; row++) {
			const ts = firstMonday + (w * 7 + row) * DAY_MS;
			const key = dayKey(ts);
			const bucket = days.get(key);
			const value = bucket ? metricValue(bucket, metric) : 0;
			if (value > max) max = value;
			if (value > 0 && ts <= today) active.push(value);
			column.push({ ts, value, future: ts > today });
		}
		grid.push(column);
	}

	return { weeks: grid, max, thresholds: quantileThresholds(active) };
}

/**
 * Splits active days into evenly-populated intensity tiers (like GitHub does),
 * so a few outlier days can't wash out the rest of the grid.
 */
function quantileThresholds(values: number[]): number[] {
	const tiers = HEAT_TIERS;
	if (values.length === 0) return [];
	const sorted = values.slice().sort((a, b) => a - b);
	const cuts: number[] = [];
	for (let i = 1; i < tiers; i++) {
		const index = Math.floor((sorted.length * i) / tiers);
		cuts.push(sorted[Math.min(index, sorted.length - 1)]!);
	}
	return cuts;
}

function heatLevel(value: number, thresholds: number[]): number {
	if (value <= 0) return 0;
	let level = 1;
	for (const cut of thresholds) {
		if (value >= cut) level++;
	}
	return Math.min(HEAT_LEVELS - 1, level);
}

function computeActivityStats(days: Map<string, DayBucket>, metric: Metric, now = new Date()): ActivityStats {
	let total = 0;
	let peak: { key: string; value: number } | null = null;

	for (const [key, bucket] of days) {
		const value = metricValue(bucket, metric);
		total += value;
		if (value > 0 && (!peak || value > peak.value)) peak = { key, value };
	}

	const active = new Set(
		[...days.entries()].filter(([, b]) => metricValue(b, metric) > 0).map(([key]) => key),
	);

	const today = startOfDay(now.getTime());
	let currentStreak = 0;
	// A streak stays alive if you worked today or yesterday.
	let cursor = active.has(dayKey(today)) ? today : today - DAY_MS;
	while (active.has(dayKey(cursor))) {
		currentStreak++;
		cursor -= DAY_MS;
	}

	let longestStreak = 0;
	let run = 0;
	const sorted = [...active].sort();
	let previous = 0;
	for (const key of sorted) {
		const ts = startOfDay(Date.parse(`${key}T00:00:00`));
		run = previous > 0 && ts - previous === DAY_MS ? run + 1 : 1;
		if (run > longestStreak) longestStreak = run;
		previous = ts;
	}

	return { total, peak, currentStreak, longestStreak };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
	if (n <= 0) return "—";
	if (n < 1_000) return String(n);
	if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

function formatCost(value: number): string {
	if (value <= 0) return "—";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	if (value < 1) return `$${value.toFixed(2)}`;
	if (value < 100) return `$${value.toFixed(2)}`;
	return `$${Math.round(value)}`;
}

function formatCount(n: number): string {
	if (n <= 0) return "—";
	return n.toLocaleString();
}

function formatPercent(p: number): string {
	if (p >= 10) return `${Math.round(p)}%`;
	return `${(Math.round(p * 10) / 10).toFixed(1)}%`;
}

function formatDate(date: Date): string {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	}).format(date);
}

function dateRangeForPeriod(period: Period, report: UsageReport, now = new Date()): [Date, Date] {
	const boundaries = computeBoundaries(now);
	switch (period) {
		case "day":
			return [new Date(boundaries.dayStart), now];
		case "week":
			return [new Date(boundaries.weekStart), now];
		case "month":
			return [new Date(boundaries.monthStart), now];
		case "all": {
			let first = Number.POSITIVE_INFINITY;
			let last = 0;
			for (const span of report.lifespans.values()) {
				if (span.first > 0 && span.first < first) first = span.first;
				if (span.last > last) last = span.last;
			}
			return Number.isFinite(first) ? [new Date(first), new Date(last)] : [now, now];
		}
	}
}

function humanThreshold(n: number): string {
	if (n >= 1_000_000) return `${n / 1_000_000}M`;
	if (n >= 1_000) return `${n / 1_000}k`;
	return String(n);
}

function padTo(text: string, width: number, side: "left" | "right" = "right"): string {
	if (width <= 0) return "";
	const truncated = truncateToWidth(text, width);
	const visible = visibleWidth(truncated);
	if (visible >= width) return truncated;
	const pad = " ".repeat(width - visible);
	return side === "left" ? pad + truncated : truncated + pad;
}

function clipLines(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, Math.max(width, 0)));
}

function pickFitting(width: number, options: string[]): string {
	for (const option of options) {
		if (visibleWidth(option) <= width) return option;
	}
	return options[options.length - 1] ?? "";
}

function randomItem<T>(items: readonly T[]): T | undefined {
	if (items.length === 0) return undefined;
	return items[Math.floor(Math.random() * items.length)];
}

// ---------------------------------------------------------------------------
// Table layout
// ---------------------------------------------------------------------------

interface TableColumn {
	label: string;
	width: number;
	dim?: boolean;
	value: (row: Aggregate) => string;
}

interface ToolColumn {
	label: string;
	width: number;
	value: (row: ToolBucket) => string;
}

const COL_SESSIONS: TableColumn = {
	label: "Sess",
	width: 7,
	value: (r) => formatCount(r.sessions.size),
};
const COL_CALLS: TableColumn = { label: "Calls", width: 8, value: (r) => formatCount(r.calls) };
const COL_COST: TableColumn = { label: "Cost", width: 9, value: (r) => formatCost(r.cost) };
const COL_TOKENS: TableColumn = {
	label: "Tokens",
	width: 9,
	value: (r) => formatTokens(r.tokens.input + r.tokens.output + r.tokens.cacheWrite),
};
const COL_INPUT: TableColumn = {
	label: "↑ In",
	width: 8,
	dim: true,
	value: (r) => formatTokens(r.tokens.input + r.tokens.cacheWrite),
};
const COL_OUTPUT: TableColumn = {
	label: "↓ Out",
	width: 8,
	dim: true,
	value: (r) => formatTokens(r.tokens.output),
};
const COL_CACHE: TableColumn = {
	label: "Cache",
	width: 8,
	dim: true,
	value: (r) => formatTokens(r.tokens.cacheRead + r.tokens.cacheWrite),
};

interface LayoutCandidate {
	columns: TableColumn[];
	minName: number;
	compact?: boolean;
}

const LAYOUTS: readonly LayoutCandidate[] = [
	{
		columns: [COL_SESSIONS, COL_CALLS, COL_COST, COL_TOKENS, COL_INPUT, COL_OUTPUT, COL_CACHE],
		minName: NAME_COL_MIN_FULL,
	},
	{ columns: [COL_SESSIONS, COL_CALLS, COL_COST, COL_TOKENS], minName: 14, compact: true },
	{ columns: [COL_SESSIONS, COL_COST, COL_TOKENS], minName: 12, compact: true },
	{ columns: [COL_COST, COL_TOKENS], minName: 10, compact: true },
	{ columns: [COL_COST], minName: 8, compact: true },
];

interface TableLayout {
	columns: TableColumn[];
	nameWidth: number;
	totalWidth: number;
	compact: boolean;
}

function toolColumns(): ToolColumn[] {
	return [
		{ label: "Calls", width: 8, value: (r) => formatCount(r.calls) },
		{ label: "Result", width: 9, value: (r) => formatTokens(r.resultTokens) },
		{ label: "Sess", width: 7, value: (r) => formatCount(r.sessions.size) },
	];
}

function pickLayout(width: number): TableLayout {
	const safe = Math.max(width, 0);
	const choose = (candidate: LayoutCandidate): TableLayout => {
		const colSum = candidate.columns.reduce((acc, c) => acc + c.width, 0);
		const nameWidth = Math.min(NAME_COL_MAX, Math.max(safe - colSum, 0));
		return {
			columns: candidate.columns,
			nameWidth,
			totalWidth: nameWidth + colSum,
			compact: candidate.compact ?? false,
		};
	};

	for (const candidate of LAYOUTS) {
		const layout = choose(candidate);
		if (layout.nameWidth >= candidate.minName) return layout;
	}
	return choose(LAYOUTS[LAYOUTS.length - 1]!);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

class UsagePanel {
	private period: Period = "all";
	private view: View = "summary";
	private metric: Metric = "tokens";
	private cursor = 0;
	private expanded = new Set<string>();
	private providerOrder: string[] = [];
	private toolGroupOrder: string[] = [];
	private impactCache = new Map<Period, AiEstimateResult | null>();
	private ramp: HeatRamp | null = null;

	constructor(
		private readonly theme: Theme,
		private readonly report: UsageReport,
		private readonly requestRender: () => void,
		private readonly close: () => void,
	) {
		this.refreshProviderOrder();
		this.refreshToolGroupOrder();
	}

	handleInput(input: string): void {
		if (matchesKey(input, "escape") || matchesKey(input, "q")) {
			this.close();
			return;
		}

		if (matchesKey(input, "tab") || matchesKey(input, "right")) {
			this.shiftPeriod(1);
			return;
		}
		if (matchesKey(input, "shift+tab") || matchesKey(input, "left")) {
			this.shiftPeriod(-1);
			return;
		}
		if (matchesKey(input, "v")) {
			this.shiftView(1);
			return;
		}
		if (input === "1") return this.gotoView("summary");
		if (input === "2") return this.gotoView("providers");
		if (input === "3") return this.gotoView("patterns");
		if (input === "4") return this.gotoView("tools");
		if (input === "5") return this.gotoView("activity");

		if (this.view === "activity" && matchesKey(input, "m")) {
			this.metric = this.metric === "tokens" ? "cost" : "tokens";
			this.requestRender();
			return;
		}

		if (this.view !== "providers" && this.view !== "tools") return;

		const order = this.view === "providers" ? this.providerOrder : this.toolGroupOrder;

		if (matchesKey(input, "up") && this.cursor > 0) {
			this.cursor--;
			this.requestRender();
		} else if (matchesKey(input, "down") && this.cursor < order.length - 1) {
			this.cursor++;
			this.requestRender();
		} else if (matchesKey(input, "enter") || matchesKey(input, "space")) {
			const expandable = order[this.cursor];
			if (expandable) {
				if (this.expanded.has(expandable)) this.expanded.delete(expandable);
				else this.expanded.add(expandable);
				this.requestRender();
			}
		}
	}

	render(width: number): string[] {
		const head = this.renderHeader(width);
		switch (this.view) {
			case "summary":
				return clipLines([...head, ...this.renderSummary(width)], width);
			case "providers": {
				const layout = pickLayout(width);
				return clipLines([...head, ...this.renderProviders(layout)], width);
			}
			case "patterns":
				return clipLines([...head, ...this.renderPatterns(width)], width);
			case "tools": {
				const layout = pickLayout(width);
				return clipLines([...head, ...this.renderTools(layout)], width);
			}
			case "activity":
				return clipLines([...head, ...this.renderActivity(width)], width);
		}
	}

	invalidate(): void {}
	dispose(): void {}

	// ----- helpers ----------------------------------------------------------

	private refreshProviderOrder(): void {
		const slice = this.report[this.period];
		this.providerOrder = Array.from(slice.providers.entries())
			.sort((a, b) => b[1].cost - a[1].cost)
			.map(([name]) => name);
		this.cursor = Math.min(this.cursor, Math.max(0, this.providerOrder.length - 1));
	}

	private refreshToolGroupOrder(): void {
		const slice = this.report[this.period];
		this.toolGroupOrder = Array.from(slice.toolGroups.entries())
			.sort((a, b) => b[1].calls - a[1].calls || b[1].resultTokens - a[1].resultTokens)
			.map(([name]) => name);
		this.cursor = Math.min(this.cursor, Math.max(0, this.toolGroupOrder.length - 1));
	}

	private shiftPeriod(direction: 1 | -1): void {
		const idx = PERIOD_ORDER.indexOf(this.period);
		const next = (idx + direction + PERIOD_ORDER.length) % PERIOD_ORDER.length;
		this.period = PERIOD_ORDER[next]!;
		this.refreshProviderOrder();
		this.refreshToolGroupOrder();
		this.requestRender();
	}

	private shiftView(direction: 1 | -1): void {
		const idx = VIEW_ORDER.indexOf(this.view);
		const next = (idx + direction + VIEW_ORDER.length) % VIEW_ORDER.length;
		this.view = VIEW_ORDER[next]!;
		this.cursor = 0;
		this.requestRender();
	}

	private gotoView(view: View): void {
		if (this.view === view) return;
		this.view = view;
		this.cursor = 0;
		this.requestRender();
	}

	private getRamp(): HeatRamp {
		if (!this.ramp) this.ramp = buildHeatRamp(this.theme);
		return this.ramp;
	}

	private getImpact(): AiEstimateResult | null {
		if (!this.impactCache.has(this.period)) {
			this.impactCache.set(this.period, impactFor(this.report[this.period]));
		}
		return this.impactCache.get(this.period) ?? null;
	}

	// ----- shared renders ---------------------------------------------------

	private renderHeader(width: number): string[] {
		const th = this.theme;
		const title = th.fg("accent", th.bold("Pi Usage"));
		const tabs = this.renderViewTabs();
		// Activity always spans all history, so the period selector is irrelevant.
		if (this.view === "activity") return [title, "", tabs, ""];
		const periods = this.renderPeriodTabs(width);
		const dateRange = th.fg("dim", this.renderPeriodDateRange());
		return [title, "", periods, tabs, dateRange, ""];
	}

	private renderViewTabs(): string {
		const th = this.theme;
		return VIEW_ORDER.map((view) => {
			const label = `${VIEW_ORDER.indexOf(view) + 1}. ${VIEW_LABELS[view]}`;
			return view === this.view ? th.fg("accent", `[${label}]`) : th.fg("dim", ` ${label} `);
		}).join("  ");
	}

	private renderPeriodTabs(width: number): string {
		const th = this.theme;
		const full = PERIOD_ORDER.map((period) => {
			const label = PERIOD_LABELS[period];
			return period === this.period ? th.fg("accent", `‹${label}›`) : th.fg("dim", ` ${label} `);
		}).join("  ");

		const fallback = th.fg("accent", `‹${PERIOD_LABELS[this.period]}›`);
		return pickFitting(width, [full, `${fallback}  ${th.fg("dim", "[Tab/←→]")}`, fallback]);
	}

	private renderPeriodDateRange(): string {
		const [from, to] = dateRangeForPeriod(this.period, this.report);
		return `From ${formatDate(from)} to ${formatDate(to)}`;
	}

	// ----- summary view -----------------------------------------------------

	private renderSummary(width: number): string[] {
		const th = this.theme;
		const slice = this.report[this.period];
		const lines: string[] = [];

		if (slice.totals.calls === 0) {
			lines.push(th.fg("dim", "  No assistant turns recorded for this period."));
			lines.push("");
			lines.push(...this.renderHelp(width));
			return lines;
		}

		lines.push(th.bold("Totals"));
		lines.push("");
		lines.push(...this.renderTotalsBlock(slice));
		lines.push("");

		if (this.providerOrder.length > 0) {
			lines.push(th.bold("Top providers"));
			lines.push("");
			lines.push(...this.renderTopProviders(slice, width));
			lines.push("");
		}

		lines.push(th.bold("Sustainability"));
		lines.push(th.fg("dim", "AI estimates are approximate inference ranges using impact-equivalences."));
		lines.push("");
		lines.push(...this.renderImpactBlock(width));
		lines.push("");
		lines.push(...this.renderHelp(width));
		return lines;
	}

	private renderTotalsBlock(slice: PeriodReport): string[] {
		const th = this.theme;
		const tokens = chargedTokens(slice);
		const fields: Array<[string, string]> = [
			["Sessions", formatCount(slice.totals.sessions.size)],
			["Calls", formatCount(slice.totals.calls)],
			["Spend", formatCost(slice.totals.cost)],
			["Tokens", formatTokens(tokens)],
			["Cache hit", formatTokens(slice.totals.tokens.cacheRead)],
		];
		return fields.map(
			([label, value]) =>
				`  ${th.fg("dim", padTo(label, 10, "right"))}  ${th.bold(value)}`,
		);
	}

	private renderTopProviders(slice: PeriodReport, width: number): string[] {
		const th = this.theme;
		const top = this.providerOrder.slice(0, SUMMARY_TOP_PROVIDERS);
		const total = slice.totals.cost > 0 ? slice.totals.cost : 1;
		const labelWidth = Math.min(
			18,
			Math.max(...top.map((name) => Math.min(visibleWidth(name), 18))),
		);
		const lines: string[] = [];

		for (const name of top) {
			const provider = slice.providers.get(name);
			if (!provider) continue;
			const ratio = Math.min(1, Math.max(0, provider.cost / total));
			const filled = Math.round(BAR_WIDTH * ratio);
			const bar = `${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(BAR_WIDTH - filled)}`;
			const cost = formatCost(provider.cost);
			const tokens = formatTokens(
				provider.tokens.input + provider.tokens.output + provider.tokens.cacheWrite,
			);
			const lhs = `  ${padTo(name, labelWidth)}`;
			const rhs = `${th.fg("accent", bar)}  ${formatPercent(ratio * 100)} · ${cost} · ${tokens} tokens`;
			lines.push(truncateToWidth(`${lhs}  ${rhs}`, Math.max(width, 0)));
		}

		return lines;
	}

	private renderImpactBlock(width: number): string[] {
		const th = this.theme;
		const impact = this.getImpact();
		if (!impact) {
			return [th.fg("dim", "  Not enough token data to estimate environmental impact.")];
		}

		const indent = "  ";
		const electricity = impact.electricity.kwh;
		const carbon = impact.carbon.kgCO2e;
		const lines: string[] = [];

		const profileNote = `${impact.profile.label} · ${impact.region.label}`;
		lines.push(`${indent}${th.fg("dim", profileNote)}`);

		lines.push(
			`${indent}${th.fg("dim", padTo("Electricity", 12, "right"))}  ${th.bold(formatRange(electricity.min, electricity.typical, electricity.max, "kWh"))}`,
		);
		lines.push(
			`${indent}${th.fg("dim", padTo("Carbon", 12, "right"))}  ${th.bold(formatRange(carbon.min, carbon.typical, carbon.max, "kg CO₂e"))}`,
		);

		const equivalent = randomItem(impact.equivalents);
		if (equivalent) {
			lines.push("");
			const wrapped = wrapTextWithAnsi(
				th.fg("dim", `Roughly equivalent to ${equivalent}`),
				Math.max(20, width - indent.length),
			);
			for (const part of wrapped) lines.push(`${indent}${part}`);
		}

		return lines;
	}

	// ----- providers view ---------------------------------------------------

	private renderProviders(layout: TableLayout): string[] {
		const lines: string[] = [];
		lines.push(...this.renderTableHeader(layout));

		const slice = this.report[this.period];
		if (this.providerOrder.length === 0) {
			lines.push(this.theme.fg("dim", "  No usage data for this period"));
		} else {
			for (let i = 0; i < this.providerOrder.length; i++) {
				const name = this.providerOrder[i]!;
				const provider = slice.providers.get(name)!;
				const isSelected = i === this.cursor;
				const isExpanded = this.expanded.has(name);
				lines.push(this.renderProviderRow(name, provider, layout, isSelected, isExpanded));

				if (isExpanded) {
					const models = Array.from(provider.models.entries()).sort(
						(a, b) => b[1].cost - a[1].cost,
					);
					for (const [modelName, modelStats] of models) {
						lines.push(this.renderModelRow(modelName, modelStats, layout));
					}
				}
			}
		}

		lines.push(...this.renderTableFooter(slice, layout));
		lines.push(...this.renderHelp(layout.totalWidth));
		return lines;
	}

	private renderTableHeader(layout: TableLayout): string[] {
		const th = this.theme;
		let header = padTo("Provider / Model", layout.nameWidth);
		for (const col of layout.columns) {
			const cell = padTo(col.label, col.width, "left");
			header += col.dim ? th.fg("dim", cell) : cell;
		}
		return [
			th.fg("muted", header),
			th.fg("border", "─".repeat(layout.totalWidth)),
		];
	}

	private renderProviderRow(
		name: string,
		stats: ProviderBucket,
		layout: TableLayout,
		selected: boolean,
		expanded: boolean,
	): string {
		const th = this.theme;
		const arrow = expanded ? "▾" : "▸";
		const prefix = selected ? th.fg("accent", `${arrow} `) : th.fg("dim", `${arrow} `);
		const innerWidth = Math.max(layout.nameWidth - 2, 0);
		const display = innerWidth > 0 ? truncateToWidth(name, innerWidth) : "";
		const styled = selected ? th.fg("accent", display) : display;
		let row = prefix + padTo(styled, innerWidth);

		for (const col of layout.columns) {
			const cell = padTo(col.value(stats), col.width, "left");
			row += col.dim ? th.fg("dim", cell) : cell;
		}
		return row;
	}

	private renderModelRow(name: string, stats: ModelBucket, layout: TableLayout): string {
		const th = this.theme;
		const indent = "    ";
		const innerWidth = Math.max(layout.nameWidth - indent.length, 0);
		const display = innerWidth > 0 ? truncateToWidth(name, innerWidth) : "";
		let row = indent + padTo(th.fg("dim", display), innerWidth);
		for (const col of layout.columns) {
			row += th.fg("dim", padTo(col.value(stats), col.width, "left"));
		}
		return row;
	}

	private renderTableFooter(slice: PeriodReport, layout: TableLayout): string[] {
		const th = this.theme;
		let row = padTo(th.bold("Total"), layout.nameWidth);
		for (const col of layout.columns) {
			const cell = padTo(col.value(slice.totals), col.width, "left");
			row += col.dim ? th.fg("dim", cell) : cell;
		}
		return [th.fg("border", "─".repeat(layout.totalWidth)), row, ""];
	}

	// ----- tools view --------------------------------------------------------

	private renderTools(layout: TableLayout): string[] {
		const th = this.theme;
		const slice = this.report[this.period];
		const lines: string[] = [];
		const columns = toolColumns();
		const totalWidth = layout.nameWidth + columns.reduce((acc, col) => acc + col.width, 0);

		lines.push(th.bold("Extensions / tools"));
		lines.push(th.fg("dim", "Sorted by call count. Result tokens are estimated from tool output size."));
		lines.push("");
		lines.push(this.renderToolHeader(layout.nameWidth, columns));
		lines.push(th.fg("border", "─".repeat(totalWidth)));

		if (this.toolGroupOrder.length === 0) {
			lines.push(th.fg("dim", "  No tool usage recorded for this period."));
		} else {
			for (let i = 0; i < this.toolGroupOrder.length; i++) {
				const name = this.toolGroupOrder[i]!;
				const group = slice.toolGroups.get(name)!;
				const isSelected = i === this.cursor;
				const isExpanded = this.expanded.has(name);
				lines.push(this.renderToolGroupRow(name, group, layout.nameWidth, columns, isSelected, isExpanded));

				if (isExpanded) {
					const tools = Array.from(group.tools.entries()).sort(
						(a, b) => b[1].calls - a[1].calls || b[1].resultTokens - a[1].resultTokens,
					);
					for (const [toolName, stats] of tools) {
						lines.push(this.renderToolRow(toolName, stats, layout.nameWidth, columns));
					}
				}
			}
		}

		lines.push(th.fg("border", "─".repeat(totalWidth)));
		lines.push(this.renderToolTotalRow(slice, layout.nameWidth, columns));
		lines.push("");
		lines.push(...this.renderHelp(totalWidth));
		return lines;
	}

	private renderToolHeader(nameWidth: number, columns: ToolColumn[]): string {
		const th = this.theme;
		let header = padTo("Extension / Tool", nameWidth);
		for (const col of columns) header += th.fg("dim", padTo(col.label, col.width, "left"));
		return th.fg("muted", header);
	}

	private renderToolGroupRow(
		name: string,
		stats: ToolGroupBucket,
		nameWidth: number,
		columns: ToolColumn[],
		selected: boolean,
		expanded: boolean,
	): string {
		const th = this.theme;
		const arrow = expanded ? "▾" : "▸";
		const prefix = selected ? th.fg("accent", `${arrow} `) : th.fg("dim", `${arrow} `);
		const innerWidth = Math.max(nameWidth - 2, 0);
		const display = innerWidth > 0 ? truncateToWidth(name, innerWidth) : "";
		const styled = selected ? th.fg("accent", display) : display;
		return prefix + padTo(styled, innerWidth) + columns.map((col) => padTo(col.value(stats), col.width, "left")).join("");
	}

	private renderToolRow(
		name: string,
		stats: ToolBucket,
		nameWidth: number,
		columns: ToolColumn[],
	): string {
		const th = this.theme;
		const indent = "    ";
		const innerWidth = Math.max(nameWidth - indent.length, 0);
		const display = innerWidth > 0 ? truncateToWidth(name, innerWidth) : "";
		return indent + padTo(th.fg("dim", display), innerWidth) + columns.map((col) => th.fg("dim", padTo(col.value(stats), col.width, "left"))).join("");
	}

	private renderToolTotalRow(slice: PeriodReport, nameWidth: number, columns: ToolColumn[]): string {
		const total = emptyToolBucket();
		for (const group of slice.toolGroups.values()) {
			total.calls += group.calls;
			total.resultTokens += group.resultTokens;
			for (const sessionId of group.sessions) total.sessions.add(sessionId);
		}
		return padTo(this.theme.bold("Total"), nameWidth) + columns.map((col) => padTo(col.value(total), col.width, "left")).join("");
	}

	// ----- activity view -----------------------------------------------------

	private renderActivity(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const indent = "  ";

		const weeks = this.heatWeeksFor(width);
		if (weeks < HEAT_MIN_WEEKS) {
			lines.push(th.fg("dim", `${indent}Terminal too narrow for the activity heatmap.`));
			lines.push("");
			lines.push(...this.renderHelp(width));
			return lines;
		}

		const grid = buildHeatGrid(this.report.days, weeks, this.metric);
		const stats = computeActivityStats(this.report.days, this.metric);

		const metricLabel = this.metric === "tokens" ? "tokens" : "cost";
		lines.push(th.bold("Activity"));
		lines.push(
			th.fg(
				"dim",
				`Daily ${metricLabel} over the last ${weeks} weeks. Press [m] to switch metric.`,
			),
		);
		lines.push("");
		lines.push(...this.renderHeatGrid(grid, indent));
		lines.push("");
		lines.push(...this.renderHeatLegend(indent));
		lines.push("");
		lines.push(...this.renderActivityStats(stats, width, indent));
		lines.push("");
		lines.push(...this.renderHelp(width));
		return lines;
	}

	private heatWeeksFor(width: number): number {
		const available = width - HEAT_ROW_LABEL_WIDTH - 2 /* indent */;
		const fits = Math.floor(available / HEAT_CELL_WIDTH);
		return Math.max(0, Math.min(HEAT_MAX_WEEKS, fits));
	}

	private heatCell(cell: HeatCell, thresholds: number[]): string {
		if (cell.future) return " ".repeat(HEAT_CELL_WIDTH);
		const level = heatLevel(cell.value, thresholds);
		const ramp = this.getRamp();
		return ramp.paint(level, ramp.glyph(level)) + HEAT_CELL_GAP;
	}

	private renderHeatGrid(grid: HeatGrid, indent: string): string[] {
		const th = this.theme;
		const lines: string[] = [th.fg("dim", indent + this.renderMonthAxis(grid).trimEnd())];

		for (let row = 0; row < HEAT_ROWS; row++) {
			const label = th.fg("dim", padTo(HEAT_ROW_LABELS[row] ?? "", HEAT_ROW_LABEL_WIDTH));
			let line = indent + label;
			for (const column of grid.weeks) line += this.heatCell(column[row]!, grid.thresholds);
			lines.push(line);
		}

		return lines;
	}

	private renderMonthAxis(grid: HeatGrid): string {
		const slots = new Array<string>(HEAT_ROW_LABEL_WIDTH + grid.weeks.length * HEAT_CELL_WIDTH).fill(" ");
		let lastMonth = -1;
		let nextFree = HEAT_ROW_LABEL_WIDTH;

		grid.weeks.forEach((column, index) => {
			const month = new Date(column[0]!.ts).getMonth();
			if (month === lastMonth) return;
			lastMonth = month;

			const label = MONTH_LABELS[month]!;
			const start = HEAT_ROW_LABEL_WIDTH + index * HEAT_CELL_WIDTH;
			// Skip labels that would collide with the previous one or overflow.
			if (start < nextFree || start + label.length > slots.length) return;
			for (let i = 0; i < label.length; i++) slots[start + i] = label[i]!;
			nextFree = start + label.length + 1;
		});

		return slots.join("");
	}

	private renderHeatLegend(indent: string): string[] {
		const th = this.theme;
		const ramp = this.getRamp();
		let swatches = "";
		for (let level = 0; level < HEAT_LEVELS; level++) {
			swatches += ramp.paint(level, ramp.glyph(level)) + HEAT_CELL_GAP;
		}
		return [
			`${indent}${" ".repeat(HEAT_ROW_LABEL_WIDTH)}${th.fg("dim", "Less ")}${swatches}${th.fg("dim", "More")}`,
		];
	}

	private renderActivityStats(stats: ActivityStats, width: number, indent: string): string[] {
		const th = this.theme;
		const format = this.metric === "tokens" ? formatTokens : formatCost;
		const metricWord = this.metric === "tokens" ? "tokens" : "spend";
		const cells: Array<[string, string]> = [
			[format(stats.total), `lifetime ${metricWord}`],
			[stats.peak ? format(stats.peak.value) : "—", "peak day"],
			[`${stats.currentStreak} ${stats.currentStreak === 1 ? "day" : "days"}`, "current streak"],
			[`${stats.longestStreak} ${stats.longestStreak === 1 ? "day" : "days"}`, "longest streak"],
		];

		const cellWidth = Math.max(...cells.map(([v, l]) => Math.max(visibleWidth(v), visibleWidth(l)))) + 3;
		const inline = indent.length + cells.length * cellWidth <= width;

		if (!inline) {
			return cells.map(
				([value, label]) => `${indent}${th.bold(padTo(value, 12))}${th.fg("dim", label)}`,
			);
		}

		const values = cells.map(([value]) => padTo(th.bold(value), cellWidth)).join("");
		const labels = cells.map(([, label]) => padTo(th.fg("dim", label), cellWidth)).join("");
		return [indent + values, indent + labels];
	}

	// ----- patterns view ----------------------------------------------------

	private renderPatterns(width: number): string[] {
		const th = this.theme;
		const slice = this.report[this.period];
		const lines: string[] = [];

		lines.push(th.bold("Where the spend goes"));
		lines.push(th.fg("dim", "Weighted by USD cost. Categories overlap and can total over 100%."));
		lines.push("");

		if (slice.totals.calls === 0) {
			lines.push(th.fg("dim", "  No usage recorded for this period."));
		} else if (slice.totals.cost <= 0) {
			lines.push(th.fg("dim", "  No cost figures recorded for this period."));
		} else if (slice.insights.length === 0) {
			lines.push(th.fg("dim", "  No notable patterns above 1%."));
		} else {
			const indent = "    ";
			const bodyWidth = Math.max(width - indent.length, 30);
			for (const row of slice.insights) {
				const pct = th.fg("accent", th.bold(formatPercent(row.weight)));
				lines.push(`  ${pct}  ${row.headline}`);
				for (const wrapped of wrapTextWithAnsi(row.hint, bodyWidth)) {
					lines.push(`${indent}${th.fg("dim", wrapped)}`);
				}
				lines.push("");
			}
		}

		lines.push(...this.renderHelp(width));
		return lines;
	}

	// ----- help -------------------------------------------------------------

	private renderHelp(width: number): string[] {
		const th = this.theme;
		const variants =
			this.view === "activity"
				? [
						"[m] tokens/cost · [v/1-5] view · [q] close",
						"[m] metric · [v] view · [q]",
						"[m] · [v] · [q]",
					]
				: this.view === "providers" || this.view === "tools"
					? [
							"[Tab/←→] period · [↑↓] select · [Enter] expand · [v/1-5] view · [q] close",
							"[Tab] period · [↑↓] · [Enter] · [v] view · [q]",
							"[↑↓] · [Enter] · [q]",
						]
					: [
							"[Tab/←→] period · [v/1-5] view · [q] close",
							"[Tab] period · [v] view · [q]",
							"[v] view · [q]",
						];
		return [th.fg("dim", pickFitting(width, variants))];
	}
}

function formatRange(min: number, typical: number, max: number, unit: string): string {
	const round = (n: number) => {
		if (n === 0) return "0";
		if (n < 0.001) return n.toExponential(1);
		if (n < 1) return n.toFixed(3);
		if (n < 100) return n.toFixed(2);
		return Math.round(n).toLocaleString();
	};
	if (min === max) return `${round(typical)} ${unit}`;
	return `${round(min)}–${round(max)} ${unit} (≈ ${round(typical)})`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("usage", {
		description: "Show token usage, spend and sustainability impact",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return;

			const report = await ctx.ui.custom<UsageReport | null>((tui, theme, _kb, done) => {
				const loader = new CancellableLoader(
					tui,
					(s: string) => theme.fg("accent", s),
					(s: string) => theme.fg("muted", s),
					"Crunching session history…",
				);
				let settled = false;
				const finish = (value: UsageReport | null) => {
					if (settled) return;
					settled = true;
					loader.dispose();
					done(value);
				};
				loader.onAbort = () => finish(null);

				buildReport(loader.signal)
					.then(finish)
					.catch(() => finish(null));

				return loader;
			});

			if (!report) return;

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new Spacer(1));
				container.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
				container.addChild(new Spacer(1));

				const panel = new UsagePanel(theme, report, () => tui.requestRender(), () => done());

				return {
					render: (w: number) => {
						const top = clipLines(container.render(w), w);
						const body = panel.render(w);
						const bottom = theme.fg("border", "─".repeat(w));
						return clipLines([...top, ...body, "", bottom], w);
					},
					invalidate: () => container.invalidate(),
					handleInput: (input: string) => panel.handleInput(input),
					dispose: () => {},
				};
			});
		},
	});
}
