// Pi Team-Mode — Agent Manager

import type { TeamMateStore } from "../core/store.js";
import { readFile } from "node:fs/promises";
import { generateTeammateId } from "../core/store.js";
import {
	type ExecutionRuntime,
	type IsolationMode,
	type LiveTeammateMetrics,
	type LiveTeammateSnapshot,
	type SpawnOpts,
	type ThinkingLevel,
	type TeammateRecord,
	type TeammateRunResult,
	type TeammateStatus,
	type TeammateSpec,
} from "../core/types.js";
import { runPi, type PiRun, type PiRunResult } from "../runtime/subprocess.js";
import { runTransientSession, type TransientSessionOpts } from "../runtime/transient-session.js";
import { cleanupWorktree, createWorktree, type WorktreeHandle } from "../runtime/worktree.js";
import { loadTeammateSpec } from "../core/teammate-specs.js";
import { TEAMMATE_SYSTEM_PROMPT_ADDENDUM } from "../core/prompts.js";
import { PiStreamParser, type PiStreamEvent } from "../runtime/pi-stream-parser.js";
import {
	isModelTier,
	loadModelConfig,
	resolveBareModelOverride,
	resolveModel,
	splitThinkingSuffix,
	type ModelTier,
	type ResolvedCandidate,
	type ResolvedModel,
} from "../core/model-config.js";

type LiveRun = {
	run: PiRun;
	record: TeammateRecord;
	worktree?: WorktreeHandle;
	description: string;
	startedAt: number;
};

export type TeammateEndMetrics = {
	toolUses?: number;
	durationMs?: number;
	metrics?: LiveTeammateMetrics;
	transcriptPath?: string;
};

export type AgentManagerDeps = {
	store: TeamMateStore;
	getParentSessionId: () => string;
	getDefaultCwd: () => string;
	/**
	 * Invoked once a teammate transitions out of "running". Called for both
	 * foreground and background runs. The handler is expected to emit a
	 * `<task-notification>` to the parent session when appropriate.
	 */
	onTeammateEnd?: (record: TeammateRecord, metrics: TeammateEndMetrics) => void;
	/** Test seam for the in-process one-shot runner. */
	runTransientSession?: (opts: TransientSessionOpts) => Promise<TeammateRunResult>;
};

export type ModelPick = {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** Ordered model choices (v2 catalogs). [0] is the primary; the rest are spawn-failure fallbacks. */
	candidates?: ResolvedCandidate[];
	rationale: string;
};

export class AgentManager {
	private readonly liveRuns = new Map<string, LiveRun>();
	private readonly metrics = new Map<string, LiveTeammateMetrics>();
	private readonly descriptions = new Map<string, string>();
	private readonly subscribers = new Set<() => void>();
	private queuedCount = 0;
	private notifyTimer: NodeJS.Timeout | undefined;

	constructor(private readonly deps: AgentManagerDeps) {}

	subscribeAll(cb: () => void): () => void {
		this.subscribers.add(cb);
		return () => {
			this.subscribers.delete(cb);
		};
	}

	setQueuedCount(count: number): void {
		const next = Math.max(0, Math.floor(count));
		if (next === this.queuedCount) return;
		this.queuedCount = next;
		this.scheduleNotify();
	}

	getQueuedCount(): number {
		return this.queuedCount;
	}

	getLiveSnapshots(): LiveTeammateSnapshot[] {
		return [...this.liveRuns.values()]
			.map((live): LiveTeammateSnapshot | null => {
				const metrics = this.metrics.get(live.record.id);
				if (!metrics) return null;
				return {
					record: live.record,
					metrics,
					description: this.descriptions.get(live.record.id),
					transcriptPath: this.deps.store.teammateSessionFile(live.record.id),
				};
			})
			.filter((snap): snap is LiveTeammateSnapshot => snap !== null)
			.sort((a, b) => a.metrics.startedAt - b.metrics.startedAt);
	}

	/**
	 * Spawn a new teammate. Returns immediately with a stub result when
	 * `background=true`; otherwise awaits the subprocess to exit and returns
	 * the final message.
	 */
	async spawn(opts: SpawnOpts): Promise<TeammateRunResult> {
		const runtime: ExecutionRuntime = opts.runtime ?? "subprocess";
		if (runtime === "transient") return this.spawnTransient(opts);

		const parentSessionId = this.deps.getParentSessionId();
		const nameIndex = await this.deps.store.getNameIndex(parentSessionId);

		const callerName = opts.name?.trim();
		if (callerName && nameIndex[callerName]) {
			throw new Error(
				`teammate "${callerName}" already exists in this session — use send_message to continue it.`,
			);
		}

		const teammateId = generateTeammateId(callerName);
		const name = callerName || teammateId;

		const team = opts.teamId ? await this.deps.store.loadTeam(opts.teamId) : null;
		if (opts.teamId && !team) throw new Error(`unknown team: ${opts.teamId}`);

		const isolation: IsolationMode = opts.isolation ?? team?.defaultIsolation ?? "none";

		const baseCwd = opts.cwd ?? this.deps.getDefaultCwd();
		let worktree: WorktreeHandle | undefined;
		let cwd = baseCwd;
		if (isolation === "worktree") {
			worktree = await createWorktree(baseCwd, team?.worktreeBase);
			cwd = worktree.path;
		}

		const spec = opts.subagentType
			? await loadTeammateSpec(baseCwd, opts.subagentType)
			: null;

		const pick = await this.resolveModel(opts.model ?? spec?.modelTier, opts.subagentType);
		const thinkingLevel = opts.thinkingLevel ?? spec?.thinkingLevel ?? pick.thinkingLevel;

		const now = new Date().toISOString();
		const record: TeammateRecord = {
			id: teammateId,
			name,
			teamId: opts.teamId,
			subagentType: opts.subagentType,
			model: pick.model,
			provider: pick.provider,
			thinkingLevel,
			isolation,
			cwd,
			worktreeBranch: worktree?.branch,
			status: "running",
			background: opts.background ?? false,
			createdAt: now,
			updatedAt: now,
			parentSessionId,
		};
		await this.deps.store.saveTeammate(record);

		nameIndex[name] = teammateId;
		await this.deps.store.setNameIndex(parentSessionId, nameIndex);

		const initialMessage = buildInitialMessage(opts, spec?.description);
		const run = await this.launchWithFallback(
			record,
			initialMessage,
			spec ?? undefined,
			pick,
			opts.thinkingLevel ?? spec?.thinkingLevel,
		);

		return this.track(
			record,
			run,
			worktree,
			opts.background ?? false,
			pick.rationale,
			opts.description,
		);
	}

	private async spawnTransient(opts: SpawnOpts): Promise<TeammateRunResult> {
		validateTransientOptions(opts);
		const baseCwd = opts.cwd ?? this.deps.getDefaultCwd();
		const spec = opts.subagentType
			? await loadTeammateSpec(baseCwd, opts.subagentType)
			: null;
		const pick = await this.resolveModel(opts.model ?? spec?.modelTier, opts.subagentType);
		const specThinking = opts.thinkingLevel ?? spec?.thinkingLevel;
		const teammateId = generateTeammateId();
		const name = teammateId;
		const initialMessage = buildInitialMessage(opts, spec?.description);
		const runner = this.deps.runTransientSession ?? runTransientSession;
		const candidates: ResolvedCandidate[] =
			pick.candidates && pick.candidates.length > 0
				? pick.candidates
				: [{ provider: pick.provider ?? "", model: pick.model ?? "" }];

		let result: TeammateRunResult | undefined;
		for (let index = 0; index < candidates.length; index++) {
			const candidate = candidates[index];
			result = await runner({
				id: teammateId,
				name,
				description: opts.description,
				message: initialMessage,
				cwd: baseCwd,
				provider: candidate.provider || undefined,
				model: candidate.model || undefined,
				thinkingLevel: specThinking ?? candidate.thinkingLevel ?? pick.thinkingLevel,
				modelRationale: pick.rationale,
				spec: spec ?? undefined,
			});
			// Retry the next candidate only when the run failed before producing
			// any output — a completed (even failed-task) run is never retried.
			const startupFailure =
				result.status === "failed" && (result.startupFailure === true || !result.result?.trim());
			if (!startupFailure || index === candidates.length - 1) return result;
		}
		return result!;
	}

	/** Resume an existing teammate by name. Context is preserved via pi's --session. */
	async sendMessage(nameOrId: string, message: string): Promise<TeammateRunResult> {
		const record = await this.resolveTeammate(nameOrId);
		if (this.liveRuns.has(record.id)) {
			throw new Error(
				`teammate "${record.name}" is already running — wait for it to finish or use team_list to check status.`,
			);
		}

		record.status = "running";
		record.updatedAt = new Date().toISOString();
		await this.deps.store.saveTeammate(record);

		const spec = record.subagentType
			? await loadTeammateSpec(record.cwd, record.subagentType)
			: null;

		const run = runPi({
			...this.buildRunOptions(record, message, spec ?? undefined),
			onEvent: (event) => this.applyEvent(record, event),
		});

		// Worktree cleanup only runs at the first spawn. Resume turns pass undefined.
		return this.track(
			record,
			run,
			undefined,
			record.background,
			"resume (reused initial model selection)",
			`Continue ${record.name}`,
		);
	}

	async stop(nameOrId: string): Promise<void> {
		const record = await this.resolveTeammate(nameOrId);
		const live = this.liveRuns.get(record.id);
		if (live) live.run.abort();
		const metrics = this.metrics.get(record.id);
		if (metrics) {
			metrics.exitReason = "stopped";
			metrics.finishedAt = Date.now();
		}
		record.status = "stopped";
		record.updatedAt = new Date().toISOString();
		await this.deps.store.saveTeammate(record);
		this.scheduleNotify();
	}

	/** Read the latest output of a teammate (used by the task_output tool). */
	async output(nameOrId: string): Promise<TeammateRecord | null> {
		try {
			const record = await this.resolveTeammate(nameOrId);
			return await this.withTranscriptFallback(record);
		} catch {
			return null;
		}
	}

	/** List teammates owned by the current parent session. */
	async list(): Promise<TeammateRecord[]> {
		const parentSessionId = this.deps.getParentSessionId();
		const all = await this.deps.store.listTeammates();
		return all.filter((t) => t.parentSessionId === parentSessionId);
	}

	async get(nameOrId: string): Promise<TeammateRecord | null> {
		try {
			return await this.resolveTeammate(nameOrId);
		} catch {
			return null;
		}
	}

	/** Abort all live runs and mark records as stopped. Called on session shutdown. */
	async cleanup(): Promise<void> {
		const entries = [...this.liveRuns.values()];
		this.liveRuns.clear();
		this.metrics.clear();
		this.descriptions.clear();
		this.queuedCount = 0;
		const now = new Date().toISOString();
		await Promise.all(
			entries.map((live) => {
				live.run.abort();
				live.record.status = "stopped";
				live.record.updatedAt = now;
				return this.deps.store.saveTeammate(live.record).catch(() => {});
			}),
		);
		this.scheduleNotify();
	}

	// --- internals ---

	/**
	 * Pick `{ provider, model }` for a teammate. Priority:
	 *   1. Explicit fully-qualified caller override ("openai-codex/gpt-5.4").
	 *   2. Tier alias ("cheap"/"mid"/"deep"/"small"/"fast"/"big"/…) → resolveModel with override.
	 *   3. model-config.json role→tier mapping.
	 *   4. Nothing — let pi use its own defaults.
	 */
	private async resolveModel(
		override: string | undefined,
		role: string | undefined,
	): Promise<ModelPick> {
		const trimmed = override?.trim();
		const config = await loadModelConfig();
		const tierOverride = tierFromOverride(trimmed, config);
		if (tierOverride) {
			const resolved = resolveModel(config, role ?? "", tierOverride);
			if (resolved) return packResolved(resolved);
		}

		// Explicit fully-qualified override bypasses model-config entirely.
		if (trimmed) {
			const slash = trimmed.indexOf("/");
			if (slash >= 0) {
				const split = splitThinkingSuffix(trimmed.slice(slash + 1));
				return {
					provider: trimmed.slice(0, slash),
					model: split.model,
					thinkingLevel: split.thinkingLevel,
					rationale: "explicit spawn_agent.model override",
				};
			}
			const resolvedBare = resolveBareModelOverride(config, trimmed);
			if (resolvedBare) return packResolved(resolvedBare);
			const split = splitThinkingSuffix(trimmed);
			return {
				model: split.model,
				thinkingLevel: split.thinkingLevel,
				rationale: "explicit spawn_agent.model override (bare id; no provider match found)",
			};
		}

		const resolved = resolveModel(config, role ?? "");
		if (resolved) return packResolved(resolved);

		return { rationale: "no model-config catalog entry — letting pi use its own defaults" };
	}

	/**
	 * Start a pi run for `record`, walking the candidate fallback chain when a
	 * candidate fails at startup (dies before producing any output — e.g. an
	 * unknown model or auth error). Candidates arrive pre-rotated by
	 * model-config's weighted round-robin, so entry [0] is the load-balanced
	 * primary and the rest are fallbacks.
	 */
	private async launchWithFallback(
		record: TeammateRecord,
		message: string,
		spec: TeammateSpec | undefined,
		pick: ModelPick,
		explicitThinkingLevel?: ThinkingLevel,
	): Promise<PiRun> {
		const candidates = pick.candidates ?? [];
		if (candidates.length <= 1) {
			return runPi({
				...this.buildRunOptions(record, message, spec),
				onEvent: (event) => this.applyEvent(record, event),
			});
		}

		for (let index = 0; index < candidates.length; index++) {
			const candidate = candidates[index];
			if (index > 0) {
				// Persist the fallback model onto the teammate record so resumes
				// (send_message) reuse the model that actually worked.
				record.provider = candidate.provider || record.provider;
				record.model = candidate.model || record.model;
				record.thinkingLevel = explicitThinkingLevel ?? candidate.thinkingLevel;
				record.updatedAt = new Date().toISOString();
				await this.deps.store.saveTeammate(record);
			}

			let markActive: () => void = () => {};
			const active = new Promise<void>((resolve) => {
				markActive = resolve;
			});
			const run = runPi({
				...this.buildRunOptions(record, message, spec),
				onEvent: (event) => {
					if (isActivityEvent(event)) markActive();
					this.applyEvent(record, event);
				},
			});

			const outcome = await Promise.race([
				active.then(() => "active" as const),
				run.promise.then(
					(result) => (isStartupFailure(result) ? ("failed" as const) : ("active" as const)),
					() => "failed" as const,
				),
			]);
			if (outcome === "active" || index === candidates.length - 1) return run;
			// Startup failed before any output — abandon this run, try next candidate.
		}

		throw new Error("candidate loop exhausted");
	}

	private async resolveTeammate(nameOrId: string): Promise<TeammateRecord> {
		const parentSessionId = this.deps.getParentSessionId();
		const nameIndex = await this.deps.store.getNameIndex(parentSessionId);
		const id = nameIndex[nameOrId] ?? nameOrId;
		const record = await this.deps.store.loadTeammate(id);
		if (!record) throw new Error(`unknown teammate: ${nameOrId}`);
		return record;
	}

	/** Build PiRunOptions from a teammate record + current message + optional spec. */
	private buildRunOptions(
		record: TeammateRecord,
		message: string,
		spec: TeammateSpec | undefined,
	) {
		// Prepend the teammate communication addendum so every spawned
		// subprocess knows it must use send_message to talk to peers.
		const specBody = spec?.systemPrompt?.trim();
		const systemPromptBody = specBody
			? `${TEAMMATE_SYSTEM_PROMPT_ADDENDUM}\n\n${specBody}`
			: TEAMMATE_SYSTEM_PROMPT_ADDENDUM;
		return {
			message,
			cwd: record.cwd,
			sessionPath: this.deps.store.teammateSessionFile(record.id),
			provider: record.provider,
			model: record.model,
			thinkingLevel: record.thinkingLevel,
			tools: spec?.tools,
			systemPromptBody,
			parentSessionId: record.parentSessionId,
			teammateName: record.name,
		};
	}

	private async track(
		record: TeammateRecord,
		run: PiRun,
		worktree: WorktreeHandle | undefined,
		background: boolean,
		modelRationale: string,
		description: string,
	): Promise<TeammateRunResult> {
		const startedAt = Date.now();
		this.metrics.set(record.id, {
			turns: 0,
			toolUses: 0,
			tokens: 0,
			startedAt,
		});
		this.descriptions.set(record.id, description);
		this.liveRuns.set(record.id, { run, record, worktree, description, startedAt });
		this.scheduleNotify();

		const finalize = async (): Promise<TeammateRunResult> => {
			let runResult: PiRunResult | null = null;
			let runError: Error | null = null;
			try {
				runResult = await run.promise;
			} catch (err) {
				runError = err as Error;
			}
			this.liveRuns.delete(record.id);

			const metric = this.metrics.get(record.id);
			if (metric) {
				metric.finishedAt = Date.now();
			}

			const stderrTail = runResult?.stderr?.trim();
			const status: TeammateStatus = deriveStatus(runResult, runError, record.status);
			const finalMessage =
				runResult?.finalMessage ||
				(runResult?.errorMessage ? `[assistant error] ${runResult.errorMessage}` : "") ||
				(runError ? `[subprocess error] ${runError.message}` : "") ||
				(status !== "completed" && stderrTail
					? `[pi exited ${runResult?.exitCode ?? "?"}] stderr:\n${stderrTail}`
					: "") ||
				(status !== "completed" && runResult?.exitCode === 0
					? "[empty output] pi exited 0 but produced no assistant text."
					: "");

			let worktreeInfo: { path: string; branch: string } | undefined;
			if (worktree) {
				const cleanup = await cleanupWorktree(worktree).catch(() => null);
				if (cleanup && !cleanup.removed) {
					worktreeInfo = { path: cleanup.path, branch: cleanup.branch };
				}
			}

			const updated: TeammateRecord = {
				...record,
				status,
				pid: undefined,
				updatedAt: new Date().toISOString(),
				lastResult: finalMessage,
				lastExitCode: runResult?.exitCode ?? undefined,
			};
			await this.deps.store.saveTeammate(updated);

			const baseMetric = this.metrics.get(record.id);
			const finalMetrics = baseMetric
				? {
					...baseMetric,
					exitReason: mapExitReason(status),
				  }
				: undefined;
			const transcriptPath = this.deps.store.teammateSessionFile(updated.id);
			this.deps.onTeammateEnd?.(updated, {
				toolUses: finalMetrics?.toolUses,
				durationMs: Date.now() - startedAt,
				metrics: finalMetrics,
				transcriptPath,
			});
			this.metrics.delete(record.id);
			this.descriptions.delete(record.id);
			this.scheduleNotify();

			return {
				teammateId: updated.id,
				name: updated.name,
				description,
				status,
				result: finalMessage,
				exitCode: runResult?.exitCode ?? null,
				metrics: finalMetrics,
				transcriptPath,
				provider: record.provider,
				model: record.model,
				thinkingLevel: record.thinkingLevel,
				modelRationale,
				worktree: worktreeInfo,
				durationMs: Date.now() - startedAt,
				runtime: "subprocess",
			};
		};

		if (!background) return finalize();

		finalize().catch(() => {
			/* errors are recorded inside finalize via saveTeammate */
		});

		return {
			teammateId: record.id,
			name: record.name,
			description,
			status: "running",
			result:
				`Agent spawned. task_id=${record.id}. ` +
				`You will receive a <task-notification> when it finishes.`,
			exitCode: null,
			metrics: this.metrics.get(record.id),
			transcriptPath: this.deps.store.teammateSessionFile(record.id),
			provider: record.provider,
			model: record.model,
			thinkingLevel: record.thinkingLevel,
			modelRationale,
			background: true,
			runtime: "subprocess",
		};
	}

	private applyEvent(record: TeammateRecord, event: PiStreamEvent): void {
		const metrics = this.metrics.get(record.id);
		if (!metrics) return;

		switch (event.type) {
			case "assistant_delta": {
				if (!metrics.activityHint) {
					metrics.activityHint = "thinking…";
				}
				break;
			}
			case "assistant_message": {
				metrics.turns += 1;
				const usageTotal = event.usage?.totalTokens;
				if (typeof usageTotal === "number" && Number.isFinite(usageTotal) && usageTotal > 0) {
					metrics.tokens += usageTotal;
				}
				metrics.currentTool = undefined;
				metrics.currentToolStartedAt = undefined;
				metrics.activityHint = "responding…";
				break;
			}
			case "tool_start": {
				metrics.toolUses += 1;
				metrics.currentTool = event.toolName;
				metrics.currentToolStartedAt = Date.now();
				metrics.activityHint = describeToolActivity(event.toolName, event.argsPreview);
				break;
			}
			case "tool_end": {
				metrics.activityHint = event.isError ? "tool error…" : "processing result…";
				if (metrics.currentTool === event.toolName || !event.toolName) {
					metrics.currentTool = undefined;
					metrics.currentToolStartedAt = undefined;
				}
				break;
			}
			case "turn_end": {
				metrics.activityHint = "waiting…";
				break;
			}
		}

		this.scheduleNotify();
	}

	private async withTranscriptFallback(record: TeammateRecord): Promise<TeammateRecord> {
		if (record.lastResult?.trim()) return record;
		const fallback = await this.readLastAssistantFromTranscript(record.id);
		if (!fallback) return record;
		return {
			...record,
			lastResult: fallback,
		};
	}

	private async readLastAssistantFromTranscript(teammateId: string): Promise<string | undefined> {
		try {
			const raw = await readFile(this.deps.store.teammateSessionFile(teammateId), "utf8");
			const parser = new PiStreamParser();
			const events = parser.push(raw.endsWith("\n") ? raw : `${raw}\n`).concat(parser.flush());
			let latest: string | undefined;
			for (const event of events) {
				if (event.type !== "assistant_message") continue;
				if (event.text.trim()) latest = event.text;
				else if (event.errorMessage) latest = `[assistant error] ${event.errorMessage}`;
			}
			return latest;
		} catch {
			return undefined;
		}
	}

	private scheduleNotify(): void {
		if (this.notifyTimer) return;
		this.notifyTimer = setTimeout(() => {
			this.notifyTimer = undefined;
			for (const cb of this.subscribers) cb();
		}, 80);
		this.notifyTimer.unref();
	}
}

// --- helpers ---

const TIER_ALIASES: Record<string, ModelTier> = {
	small: "cheap",
	fast: "cheap",
	mini: "cheap",
	default: "mid",
	standard: "mid",
	medium: "mid",
	big: "deep",
	large: "deep",
	thinking: "deep",
	high: "deep",
};

function tierFromOverride(value: string | undefined, config: Awaited<ReturnType<typeof loadModelConfig>>): ModelTier | undefined {
	if (!value) return undefined;
	const v = value.toLowerCase();
	if (isModelTier(v)) return v;
	if (config.tiers[v] || Object.values(config.roles).includes(v) || Object.values(config.roleTiers).includes(v)) return v;
	return TIER_ALIASES[v];
}

function validateTransientOptions(opts: SpawnOpts): void {
	if (opts.isolation === "worktree") {
		throw new Error('runtime "transient" does not support isolation "worktree"; use runtime "subprocess" for worktree isolation.');
	}
	if (opts.background) {
		throw new Error('runtime "transient" does not support run_in_background; use runtime "subprocess" for background workers.');
	}
	if (opts.teamId) {
		throw new Error('runtime "transient" does not support team_name; transient runs are not durable team members.');
	}
	if (opts.name?.trim()) {
		throw new Error('runtime "transient" does not support name; transient runs cannot be resumed with send_message.');
	}
}

/**
 * A stream event proving the model started and is doing useful work.
 * An assistant_message carrying only an errorMessage (e.g. unknown model,
 * provider auth failure) is deliberately NOT activity — it's a startup failure.
 */
export function isActivityEvent(event: PiStreamEvent): boolean {
	switch (event.type) {
		case "assistant_delta":
			return true;
		case "tool_start":
			return true;
		case "assistant_message":
			return !event.errorMessage && Boolean(event.text.trim());
		default:
			return false;
	}
}

/**
 * A run that ended before producing output looks like a startup failure
 * (unknown model, bad provider, spawn error) and is safe to retry on the
 * next candidate. Aborted runs and real output are never startup failures.
 */
export function isStartupFailure(result: PiRunResult): boolean {
	if (result.exitSignal) return false;
	if (result.errorMessage) return true;
	if (result.finalMessage.trim()) return false;
	return result.exitCode !== 0;
}

function packResolved(r: ResolvedModel): ModelPick {
	return {
		provider: r.provider,
		model: r.model,
		thinkingLevel: r.thinkingLevel,
		candidates: r.candidates,
		rationale: `model-config: ${r.rationale}`,
	};
}

function buildInitialMessage(opts: SpawnOpts, specDescription: string | undefined): string {
	const header = `Task: ${opts.description}`;
	const roleHint = specDescription ? `Role context: ${specDescription}` : "";
	return [header, roleHint, "", opts.prompt].filter(Boolean).join("\n");
}

function deriveStatus(
	result: PiRunResult | null,
	error: Error | null,
	previous: TeammateStatus,
): TeammateStatus {
	if (error || !result) return "failed";
	if (result.exitSignal) return previous === "stopped" ? "stopped" : "failed";
	if (result.exitCode !== 0) return "failed";
	if (result.stopReason?.toLowerCase() === "error" || result.errorMessage) return "failed";
	if (!result.finalMessage.trim()) return "failed";
	return "completed";
}

function mapExitReason(status: TeammateStatus): LiveTeammateMetrics["exitReason"] {
	if (status === "completed") return "completed";
	if (status === "stopped") return "stopped";
	if (status === "running") return "wrapped_up";
	if (status === "pending") return "aborted";
	return "failed";
}

function describeToolActivity(toolName: string, argsPreview: string | undefined): string {
	const tool = toolName.toLowerCase();
	if (tool === "read") return "reading files…";
	if (tool === "edit" || tool === "write") return "editing files…";
	if (tool === "bash") return "running commands…";
	if (tool === "grep" || tool === "glob") return "searching…";
	if (argsPreview && argsPreview.length > 0) {
		return `${toolName}: ${argsPreview.slice(0, 80)}${argsPreview.length > 80 ? "…" : ""}`;
	}
	return `${toolName}…`;
}

