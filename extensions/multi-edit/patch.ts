/**
 * Codex-style apply_patch engine.
 *
 * Accepts payloads bracketed by `*** Begin Patch` / `*** End Patch` and
 * supports three operations: Add File, Delete File, Update File.
 *
 * Design — this is a recursive-descent parser over a line cursor. Each
 * grammar rule owns a small function; there is no shared mutable index
 * bookkeeping or nested-loop state machine. Hunks are stored as raw
 * `oldBlock`/`newBlock` strings so the applier can run `indexOf` directly
 * instead of reconstructing line arrays on each apply.
 *
 * Compatibility notes (vs the original Codex apply_patch format):
 * - Hunks MUST start with a "@@" header. Missing headers are rejected.
 * - Exact-match hunk anchoring with a trailing-whitespace fallback — no 4-pass
 *   fuzzy `seekSequence`.
 * - Supports `*** End of File` hunk terminators and `*** Move to:` updates.
 */

import { isAbsolute, resolve as resolvePath, dirname } from "path";

import { generateDiffString } from "./diff.ts";
import type {
  Hunk,
  PatchOperation,
  PatchOpResult,
  Workspace,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Line cursor
// ---------------------------------------------------------------------------

class LineCursor {
  private pos = 0;
  constructor(private readonly lines: readonly string[]) {}

  peek(): string | undefined {
    return this.lines[this.pos];
  }

  next(): string | undefined {
    return this.lines[this.pos++];
  }

  hasMore(): boolean {
    return this.pos < this.lines.length;
  }

  /** Consume lines while the predicate holds. Returns the number consumed. */
  skipWhile(pred: (line: string) => boolean): number {
    let count = 0;
    while (this.hasMore() && pred(this.peek()!)) {
      this.pos++;
      count++;
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const DIRECTIVE_BEGIN = "*** Begin Patch";
const DIRECTIVE_END = "*** End Patch";
const DIRECTIVE_ADD = "*** Add File: ";
const DIRECTIVE_DELETE = "*** Delete File: ";
const DIRECTIVE_UPDATE = "*** Update File: ";
const DIRECTIVE_MOVE = "*** Move to: ";
const DIRECTIVE_EOF = "*** End of File";

const isBlank = (line: string): boolean => line.trim() === "";
const isDirective = (line: string): boolean =>
  line.trimEnd().startsWith("*** ");

// ---------------------------------------------------------------------------
// Constrained-sampling grammar
// ---------------------------------------------------------------------------

/**
 * Lark grammar describing exactly the patch language `parsePatch` accepts.
 *
 * This is the `openai_lark` variant handed to providers that support grammar
 * constrained sampling for custom tools. It must stay in lockstep with the
 * parser above: every string it accepts must parse, and every patch the parser
 * accepts must be in the language. `__tests__/grammar.test.ts` pins the parser
 * surface, and the differential Lark cross-check under
 * `scripts/grammar-crosscheck/` proves acceptance parity against the parser.
 *
 * Deliberate normalisations mirrored from the parser:
 * - `LF` is CRLF-tolerant because `parsePatch` normalises `\r\n` to `\n`.
 * - `BLANK` matches whitespace-only separator lines (`String.trim()` semantics).
 * - `FILE_CONTENT` requires one non-whitespace character, because the parser
 *   trims directive lines and then rejects a directive without a path.
 * - `add_hunk` and `update_hunk` consume trailing blank lines themselves
 *   (add bodies reject them, hunk bodies treat them as empty context lines),
 *   while `delete_hunk` may be followed by a blank run.
 */
export const APPLY_PATCH_GRAMMAR = `start: WS_PREFIX? begin_patch blank_run? op_seq? end_patch

begin_patch: "*** Begin Patch" LINE_WS? LF
end_patch: LINE_WS? "*** End Patch" TRAILING?

blank_run: BLANK+

op_seq: add_hunk after_tight
      | delete_hunk after_loose
      | update_hunk after_tight

after_tight: (add_hunk after_tight | delete_hunk after_loose | update_hunk after_tight)?
after_loose: (blank_run? add_hunk after_tight
            | blank_run? delete_hunk after_loose
            | blank_run? update_hunk after_tight
            | blank_run?)?

add_hunk: "*** Add File: " filename LF add_line*
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? blank_run? change eof_tail?
eof_tail: eof_line blank_run?

filename: FILE_CONTENT
add_line: "+" LINE_CONTENT? LF

change_move: "*** Move to: " filename LF
change: (change_context change_line+)+
change_context: ("@@" | "@@ " LINE_CONTENT) LINE_WS? LF
change_line: ("+" | "-" | " ") LINE_CONTENT? LF
           | LF
eof_line: "*** End of File" LINE_WS? LF

LF: /\\r?\\n/
LINE_CONTENT: /[^\\n]+/
FILE_CONTENT: /[^\\n]*[^ \\t\\r\\n][^\\n]*/
LINE_WS: /[ \\t]+/
BLANK: /[ \\t]*\\r?\\n/
WS_PREFIX: /[ \\t\\r\\n]+/
TRAILING: /[ \\t\\r\\n]+/`;

export function parsePatch(patchText: string): PatchOperation[] {
  const normalized = patchText.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    throw new Error("Patch is empty or invalid");
  }

  const lines = normalized.split("\n");
  if (lines[0].trim() !== DIRECTIVE_BEGIN) {
    throw new Error(`The first line of the patch must be '${DIRECTIVE_BEGIN}'`);
  }
  if (lines[lines.length - 1].trim() !== DIRECTIVE_END) {
    throw new Error(`The last line of the patch must be '${DIRECTIVE_END}'`);
  }

  // Cursor over the interior (strip Begin and End sentinels).
  const cursor = new LineCursor(lines.slice(1, -1));
  const operations: PatchOperation[] = [];

  while (cursor.hasMore()) {
    cursor.skipWhile(isBlank);
    if (!cursor.hasMore()) break;

    const header = cursor.next()!.trimEnd();

    if (header.startsWith(DIRECTIVE_ADD)) {
      operations.push(parseAddFile(header.slice(DIRECTIVE_ADD.length), cursor));
      continue;
    }
    if (header.startsWith(DIRECTIVE_DELETE)) {
      operations.push({
        kind: "delete",
        path: header.slice(DIRECTIVE_DELETE.length),
      });
      continue;
    }
    if (header.startsWith(DIRECTIVE_UPDATE)) {
      operations.push(
        parseUpdateFile(header.slice(DIRECTIVE_UPDATE.length), cursor),
      );
      continue;
    }

    throw new Error(
      `'${header}' is not a valid hunk header. Valid headers: '${DIRECTIVE_ADD.trim()}', '${DIRECTIVE_DELETE.trim()}', '${DIRECTIVE_UPDATE.trim()}'`,
    );
  }

  return operations;
}

function parseAddFile(path: string, cursor: LineCursor): PatchOperation {
  const bodyLines: string[] = [];

  while (cursor.hasMore()) {
    const line = cursor.peek()!;
    if (isDirective(line)) break;
    cursor.next();
    if (!line.startsWith("+")) {
      throw new Error(
        `Invalid add-file line '${line}'. Add-file lines must start with '+'`,
      );
    }
    bodyLines.push(line.slice(1));
  }

  const contents = bodyLines.length > 0 ? `${bodyLines.join("\n")}\n` : "";
  return { kind: "add", path, contents };
}

function parseUpdateFile(path: string, cursor: LineCursor): PatchOperation {
  let moveTo: string | undefined;
  const lookahead = cursor.peek();
  if (
    lookahead !== undefined &&
    lookahead.trimEnd().startsWith(DIRECTIVE_MOVE)
  ) {
    const moveLine = cursor.next()!.trimEnd();
    moveTo = moveLine.slice(DIRECTIVE_MOVE.length).trim();
    if (!moveTo) {
      throw new Error(`Move destination for '${path}' cannot be empty`);
    }
  }

  const hunks: Hunk[] = [];

  while (cursor.hasMore()) {
    cursor.skipWhile(isBlank);
    if (!cursor.hasMore()) break;

    const line = cursor.peek()!;
    const trimmed = line.trimEnd();
    if (isDirective(line)) {
      if (trimmed.startsWith(DIRECTIVE_MOVE)) {
        throw new Error(
          `Move to for '${path}' is only allowed immediately after the Update File header and before the first hunk`,
        );
      }
      if (trimmed === DIRECTIVE_EOF) {
        throw new Error(
          `End of File marker for '${path}' must follow a hunk`,
        );
      }
      break;
    }

    if (hunks.at(-1)?.endOfFile) {
      throw new Error(
        `No hunk content may follow an End of File marker for '${path}'`,
      );
    }

    hunks.push(parseHunk(path, cursor));
  }

  if (hunks.length === 0) {
    throw new Error(`Update file hunk for path '${path}' is empty`);
  }

  if (moveTo === undefined) return { kind: "update", path, hunks };
  return { kind: "update", path, moveTo, hunks };
}

function parseHunk(path: string, cursor: LineCursor): Hunk {
  const header = cursor.next();
  if (header === undefined) {
    throw new Error(`Expected @@ hunk header in '${path}', got end of patch`);
  }

  const trimmed = header.trimEnd();
  let contextPrefix: string | undefined;
  if (trimmed === "@@") {
    contextPrefix = undefined;
  } else if (trimmed.startsWith("@@ ")) {
    contextPrefix = trimmed.slice(3);
  } else {
    throw new Error(
      `Expected update hunk to start with @@ context marker, got: '${header}'`,
    );
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];
  let endOfFile = false;

  while (cursor.hasMore()) {
    const raw = cursor.peek()!;
    const trimEnd = raw.trimEnd();

    // Any directive or next hunk header ends the current hunk. EOF is the
    // one directive owned by a hunk, so consume it here as its terminator.
    if (trimEnd.startsWith("@@") || isDirective(raw)) {
      if (trimEnd === DIRECTIVE_EOF) {
        cursor.next();
        endOfFile = true;
      }
      break;
    }

    cursor.next();

    if (raw.length === 0) {
      // Blank line inside a hunk is treated as an unchanged empty line.
      oldLines.push("");
      newLines.push("");
      continue;
    }

    const marker = raw[0];
    const body = raw.slice(1);

    if (marker === " ") {
      oldLines.push(body);
      newLines.push(body);
    } else if (marker === "-") {
      oldLines.push(body);
    } else if (marker === "+") {
      newLines.push(body);
    } else {
      throw new Error(
        `Unexpected line found in update hunk for '${path}': '${raw}'. Every line should start with ' ', '+', or '-'.`,
      );
    }
  }

  if (oldLines.length === 0 && newLines.length === 0) {
    throw new Error(`Update hunk for '${path}' does not contain any lines`);
  }

  const hunk: Hunk = {
    contextPrefix,
    oldBlock: oldLines.join("\n"),
    newBlock: newLines.join("\n"),
  };
  if (endOfFile) hunk.endOfFile = true;
  return hunk;
}

// ---------------------------------------------------------------------------
// Applier
// ---------------------------------------------------------------------------

/**
 * Find `needle` in `haystack` starting from `offset`. Tries exact match
 * first; if that fails, retries with per-line trimEnd on both sides.
 * Returns `{ pos, matchLength }` referencing the original haystack, or
 * undefined when no match is found in either pass.
 */
type BlockMatch = { pos: number; matchLength: number };

interface NormalizedText {
	text: string;
	originalIndices: number[];
}

function normalizeTrailingWhitespace(value: string): NormalizedText {
	let text = "";
	const originalIndices: number[] = [];
	let lineStart = 0;

	while (lineStart < value.length) {
		const newline = value.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? value.length : newline;
		const trimmedLength = value.slice(lineStart, lineEnd).trimEnd().length;
		const contentEnd = lineStart + trimmedLength;

		for (let index = lineStart; index < contentEnd; index++) {
			text += value[index];
			originalIndices.push(index);
		}

		if (newline === -1) break;
		text += "\n";
		originalIndices.push(newline);
		lineStart = newline + 1;
	}

	return { text, originalIndices };
}

function findNormalizedBlock(
	haystack: string,
	needle: string,
	offset: number,
): BlockMatch | undefined {
	const normalizedNeedle = normalizeTrailingWhitespace(needle).text;
	const normalizedHaystack = normalizeTrailingWhitespace(haystack);
	if (
		normalizedNeedle === needle &&
		normalizedHaystack.text === haystack
	) {
		return undefined;
	}

	let normalizedOffset = normalizedHaystack.originalIndices.findIndex(
		(index) => index >= offset,
	);
	if (normalizedOffset === -1) normalizedOffset = normalizedHaystack.text.length;

	const normalizedPos = normalizedHaystack.text.indexOf(
		normalizedNeedle,
		normalizedOffset,
	);
	if (normalizedPos === -1 || normalizedNeedle.length === 0) return undefined;

	const pos = normalizedHaystack.originalIndices[normalizedPos];
	const lastNormalizedIndex = normalizedPos + normalizedNeedle.length - 1;
	const lastOriginalIndex =
		normalizedHaystack.originalIndices[lastNormalizedIndex];
	const end = normalizedNeedle.endsWith("\n")
		? lastOriginalIndex + 1
		: (() => {
			const newline = haystack.indexOf("\n", lastOriginalIndex);
			return newline === -1 ? haystack.length : newline;
		})();

	return { pos, matchLength: end - pos };
}

function findBlock(
	haystack: string,
	needle: string,
	offset: number,
): BlockMatch | undefined {
	const exact = haystack.indexOf(needle, offset);
	if (exact !== -1) return { pos: exact, matchLength: needle.length };
	return findNormalizedBlock(haystack, needle, offset);
}

function isEndOfFilePosition(content: string, end: number): boolean {
	const remaining = content.slice(end);
	return remaining === "" || remaining === "\n" || remaining === "\r\n";
}

function findBlockAtEnd(
	haystack: string,
	needle: string,
	offset: number,
): BlockMatch | undefined {
	let searchFrom = offset;
	while (searchFrom <= haystack.length) {
		const match = findBlock(haystack, needle, searchFrom);
		if (match === undefined) return undefined;
		if (isEndOfFilePosition(haystack, match.pos + match.matchLength)) {
			return match;
		}

		// Exact matching intentionally wins for ordinary hunks. For EOF hunks,
		// retry the same occurrence with its trailing whitespace included before
		// moving past it, so `old  ` at EOF is not mistaken for a middle match.
		const normalizedMatch = findNormalizedBlock(haystack, needle, match.pos);
		if (
			normalizedMatch !== undefined &&
			normalizedMatch.pos === match.pos &&
			isEndOfFilePosition(
				haystack,
				normalizedMatch.pos + normalizedMatch.matchLength,
			)
		) {
			return normalizedMatch;
		}

		const nextSearch = match.pos + Math.max(match.matchLength, 1);
		if (nextSearch <= searchFrom) return undefined;
		searchFrom = nextSearch;
	}
	return undefined;
}

function applyHunks(filePath: string, content: string, hunks: Hunk[]): string {
	let result = content;
	let cursor = 0;

	for (const hunk of hunks) {
		let searchFrom = cursor;

		if (hunk.contextPrefix !== undefined) {
			const ctxMatch = findBlock(result, hunk.contextPrefix, searchFrom);
			if (ctxMatch === undefined) {
				throw new Error(
					`Failed to find context '${hunk.contextPrefix}' in ${filePath}`,
				);
			}
			searchFrom = ctxMatch.pos + ctxMatch.matchLength;
		}

		if (hunk.oldBlock === "") {
			// Pure insertion: append at the anchor, or at EOF when unanchored.
			const insertAt =
				hunk.contextPrefix !== undefined ? searchFrom : result.length;
			if (hunk.endOfFile && !isEndOfFilePosition(result, insertAt)) {
				throw new Error(
					`Failed to find expected lines in ${filePath}: insertion does not reach the end of the file`,
				);
			}
			const needsNewline = insertAt > 0 && result[insertAt - 1] !== "\n";
			const prefix = needsNewline ? "\n" : "";
			result =
				result.slice(0, insertAt) +
				prefix +
				hunk.newBlock +
				result.slice(insertAt);
			cursor = insertAt + prefix.length + hunk.newBlock.length;
			continue;
		}

		const match = hunk.endOfFile
			? findBlockAtEnd(result, hunk.oldBlock, searchFrom)
			: findBlock(result, hunk.oldBlock, searchFrom);
		if (match === undefined) {
			throw new Error(
				`Failed to find expected lines in ${filePath}:\n${hunk.oldBlock}`,
			);
		}

		result =
			result.slice(0, match.pos) +
			hunk.newBlock +
			result.slice(match.pos + match.matchLength);
		cursor = match.pos + hunk.newBlock.length;
	}

	// Preserve the "file ends with newline" invariant upstream relies on.
	if (!result.endsWith("\n")) {
		result = `${result}\n`;
	}

	return result;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function checkWriteAccess(
  workspace: Workspace,
  absolutePaths: readonly string[],
): Promise<void> {
  await Promise.all(
    Array.from(new Set(absolutePaths), (absolutePath) =>
      workspace.checkWriteAccess(absolutePath),
    ),
  );
}

function resolvePatchPath(cwd: string, filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new Error("Patch path cannot be empty");
  }
  return isAbsolute(trimmed) ? resolvePath(trimmed) : resolvePath(cwd, trimmed);
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

export async function applyPatchOperations(
  ops: PatchOperation[],
  workspace: Workspace,
  cwd: string,
  signal?: AbortSignal,
  options?: { collectDiff?: boolean },
): Promise<PatchOpResult[]> {
  const results: PatchOpResult[] = [];
  const collectDiff = options?.collectDiff ?? false;

  for (const op of ops) {
    if (signal?.aborted) {
      throw new Error("Operation aborted");
    }

    switch (op.kind) {
      case "add": {
        const abs = resolvePatchPath(cwd, op.path);
        const oldText =
          collectDiff && (await workspace.exists(abs))
            ? await workspace.readText(abs)
            : "";
        const newText = ensureTrailingNewline(op.contents);
        // `abs` may not exist yet; the file-or-parent check handles that.
        await checkWriteAccess(workspace, [abs]);
        await workspace.writeText(abs, newText);
        results.push(
          buildOpResult(
            op.path,
            `Added file ${op.path}.`,
            oldText,
            newText,
            collectDiff,
          ),
        );
        break;
      }

      case "delete": {
        const abs = resolvePatchPath(cwd, op.path);
        if (!(await workspace.exists(abs))) {
          throw new Error(`Failed to delete ${op.path}: file does not exist`);
        }
        const oldText = collectDiff ? await workspace.readText(abs) : "";
        await checkWriteAccess(workspace, [abs]);
        await workspace.deleteFile(abs);
        results.push(
          buildOpResult(
            op.path,
            `Deleted file ${op.path}.`,
            oldText,
            "",
            collectDiff,
          ),
        );
        break;
      }

      case "update": {
        const source = resolvePatchPath(cwd, op.path);
        if (op.moveTo !== undefined) {
          const destination = resolvePatchPath(cwd, op.moveTo);
          if (source === destination) {
            throw new Error(
              `Failed to move ${op.path}: source and destination must be different`,
            );
          }
          if (!(await workspace.exists(source))) {
            throw new Error(
              `Failed to move ${op.path}: source file does not exist`,
            );
          }

          const sourceText = await workspace.readText(source);
          const updated = applyHunks(op.path, sourceText, op.hunks);
          if (await workspace.exists(destination)) {
            throw new Error(
              `Failed to move ${op.path} to ${op.moveTo}: destination already exists`,
            );
          }

          await checkWriteAccess(workspace, [source, destination]);
          // A successful destination write followed by a failed source delete
          // is intentionally not compensated; virtual preflight covers the
          // validation failures before real mutation starts.
          await workspace.writeText(destination, updated);
          await workspace.deleteFile(source);
          results.push(
            buildOpResult(
              op.path,
              `Moved ${op.path} to ${op.moveTo}.`,
              sourceText,
              updated,
              collectDiff,
            ),
          );
          break;
        }

        const sourceText = await workspace.readText(source);
        const updated = applyHunks(op.path, sourceText, op.hunks);
        await checkWriteAccess(workspace, [source]);
        await workspace.writeText(source, updated);
        results.push(
          buildOpResult(
            op.path,
            `Updated ${op.path}.`,
            sourceText,
            updated,
            collectDiff,
          ),
        );
        break;
      }
    }
  }

  return results;
}

function buildOpResult(
  path: string,
  message: string,
  oldText: string,
  newText: string,
  collectDiff: boolean,
): PatchOpResult {
  const result: PatchOpResult = { path, message };
  if (collectDiff) {
    const { diff, firstChangedLine } = generateDiffString(oldText, newText);
    result.diff = diff;
    result.firstChangedLine = firstChangedLine;
  }
  return result;
}
