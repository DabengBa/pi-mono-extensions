/**
 * context-guard — keep the LLM context window lean.
 *
 * Intercepts tool calls before they execute and applies three guards:
 *
 * 1. `read` without `limit`
 *    → auto-injects `limit: DEFAULT_READ_LIMIT` and notifies the user.
 *      The model can paginate with `offset` if it needs more.
 *
 * 2. `read` for a range already seen this session (mtime unchanged)
 *    → blocks the call and returns a stub:
 *      "File unchanged since last read — refer to the earlier result."
 *      (~20 tokens vs re-sending the full content). Evicted when
 *      multi-edit emits `context-guard:file-modified`.
 *
 *      Dedup tracks the set of line ranges already pulled into context per
 *      file, and blocks any read whose requested range is fully covered by
 *      them — not just byte-identical repeat calls.
 *
 * 3. `bash` using `rg` without any output-bounding operator
 *    → appends `| head -N` so grep dumps don't fill the context window.
 *
 * All guards are enabled by default.
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
	readLimit: 120,
	rgHeadLimit: 60,
	readGuard: true,
	dedupGuard: true,
	rgGuard: true,
};

type Config = typeof DEFAULTS;

// ---------------------------------------------------------------------------
// Read dedup cache
// ---------------------------------------------------------------------------

/** A half-open line interval [start, end) — 1-indexed, end may be Infinity. */
type Range = { start: number; end: number };

/** What we remember about a past read. */
type ReadEntry = {
	/** mtime in milliseconds at the time of the read. */
	mtimeMs: number;
	/** Merged, sorted line ranges already present in the conversation. */
	ranges: Range[];
};

const FILE_UNCHANGED_STUB_PREFIX = "File unchanged since last read.";

function unchangedStub(ranges: Range[]): string {
	return (
		`${FILE_UNCHANGED_STUB_PREFIX} The requested lines are already in this ` +
		"conversation from an earlier Read tool_result and are still current — " +
		`refer to that instead of re-reading. Lines already available: ${describe(ranges)}. ` +
		"To see other parts of the file, read with an offset outside those ranges."
	);
}

// ---------------------------------------------------------------------------
// Range helpers — `read` uses 1-indexed `offset` and a line `limit`.
// ---------------------------------------------------------------------------

function toRange(offset: number | undefined, limit: number | undefined): Range {
	const start = offset != null && offset > 0 ? offset : 1;
	const end = limit != null && limit > 0 ? start + limit : Number.POSITIVE_INFINITY;
	return { start, end };
}

/** Insert `next` into `ranges`, merging any overlapping or adjacent intervals. */
function addRange(ranges: Range[], next: Range): Range[] {
	const merged: Range[] = [];
	let cur = { ...next };
	for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
		if (r.end < cur.start || r.start > cur.end) {
			merged.push(r);
			continue;
		}
		// Overlapping or touching — absorb into cur.
		cur = { start: Math.min(cur.start, r.start), end: Math.max(cur.end, r.end) };
	}
	merged.push(cur);
	return merged.sort((a, b) => a.start - b.start);
}

/** True when `probe` lies entirely inside a single already-known range. */
function covers(ranges: Range[], probe: Range): boolean {
	return ranges.some((r) => probe.start >= r.start && probe.end <= r.end);
}

function describe(ranges: Range[]): string {
	return ranges
		.map((r) =>
			r.end === Number.POSITIVE_INFINITY
				? `${r.start}-end`
				: `${r.start}-${r.end - 1}`,
		)
		.join(", ");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a read path into a stable cache key.
 *
 * Both the `tool_call` and `tool_result` handlers MUST use this, resolving
 * against `ctx.cwd`. ~77% of reads use relative paths, so any divergence in
 * the base directory silently disables dedup.
 */
function cacheKey(cwd: string, rawPath: string): string {
	return resolve(cwd, rawPath.startsWith("@") ? rawPath.slice(1) : rawPath);
}

function usesUnboundedRg(cmd: string): boolean {
	if (!/(?:^|[|;&\s])rg\s/.test(cmd)) return false;
	if (/\|\s*(?:head|tail|wc|less|more|grep\s+-c)/.test(cmd)) return false;
	if (/\brg\b[^|]*\s(?:-l|--files-with-matches|-c|--count|--json)\b/.test(cmd)) return false;
	return true;
}

function appendHead(cmd: string, n: number): string {
	return `${cmd.trimEnd().replace(/;+$/, "").trimEnd()} | head -${n}`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	const cfg: Config = { ...DEFAULTS };

	/** Session-scoped read cache: absolute path → last-seen read metadata. */
	const readCache = new Map<string, ReadEntry>();

	// -------------------------------------------------------------------------
	// Cache invalidation — fired by multi-edit after every real file write
	// -------------------------------------------------------------------------
	pi.events.on("context-guard:file-modified", (data: unknown) => {
		const event = data as { path?: string };
		if (event.path) {
			readCache.delete(resolve(event.path));
		}
	});

	// -------------------------------------------------------------------------
	// Clear cache before compaction � file contents are lost but cache
	// entries would still block re-reads with "File unchanged since last read".
	// -------------------------------------------------------------------------
	pi.on("session_before_compact", async () => {
		readCache.clear();
	});

	// -------------------------------------------------------------------------
	// Cache clear � allows external extensions to invalidate the dedup cache.
	// Emitted via pi.events.emit("context-guard:clear-cache").
	// -------------------------------------------------------------------------
	pi.events.on("context-guard:clear-cache", () => {
		readCache.clear();
	});

	// -------------------------------------------------------------------------
	// Reset cache on new session
	// -------------------------------------------------------------------------
	pi.on("session_start", async () => {
		readCache.clear();
	});

	// -------------------------------------------------------------------------
	// Guard 1 + 2: read — limit injection + dedup
	// -------------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("read", event)) return;

		// Guard 1: inject limit if missing
		if (cfg.readGuard && event.input.limit === undefined) {
			event.input.limit = cfg.readLimit;
			ctx.ui.notify(
				`[context-guard] read: auto-limit=${cfg.readLimit} (use offset to paginate)`,
				"info",
			);
		}

		// Guard 2: dedup — block if this range is already in context
		if (!cfg.dedupGuard) return;

		const rawPath = event.input.path;
		if (!rawPath) return;

		const absolutePath = cacheKey(ctx.cwd, rawPath);

		const entry = readCache.get(absolutePath);
		if (!entry) return;

		// Block when the requested range is already fully covered by a prior read.
		const probe = toRange(event.input.offset, event.input.limit);
		if (!covers(entry.ranges, probe)) return;

		// Check mtime — if the file changed on disk, let it through
		try {
			const { mtimeMs } = await stat(absolutePath);
			if (mtimeMs !== entry.mtimeMs) {
				readCache.delete(absolutePath);
				return;
			}
		} catch {
			// stat failed (file deleted, permission error, etc.) — let tool handle it
			readCache.delete(absolutePath);
			return;
		}

		// File is unchanged — block the call and return the stub
		ctx.ui.notify(`[context-guard] read dedup: ${rawPath} unchanged`, "info");
		return {
			block: true,
			reason: unchangedStub(entry.ranges),
		};
	});

	// -------------------------------------------------------------------------
	// Populate cache after a successful read
	// -------------------------------------------------------------------------
	pi.on("tool_result", async (event, ctx) => {
		if (!cfg.dedupGuard) return;
		if (event.toolName !== "read") return;
		if (event.isError) return;

		const rawPath = (event.input as { path?: string }).path;
		if (!rawPath) return;

		// Never dedup non-text reads (images, PDFs) — re-reading is the only way
		// to get them back and the stub would be a dead end.
		if (event.content.some((b) => b.type !== "text")) return;

		const resultText = event.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("");

		// Skip stubs injected by us — don't overwrite the real entry
		if (resultText.startsWith(FILE_UNCHANGED_STUB_PREFIX)) return;

		// Must resolve against the same base as the tool_call handler, otherwise
		// relative paths key the cache differently on write vs lookup and dedup
		// never fires.
		const absolutePath = cacheKey(ctx.cwd, rawPath);

		const justRead = toRange(
			(event.input as { offset?: number }).offset,
			(event.input as { limit?: number }).limit,
		);

		try {
			const { mtimeMs } = await stat(absolutePath);
			const prev = readCache.get(absolutePath);
			// A changed file invalidates everything we knew about it.
			const base = prev && prev.mtimeMs === mtimeMs ? prev.ranges : [];
			readCache.set(absolutePath, {
				mtimeMs,
				ranges: addRange(base, justRead),
			});
		} catch {
			// best-effort only
		}
	});

	// -------------------------------------------------------------------------
	// Guard 3: bash — rg without head/tail/wc
	// -------------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		if (!cfg.rgGuard) return;
		if (!isToolCallEventType("bash", event)) return;

		const cmd = event.input.command ?? "";
		if (usesUnboundedRg(cmd)) {
			event.input.command = appendHead(cmd, cfg.rgHeadLimit);
			ctx.ui.notify(
				`[context-guard] bash: appended | head -${cfg.rgHeadLimit} to rg`,
				"info",
			);
		}
	});

}
