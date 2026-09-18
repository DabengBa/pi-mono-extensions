/**
 * parsePatch + applyPatchOperations — contract tests.
 *
 * Pins the Codex apply_patch behavior before Phase C1 rewrites the parser.
 * Anything tested here is part of the "parity required" surface; edge cases
 * left untested (EOF sentinel, 4-pass fuzzy match) may change in C1.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyPatchOperations, parsePatch } from "../patch.ts";
import { createRealWorkspace, createVirtualWorkspace } from "../workspace.ts";

const stubPi: ExtensionAPI = {
	events: { emit: () => {} },
} as unknown as ExtensionAPI;

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "multi-edit-patch-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

describe("parsePatch — structural errors", () => {
	test("rejects patch missing '*** Begin Patch'", () => {
		assert.throws(() => parsePatch("not a patch\n*** End Patch"), /first line of the patch must be/);
	});

	test("rejects patch missing '*** End Patch'", () => {
		assert.throws(() => parsePatch("*** Begin Patch\nno end"), /last line of the patch must be/);
	});

	test("rejects empty patch", () => {
		assert.throws(() => parsePatch(""), /empty or invalid/);
	});

	test("rejects invalid hunk header", () => {
		const patch = "*** Begin Patch\n*** Frobnicate: a.txt\n*** End Patch";
		assert.throws(() => parsePatch(patch), /not a valid hunk header/);
	});
});

describe("parsePatch — Add File", () => {
	test("parses a single add-file op", () => {
		const patch = [
			"*** Begin Patch",
			"*** Add File: new.txt",
			"+line one",
			"+line two",
			"*** End Patch",
		].join("\n");
		const ops = parsePatch(patch);
		assert.equal(ops.length, 1);
		assert.equal(ops[0].kind, "add");
		if (ops[0].kind === "add") {
			assert.equal(ops[0].path, "new.txt");
			assert.equal(ops[0].contents, "line one\nline two\n");
		}
	});
});

describe("parsePatch — Delete File", () => {
	test("parses a single delete-file op", () => {
		const patch = "*** Begin Patch\n*** Delete File: old.txt\n*** End Patch";
		const ops = parsePatch(patch);
		assert.equal(ops.length, 1);
		assert.equal(ops[0].kind, "delete");
		if (ops[0].kind === "delete") {
			assert.equal(ops[0].path, "old.txt");
		}
	});
});

describe("parsePatch — Update File", () => {
	test("parses an update with a single context-anchored hunk", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src.txt",
			"@@",
			" unchanged",
			"-old line",
			"+new line",
			"*** End Patch",
		].join("\n");
		const ops = parsePatch(patch);
		assert.equal(ops.length, 1);
		assert.equal(ops[0].kind, "update");
		if (ops[0].kind === "update") {
			assert.equal(ops[0].hunks.length, 1);
			assert.equal(ops[0].hunks[0].oldBlock, "unchanged\nold line");
			assert.equal(ops[0].hunks[0].newBlock, "unchanged\nnew line");
		}
	});

	test("parses a move operation before its first hunk", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/old.ts",
			"*** Move to: src/new.ts",
			"@@",
			"-old",
			"+new",
			"*** End Patch",
		].join("\n");
		const ops = parsePatch(patch);
		assert.equal(ops.length, 1);
		assert.equal(ops[0].kind, "update");
		if (ops[0].kind === "update") {
			assert.equal(ops[0].path, "src/old.ts");
			assert.equal(ops[0].moveTo, "src/new.ts");
			assert.equal(ops[0].hunks[0].oldBlock, "old");
			assert.equal(ops[0].hunks[0].newBlock, "new");
		}
	});

	test("rejects move operations after the first hunk", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/old.ts",
			"@@",
			"-old",
			"+new",
			"*** Move to: src/new.ts",
			"*** End Patch",
		].join("\n");
		assert.throws(() => parsePatch(patch), /Move to.*first hunk/);
	});

	test("rejects a move directive outside an update operation", () => {
		const patch = [
			"*** Begin Patch",
			"*** Move to: src/new.ts",
			"*** End Patch",
		].join("\n");
		assert.throws(() => parsePatch(patch), /not a valid hunk header/);
	});

	test("rejects move operations without a hunk", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src.txt",
			"*** Move to: dst.txt",
			"*** End Patch",
		].join("\n");
		assert.throws(() => parsePatch(patch), /Update file hunk.*empty/);
	});
});

describe("End of File hunk marker", () => {
		test("stores the End of File marker on a hunk", () => {
			const patch = [
				"*** Begin Patch",
				"*** Update File: src.txt",
				"@@",
				"-old",
				"+new",
				"*** End of File",
				"*** End Patch",
			].join("\n");
			const ops = parsePatch(patch);
			assert.equal(ops[0].kind, "update");
			if (ops[0].kind === "update") {
				assert.equal(ops[0].hunks[0].endOfFile, true);
			}
		});

		test("rejects an End of File marker before a hunk", () => {
			const patch = [
				"*** Begin Patch",
				"*** Update File: src.txt",
				"*** End of File",
				"*** End Patch",
			].join("\n");
			assert.throws(() => parsePatch(patch), /must follow a hunk/);
		});

		test("rejects hunk content after an End of File marker", () => {
			const patch = [
				"*** Begin Patch",
				"*** Update File: src.txt",
				"@@",
				"-old",
				"+new",
				"*** End of File",
				" context after eof",
				"*** End Patch",
			].join("\n");
			assert.throws(() => parsePatch(patch), /No hunk content may follow/);
		});

		test("rejects another hunk after an End of File marker", () => {
			const patch = [
				"*** Begin Patch",
				"*** Update File: src.txt",
				"@@",
				"-old",
				"+new",
				"*** End of File",
				"@@",
				"-tail",
				"+TAIL",
				"*** End Patch",
			].join("\n");
			assert.throws(() => parsePatch(patch), /No hunk content may follow/);
		});
	});

describe("applyPatchOperations — Add File round-trip", () => {
	test("creates the file with the given contents", async () => {
		await withTmp(async (dir) => {
			const patch = [
				"*** Begin Patch",
				"*** Add File: greet.txt",
				"+hello",
				"+world",
				"*** End Patch",
			].join("\n");
			const ops = parsePatch(patch);
			await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
			assert.equal(await readFile(join(dir, "greet.txt"), "utf-8"), "hello\nworld\n");
		});
	});
});

describe("applyPatchOperations — Move to", () => {
	test("writes the moved content, creates parent directories, and removes the source", async () => {
		await withTmp(async (dir) => {
			const source = join(dir, "src", "old.ts");
			const destination = join(dir, "generated", "new.ts");
			await mkdir(join(dir, "src"), { recursive: true });
			await writeFile(source, "old\n");

			const patch = [
				"*** Begin Patch",
				"*** Update File: src/old.ts",
				"*** Move to: generated/new.ts",
				"@@",
				"-old",
				"+new",
				"*** End Patch",
			].join("\n");
			await applyPatchOperations(
				parsePatch(patch),
				createRealWorkspace(stubPi),
				dir,
			);

			assert.equal(await exists(source), false);
			assert.equal(await readFile(destination, "utf-8"), "new\n");
		});
	});

	test("rejects a move when the destination already exists without changing the source", async () => {
		await withTmp(async (dir) => {
			const source = join(dir, "old.ts");
			const destination = join(dir, "new.ts");
			await writeFile(source, "old\n");
			await writeFile(destination, "existing\n");

			const patch = [
				"*** Begin Patch",
				"*** Update File: old.ts",
				"*** Move to: new.ts",
				"@@",
				"-old",
				"+new",
				"*** End Patch",
			].join("\n");
			await assert.rejects(
				() =>
					applyPatchOperations(
						parsePatch(patch),
						createRealWorkspace(stubPi),
						dir,
					),
				/destination.*already exists/,
			);
			assert.equal(await readFile(source, "utf-8"), "old\n");
			assert.equal(await readFile(destination, "utf-8"), "existing\n");
		});
	});

	test("rejects a move when source and destination resolve to the same path", async () => {
		await withTmp(async (dir) => {
			const source = join(dir, "old.ts");
			await writeFile(source, "old\n");
			const patch = [
				"*** Begin Patch",
				"*** Update File: old.ts",
				"*** Move to: ./old.ts",
				"@@",
				"-old",
				"+new",
				"*** End Patch",
			].join("\n");
			await assert.rejects(
				() =>
					applyPatchOperations(
						parsePatch(patch),
						createRealWorkspace(stubPi),
						dir,
					),
				/source and destination.*different/,
			);
			assert.equal(await readFile(source, "utf-8"), "old\n");
		});
	});

	test("rejects a move when the source does not exist", async () => {
		await withTmp(async (dir) => {
			const patch = [
				"*** Begin Patch",
				"*** Update File: missing.ts",
				"*** Move to: new.ts",
				"@@",
				"-old",
				"+new",
				"*** End Patch",
			].join("\n");
			await assert.rejects(
				() =>
					applyPatchOperations(
						parsePatch(patch),
						createRealWorkspace(stubPi),
						dir,
					),
				/source.*does not exist/,
			);
		});
	});

	test("keeps virtual move state for subsequent operations", async () => {
		await withTmp(async (dir) => {
			const patch = [
				"*** Begin Patch",
				"*** Add File: old.txt",
				"+old",
				"*** Update File: old.txt",
				"*** Move to: new.txt",
				"@@",
				"-old",
				"+new",
				"*** Update File: new.txt",
				"@@",
				"-new",
				"+final",
				"*** End Patch",
			].join("\n");
			const workspace = createVirtualWorkspace(dir);
			await applyPatchOperations(parsePatch(patch), workspace, dir);
			assert.equal(await workspace.exists(join(dir, "old.txt")), false);
			assert.equal(await workspace.readText(join(dir, "new.txt")), "final\n");
		});
	});

	test("keeps real files unchanged when virtual preflight finds a move conflict", async () => {
		await withTmp(async (dir) => {
			const source = join(dir, "source.txt");
			const destination = join(dir, "destination.txt");
			const created = join(dir, "created", "before-conflict.txt");
			await writeFile(source, "old\n");
			await writeFile(destination, "existing\n");
			const patch = [
				"*** Begin Patch",
				"*** Add File: created/before-conflict.txt",
				"+created",
				"*** Update File: source.txt",
				"*** Move to: destination.txt",
				"@@",
				"-old",
				"+new",
				"*** End Patch",
			].join("\n");

			await assert.rejects(
				() =>
					applyPatchOperations(
						parsePatch(patch),
						createVirtualWorkspace(dir),
						dir,
					),
				/destination.*already exists/,
			);
			assert.equal(await exists(created), false);
			assert.equal(await readFile(source, "utf-8"), "old\n");
			assert.equal(await readFile(destination, "utf-8"), "existing\n");
		});
	});


	test("checks each write or delete target before mutating it", async () => {
		await withTmp(async (dir) => {
			const workspace = createRealWorkspace(stubPi);
			const checked: string[] = [];
			workspace.checkWriteAccess = async (absolutePath) => {
				checked.push(absolutePath);
			};

			const added = join(dir, "nested", "added.txt");
			await applyPatchOperations(
				parsePatch(
					"*** Begin Patch\n*** Add File: nested/added.txt\n+added\n*** End Patch",
				),
				workspace,
				dir,
			);
			assert.deepEqual(checked, [added]);
			assert.equal(await readFile(added, "utf-8"), "added\n");

			checked.length = 0;
			const updated = join(dir, "updated.txt");
			await writeFile(updated, "old\n");
			await applyPatchOperations(
				parsePatch(
					"*** Begin Patch\n*** Update File: updated.txt\n@@\n-old\n+new\n*** End Patch",
				),
				workspace,
				dir,
			);
			assert.deepEqual(checked, [updated]);

			checked.length = 0;
			const source = join(dir, "source.txt");
			const destination = join(dir, "moved", "destination.txt");
			await writeFile(source, "old\n");
			await applyPatchOperations(
				parsePatch(
					"*** Begin Patch\n*** Update File: source.txt\n*** Move to: moved/destination.txt\n@@\n-old\n+new\n*** End Patch",
				),
				workspace,
				dir,
			);
			assert.deepEqual(checked.sort(), [source, destination].sort());

			checked.length = 0;
			await applyPatchOperations(
				parsePatch(
					"*** Begin Patch\n*** Delete File: moved/destination.txt\n*** End Patch",
				),
				workspace,
				dir,
			);
			assert.deepEqual(checked, [destination]);
		});
	});
});

describe("applyPatchOperations — Delete File round-trip", () => {
	test("removes the target file", async () => {
		await withTmp(async (dir) => {
			const victim = join(dir, "gone.txt");
			await writeFile(victim, "bye\n");

			const patch = "*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch";
			const ops = parsePatch(patch);
			await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
			assert.equal(await exists(victim), false);
		});
	});

	test("rejects deletion of a non-existent file", async () => {
		await withTmp(async (dir) => {
			const patch = "*** Begin Patch\n*** Delete File: ghost.txt\n*** End Patch";
			const ops = parsePatch(patch);
			await assert.rejects(
				() => applyPatchOperations(ops, createRealWorkspace(stubPi), dir),
				/does not exist/,
			);
		});
	});
});

describe("applyPatchOperations — Update File round-trip", () => {
	test("applies a single-hunk replacement", async () => {
		await withTmp(async (dir) => {
			const file = join(dir, "src.txt");
			await writeFile(file, "keep\nold\ntail\n");

			const patch = [
				"*** Begin Patch",
				"*** Update File: src.txt",
				"@@",
				" keep",
				"-old",
				"+new",
				"*** End Patch",
			].join("\n");
			const ops = parsePatch(patch);
			await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
			assert.equal(await readFile(file, "utf-8"), "keep\nnew\ntail\n");
		});
	});

	test("applies two non-overlapping hunks", async () => {
		await withTmp(async (dir) => {
			const file = join(dir, "src.txt");
			await writeFile(file, "a\nb\nc\nd\ne\nf\ng\n");

			const patch = [
				"*** Begin Patch",
				"*** Update File: src.txt",
				"@@",
				" a",
				"-b",
				"+B",
				"@@",
				" e",
				"-f",
				"+F",
				"*** End Patch",
			].join("\n");
			const ops = parsePatch(patch);
			await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
			assert.equal(await readFile(file, "utf-8"), "a\nB\nc\nd\ne\nF\ng\n");
		});
	});
});

describe("applyPatchOperations — End of File", () => {
	test("replaces the final occurrence instead of a middle duplicate", async () => {
		await withTmp(async (dir) => {
			const file = join(dir, "src.txt");
			await writeFile(file, "old\nmiddle\nold\n");
			const patch = [
				"*** Begin Patch",
				"*** Update File: src.txt",
				"@@",
				"-old",
				"+new",
				"*** End of File",
				"*** End Patch",
			].join("\n");

			await applyPatchOperations(
				parsePatch(patch),
				createRealWorkspace(stubPi),
				dir,
			);
			assert.equal(await readFile(file, "utf-8"), "old\nmiddle\nnew\n");
		});
	});

	test("rejects a middle-only match for an End of File hunk without mutation", async () => {
		await withTmp(async (dir) => {
			const file = join(dir, "src.txt");
			await writeFile(file, "old\ntail\n");
			const patch = [
				"*** Begin Patch",
				"*** Update File: src.txt",
				"@@",
				"-old",
				"+new",
				"*** End of File",
				"*** End Patch",
			].join("\n");

			await assert.rejects(
				() =>
					applyPatchOperations(
						parsePatch(patch),
						createRealWorkspace(stubPi),
						dir,
					),
				/Failed to find expected lines/,
			);
			assert.equal(await readFile(file, "utf-8"), "old\ntail\n");
		});
	});

	test("matches a file without a trailing newline", async () => {
		await withTmp(async (dir) => {
			const file = join(dir, "src.txt");
			await writeFile(file, "head\nold", "utf-8");
			const patch = [
				"*** Begin Patch",
				"*** Update File: src.txt",
				"@@",
				"-old",
				"+new",
				"*** End of File",
				"*** End Patch",
			].join("\n");

			await applyPatchOperations(
				parsePatch(patch),
				createRealWorkspace(stubPi),
				dir,
			);
			assert.equal(await readFile(file, "utf-8"), "head\nnew\n");
		});
	});

	test("supports pure append to an empty file at EOF", async () => {
		await withTmp(async (dir) => {
			const file = join(dir, "empty.txt");
			await writeFile(file, "", "utf-8");
			const patch = [
				"*** Begin Patch",
				"*** Update File: empty.txt",
				"@@",
				"+appended",
				"*** End of File",
				"*** End Patch",
			].join("\n");

			await applyPatchOperations(
				parsePatch(patch),
				createRealWorkspace(stubPi),
				dir,
			);
			assert.equal(await readFile(file, "utf-8"), "appended\n");
		});
	});

	test("supports pure append at EOF after existing content", async () => {
		await withTmp(async (dir) => {
			const file = join(dir, "append.txt");
			await writeFile(file, "head\n", "utf-8");
			const patch = [
				"*** Begin Patch",
				"*** Update File: append.txt",
				"@@",
				"+tail",
				"*** End of File",
				"*** End Patch",
			].join("\n");

			await applyPatchOperations(
				parsePatch(patch),
				createRealWorkspace(stubPi),
				dir,
			);
			assert.equal(await readFile(file, "utf-8"), "head\ntail\n");
		});
	});

	test("matches a trailing-whitespace-only final line at EOF", async () => {
		await withTmp(async (dir) => {
			const file = join(dir, "final-ws.txt");
			await writeFile(file, "head\nold  \n", "utf-8");
			const patch = [
				"*** Begin Patch",
				"*** Update File: final-ws.txt",
				"@@",
				"-old",
				"+new",
				"*** End of File",
				"*** End Patch",
			].join("\n");

			await applyPatchOperations(
				parsePatch(patch),
				createRealWorkspace(stubPi),
				dir,
			);
			assert.equal(await readFile(file, "utf-8"), "head\nnew\n");
		});
	});


	test("combines trailing-whitespace fallback with EOF matching", async () => {
		await withTmp(async (dir) => {
			const file = join(dir, "ws.txt");
			await writeFile(file, "head  \nold  ", "utf-8");
			const patch = [
				"*** Begin Patch",
				"*** Update File: ws.txt",
				"@@",
				" head",
				"-old",
				"+new",
				"*** End of File",
				"*** End Patch",
			].join("\n");

			await applyPatchOperations(
				parsePatch(patch),
				createRealWorkspace(stubPi),
				dir,
			);
			assert.equal(await readFile(file, "utf-8"), "head\nnew\n");
		});
	});

	test("combines context anchoring with EOF matching", async () => {
		await withTmp(async (dir) => {
			const file = join(dir, "context.txt");
			await writeFile(file, "head\nanchor\nold\n", "utf-8");
			const patch = [
				"*** Begin Patch",
				"*** Update File: context.txt",
				"@@ anchor",
				"-old",
				"+new",
				"*** End of File",
				"*** End Patch",
			].join("\n");

			await applyPatchOperations(
				parsePatch(patch),
				createRealWorkspace(stubPi),
				dir,
			);
			assert.equal(
				await readFile(file, "utf-8"),
				"head\nanchor\nnew\n",
			);
		});
	});

	test("requires a context-anchored EOF hunk to reach the file end", async () => {
		await withTmp(async (dir) => {
			const file = join(dir, "context.txt");
			await writeFile(file, "anchor\nold\ntail\n", "utf-8");
			const patch = [
				"*** Begin Patch",
				"*** Update File: context.txt",
				"@@ anchor",
				"-old",
				"+new",
				"*** End of File",
				"*** End Patch",
			].join("\n");

			await assert.rejects(
				() =>
					applyPatchOperations(
						parsePatch(patch),
						createRealWorkspace(stubPi),
						dir,
					),
				/Failed to find expected lines/,
			);
			assert.equal(await readFile(file, "utf-8"), "anchor\nold\ntail\n");
		});
	});
});

describe("applyPatchOperations — multi-op", () => {
	test("applies add + update + delete in one batch", async () => {
		await withTmp(async (dir) => {
			const keep = join(dir, "keep.txt");
			const gone = join(dir, "gone.txt");
			await writeFile(keep, "foo\nbar\n");
			await writeFile(gone, "delete me\n");

			const patch = [
				"*** Begin Patch",
				"*** Add File: new.txt",
				"+created",
				"*** Update File: keep.txt",
				"@@",
				" foo",
				"-bar",
				"+BAR",
				"*** Delete File: gone.txt",
				"*** End Patch",
			].join("\n");
			const ops = parsePatch(patch);
			await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);

			assert.equal(await readFile(join(dir, "new.txt"), "utf-8"), "created\n");
			assert.equal(await readFile(keep, "utf-8"), "foo\nBAR\n");
			assert.equal(await exists(gone), false);
		});
	});
});

describe("applyPatchOperations — trimEnd hunk matching", () => {
	test("matches hunk when file has trailing spaces on context/old lines", async () => {
		await withTmp(async (dir) => {
			const file = join(dir, "ws.ts");
			// File has trailing spaces on some lines.
			await writeFile(file, "keep  \nold  \ntail\n");

			// Patch references the lines without trailing spaces (model generated clean).
			const patch = [
				"*** Begin Patch",
				"*** Update File: ws.ts",
				"@@",
				" keep",
				"-old",
				"+new",
				"*** End Patch",
			].join("\n");
			const ops = parsePatch(patch);
			await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
			// The matched block (including context line "keep  ") is replaced by
			// newBlock ("keep\nnew") — trailing spaces on the context line are
			// cleaned as a side effect of the replacement.
			assert.equal(await readFile(file, "utf-8"), "keep\nnew\ntail\n");
		});
	});

	test("matches context prefix with trailing whitespace difference", async () => {
		await withTmp(async (dir) => {
			const file = join(dir, "ctx.ts");
			await writeFile(file, "function foo() {  \n  return 1;\n}\n");

			// Context line doesn't have the trailing spaces the file has.
			const patch = [
				"*** Begin Patch",
				"*** Update File: ctx.ts",
				"@@ function foo() {",
				"-  return 1;",
				"+  return 2;",
				"*** End Patch",
			].join("\n");
			const ops = parsePatch(patch);
			await applyPatchOperations(ops, createRealWorkspace(stubPi), dir);
			assert.equal(await readFile(file, "utf-8"), "function foo() {  \n  return 2;\n}\n");
		});
	});
});

describe("applyPatchOperations — permission preflight (R5)", () => {
	test("virtual preflight rejects writes into a directory lacking write+execute", async () => {
		await withTmp(async (dir) => {
			const locked = join(dir, "locked");
			await mkdir(locked);
			const good = join(dir, "good.txt");
			const patch = [
				"*** Begin Patch",
				"*** Add File: good.txt",
				"+good",
				"*** Add File: locked/new.txt",
				"+new",
				"*** End Patch",
			].join("\n");

			// Remove write+execute on the target directory.
			const { chmod } = await import("node:fs/promises");
			await chmod(locked, 0o000);
			try {
				// Virtual preflight must fail before touching real files.
				await assert.rejects(
					() =>
						applyPatchOperations(
							parsePatch(patch),
							createVirtualWorkspace(dir),
							dir,
						),
					/EACCES|permission|denied/i,
				);
				assert.equal(await exists(good), false);
				assert.equal(await exists(join(locked, "new.txt")), false);
			} finally {
				await chmod(locked, 0o700);
			}
		});
	});

	test("virtual preflight rejects delete in a directory lacking write+execute", async () => {
		await withTmp(async (dir) => {
			const locked = join(dir, "locked");
			await mkdir(locked);
			const victim = join(locked, "victim.txt");
			await writeFile(victim, "bye\n");
			const { chmod } = await import("node:fs/promises");
			await chmod(locked, 0o000);
			try {
				await assert.rejects(
					() =>
						applyPatchOperations(
							parsePatch(
								"*** Begin Patch\n*** Delete File: locked/victim.txt\n*** End Patch",
							),
							createVirtualWorkspace(dir),
							dir,
						),
					/EACCES|permission|denied/i,
				);
			} finally {
				await chmod(locked, 0o700);
				// Restore so the file can be cleaned up and re-stat'd.
			}
			assert.equal(await exists(victim), true);
		});
	});
});
