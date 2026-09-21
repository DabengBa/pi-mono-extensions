import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
	type AgentToolResult,
	type BashOperations,
	createEditToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import registerActionFusion from "../src/index.ts";
import {
	executeMutationThenRun,
	THEN_RUN_FAILED,
	THEN_RUN_SKIPPED,
	THEN_RUN_SUCCEEDED,
} from "../src/then-run.ts";

let workspace: string;

before(async () => {
	workspace = await realpath(await mkdtemp(join(tmpdir(), "action-fusion-")));
});

after(async () => {
	await rm(workspace, { recursive: true, force: true });
});

/**
 * Minimal ExtensionAPI double. This extension only calls `registerTool`, so the
 * double exposes that one method and the documented cast keeps it honest.
 */
function createFakeExtensionApi(): { readonly api: ExtensionAPI; readonly tools: Map<string, ToolDefinition> } {
	const tools = new Map<string, ToolDefinition>();
	const api = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	};
	return { api: api as unknown as ExtensionAPI, tools };
}

/**
 * Minimal ExtensionContext double. The exercised code reads `ctx.cwd` and, for
 * the PI_* bash environment, `ctx.sessionManager.getSessionId/getSessionFile`.
 */
function createTestContext(cwd: string): ExtensionContext {
	const context = {
		cwd,
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getSessionId: () => "action-fusion-test",
			getSessionFile: () => undefined,
		},
	};
	return context as unknown as ExtensionContext;
}

function requireTool(tools: Map<string, ToolDefinition>, name: string): ToolDefinition {
	const tool = tools.get(name);
	assert.ok(tool, `expected the extension to register a ${name} tool`);
	return tool;
}

function runTool(
	tool: ToolDefinition,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	return tool.execute("call_test", params, signal, undefined, ctx);
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Return the rejection message of `promise`, failing the test when it resolves. */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error: unknown) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the operation to reject");
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

interface BashCall {
	readonly command: string;
	readonly cwd: string;
	readonly timeout: number | undefined;
}

function createBashSpy(
	options: { readonly exitCode?: number; readonly output?: string } = {},
): { readonly calls: BashCall[]; readonly operations: BashOperations } {
	const calls: BashCall[] = [];
	const operations: BashOperations = {
		exec(command, cwd, { onData, timeout }) {
			calls.push({ command, cwd, timeout });
			if (options.output !== undefined) onData(Buffer.from(options.output));
			return Promise.resolve({ exitCode: options.exitCode ?? 0 });
		},
	};
	return { calls, operations };
}

/** Mutation stub: write the file the way the native tool would, then report success. */
function mutationStub(file: string, content: string): () => Promise<AgentToolResult<undefined>> {
	return async () => {
		await writeFile(file, content, "utf-8");
		return { content: [{ type: "text", text: `Successfully wrote to ${basename(file)}` }], details: undefined };
	};
}

const { api, tools } = createFakeExtensionApi();
registerActionFusion(api);
const editTool = requireTool(tools, "edit");
const writeTool = requireTool(tools, "write");

const EDIT_ARGS = { path: "file.txt", edits: [{ oldText: "before", newText: "after" }] };

describe("registered tools", () => {
	test("overrides the native edit and write tools by name", () => {
		assert.deepEqual([...tools.keys()].sort(), ["edit", "write"]);
	});

	test("keeps the native parameters and adds an optional then_run to edit", () => {
		assert.equal(Value.Check(editTool.parameters, EDIT_ARGS), true);
		assert.equal(Value.Check(editTool.parameters, { ...EDIT_ARGS, then_run: { command: "npm test" } }), true);
		assert.equal(
			Value.Check(editTool.parameters, { ...EDIT_ARGS, then_run: { command: "npm test", timeout: 120 } }),
			true,
		);
		assert.equal(Value.Check(editTool.parameters, { ...EDIT_ARGS, then_run: { timeout: 120 } }), false);
		assert.equal(Value.Check(editTool.parameters, { ...EDIT_ARGS, then_run: "npm test" }), false);
		assert.equal(Value.Check(editTool.parameters, { ...EDIT_ARGS, then_run: { command: "npm test", timeout: "120" } }), false);
	});

	test("keeps the native parameters and adds the same then_run to write", () => {
		assert.equal(Value.Check(writeTool.parameters, { path: "file.txt", content: "text" }), true);
		assert.equal(Value.Check(writeTool.parameters, { path: "file.txt", content: "text", then_run: { command: "npm test" } }), true);
		assert.equal(Value.Check(writeTool.parameters, { path: "file.txt", content: "text", then_run: { command: 7 } }), false);
	});

	test("describes the failure semantics of then_run to the model", () => {
		const schemaText = JSON.stringify(editTool.parameters);
		assert.ok(schemaText.includes("only after the file mutation succeeds"));
		assert.ok(schemaText.includes("not rolled back"));
	});

	test("keeps the native prompt metadata and renderers", () => {
		const baseEdit = createEditToolDefinition(workspace);
		const baseWrite = createWriteToolDefinition(workspace);

		assert.equal(editTool.promptSnippet, baseEdit.promptSnippet);
		assert.deepEqual(editTool.promptGuidelines, baseEdit.promptGuidelines);
		assert.equal(editTool.description, baseEdit.description);
		assert.equal(writeTool.promptSnippet, baseWrite.promptSnippet);
		assert.deepEqual(writeTool.promptGuidelines, baseWrite.promptGuidelines);
		assert.equal(writeTool.description, baseWrite.description);

		assert.equal(editTool.renderCall, baseEdit.renderCall);
		assert.equal(editTool.renderResult, baseEdit.renderResult);
		assert.equal(writeTool.renderCall, baseWrite.renderCall);
		assert.equal(writeTool.renderResult, baseWrite.renderResult);
	});

	test("keeps the native prepareArguments shim", () => {
		assert.deepEqual(editTool.prepareArguments?.({ path: "a.txt", oldText: "a", newText: "b" }), {
			path: "a.txt",
			edits: [{ oldText: "a", newText: "b" }],
		});
		assert.equal(writeTool.prepareArguments, createWriteToolDefinition(workspace).prepareArguments);
	});
});

describe("native behavior without then_run", () => {
	test("returns the same edit result as the native tool", async () => {
		const nativeDir = join(workspace, "native-edit");
		const fusedDir = join(workspace, "fused-edit");
		await mkdir(nativeDir, { recursive: true });
		await mkdir(fusedDir, { recursive: true });
		await writeFile(join(nativeDir, "file.txt"), "before\n", "utf-8");
		await writeFile(join(fusedDir, "file.txt"), "before\n", "utf-8");

		const native = await createEditToolDefinition(nativeDir).execute(
			"call_native",
			EDIT_ARGS,
			undefined,
			undefined,
			createTestContext(nativeDir),
		);
		const fused = await runTool(editTool, EDIT_ARGS, createTestContext(fusedDir));

		assert.deepEqual(fused.content, native.content);
		assert.deepEqual(fused.details, native.details);
		assert.equal(
			await readFile(join(fusedDir, "file.txt"), "utf-8"),
			await readFile(join(nativeDir, "file.txt"), "utf-8"),
		);
	});

	test("returns the same write result as the native tool and runs no command", async () => {
		const nativeDir = join(workspace, "native-write");
		const fusedDir = join(workspace, "fused-write");
		await mkdir(nativeDir, { recursive: true });
		await mkdir(fusedDir, { recursive: true });
		const params = { path: "file.txt", content: "written\n" };

		const native = await createWriteToolDefinition(nativeDir).execute(
			"call_native",
			params,
			undefined,
			undefined,
			createTestContext(nativeDir),
		);
		const fused = await runTool(writeTool, params, createTestContext(fusedDir));

		assert.deepEqual(fused, native);
		assert.equal(fused.content.length, 1);
		assert.equal(textOf(fused).includes(THEN_RUN_SUCCEEDED), false);
	});

	test("treats then_run: null as absent", async () => {
		const params = { path: "null-then-run.txt", content: "written\n", then_run: null };
		const result = await runTool(writeTool, params, createTestContext(workspace));

		assert.equal(result.content.length, 1);
		assert.equal(textOf(result).includes(THEN_RUN_SUCCEEDED), false);
		assert.equal(await readFile(join(workspace, "null-then-run.txt"), "utf-8"), "written\n");
	});

	test("rejects a malformed then_run before the mutation runs", async () => {
		const params = { path: "invalid-then-run.txt", content: "written\n", then_run: { command: "true", timeout: "5" } };
		const message = await rejectionMessage(runTool(writeTool, params, createTestContext(workspace)));

		assert.match(message, /then_run/);
		assert.equal(await fileExists(join(workspace, "invalid-then-run.txt")), false);
	});

	test("rejects a non-string then_run command before the mutation runs", async () => {
		const params = { path: "invalid-command.txt", content: "written\n", then_run: { command: 42 } };
		const message = await rejectionMessage(runTool(writeTool, params, createTestContext(workspace)));

		assert.match(message, /command must be a string/);
		assert.equal(await fileExists(join(workspace, "invalid-command.txt")), false);
	});
});

describe("fused edit and write with then_run", () => {
	test("write + then_run sees the written content", async () => {
		const result = await runTool(
			writeTool,
			{ path: "fused-write-ok.txt", content: "hello from write\n", then_run: { command: "cat fused-write-ok.txt" } },
			createTestContext(workspace),
		);
		const text = textOf(result);

		assert.ok(text.includes("Successfully wrote to fused-write-ok.txt"));
		assert.ok(text.includes(THEN_RUN_SUCCEEDED));
		assert.ok(text.includes("hello from write"));
		assert.equal(result.details, undefined);
		assert.equal(await readFile(join(workspace, "fused-write-ok.txt"), "utf-8"), "hello from write\n");
	});

	test("edit + then_run keeps the native details and sees the edit", async () => {
		const nativeDir = join(workspace, "fused-edit-native");
		const fusedDir = join(workspace, "fused-edit-target");
		await mkdir(nativeDir, { recursive: true });
		await mkdir(fusedDir, { recursive: true });
		await writeFile(join(nativeDir, "file.txt"), "before\n", "utf-8");
		await writeFile(join(fusedDir, "file.txt"), "before\n", "utf-8");

		const native = await createEditToolDefinition(nativeDir).execute(
			"call_native",
			EDIT_ARGS,
			undefined,
			undefined,
			createTestContext(nativeDir),
		);
		const fused = await runTool(
			editTool,
			{ ...EDIT_ARGS, then_run: { command: "cat file.txt" } },
			createTestContext(fusedDir),
		);
		const text = textOf(fused);

		assert.deepEqual(fused.details, native.details);
		assert.equal(fused.content.length, 2);
		assert.deepEqual(fused.content[0], native.content[0]);
		assert.ok(text.includes(THEN_RUN_SUCCEEDED));
		assert.ok(text.includes("after"));
	});

	test("keeps the mutation when the command exits non-zero", async () => {
		await writeFile(join(workspace, "failed-command.txt"), "before\n", "utf-8");
		const message = await rejectionMessage(
			runTool(
				editTool,
				{ path: "failed-command.txt", edits: [{ oldText: "before", newText: "after" }], then_run: { command: "exit 7" } },
				createTestContext(workspace),
			),
		);

		assert.ok(message.includes(THEN_RUN_FAILED));
		assert.ok(message.includes("Command exited with code 7"));
		assert.equal(await readFile(join(workspace, "failed-command.txt"), "utf-8"), "after\n");
	});

	test("does not run the command when the mutation fails", async () => {
		await writeFile(join(workspace, "kept-mutation.txt"), "unchanged\n", "utf-8");
		const message = await rejectionMessage(
			runTool(
				editTool,
				{
					path: "kept-mutation.txt",
					edits: [{ oldText: "missing text", newText: "replacement" }],
					then_run: { command: "touch should-not-exist.txt" },
				},
				createTestContext(workspace),
			),
		);

		assert.ok(message.includes(THEN_RUN_SKIPPED));
		assert.ok(message.includes("The file mutation did not complete successfully"));
		assert.equal(await fileExists(join(workspace, "should-not-exist.txt")), false);
		assert.equal(await readFile(join(workspace, "kept-mutation.txt"), "utf-8"), "unchanged\n");
	});

	test("keeps the mutation when the command times out", async () => {
		const message = await rejectionMessage(
			runTool(
				writeTool,
				{ path: "timeout-command.txt", content: "kept content\n", then_run: { command: "sleep 5", timeout: 0.3 } },
				createTestContext(workspace),
			),
		);

		assert.ok(message.includes(THEN_RUN_FAILED));
		assert.ok(message.includes("timed out after 0.3 seconds"));
		assert.equal(await readFile(join(workspace, "timeout-command.txt"), "utf-8"), "kept content\n");
	});

	test("skips the command and releases the queue after an aborted fused call", { timeout: 10_000 }, async () => {
		await writeFile(join(workspace, "aborted.txt"), "before\n", "utf-8");
		const controller = new AbortController();
		controller.abort();

		const message = await rejectionMessage(
			runTool(
				editTool,
				{
					path: "aborted.txt",
					edits: [{ oldText: "before", newText: "after" }],
					then_run: { command: "touch aborted-marker.txt" },
				},
				createTestContext(workspace),
				controller.signal,
			),
		);

		assert.ok(message.includes(THEN_RUN_SKIPPED));
		assert.equal(await fileExists(join(workspace, "aborted-marker.txt")), false);

		const next = await runTool(
			writeTool,
			{ path: "aborted.txt", content: "recovered\n", then_run: { command: "cat aborted.txt" } },
			createTestContext(workspace),
		);
		assert.ok(textOf(next).includes("recovered"));
	});
});

describe("fused mutation helper", () => {
	test("forwards the command verbatim and the timeout to Pi bash", async () => {
		const file = join(workspace, "forwarded-command.txt");
		const spy = createBashSpy({ output: "spy output" });
		const command = "printf '%s' \"raw $HOME && unquoted| chars\"  # untouched";

		const result = await executeMutationThenRun({
			toolCallId: "call_forward",
			path: "forwarded-command.txt",
			thenRun: { command, timeout: 42 },
			signal: undefined,
			ctx: createTestContext(workspace),
			bashOptions: { operations: spy.operations },
			mutate: mutationStub(file, "new content"),
			yieldForInterference: undefined,
		});

		assert.deepEqual(spy.calls, [{ command, cwd: workspace, timeout: 42 }]);
		const text = textOf(result);
		assert.ok(text.includes("Successfully wrote to forwarded-command.txt"));
		assert.ok(text.includes(THEN_RUN_SUCCEEDED));
		assert.ok(text.includes("spy output"));
		assert.equal(result.details, undefined);
	});

	test("does not invent a timeout when then_run omits it", async () => {
		const spy = createBashSpy();

		await executeMutationThenRun({
			toolCallId: "call_no_timeout",
			path: "no-timeout.txt",
			thenRun: { command: "true" },
			signal: undefined,
			ctx: createTestContext(workspace),
			bashOptions: { operations: spy.operations },
			mutate: mutationStub(join(workspace, "no-timeout.txt"), "content"),
			yieldForInterference: undefined,
		});

		assert.deepEqual(spy.calls, [{ command: "true", cwd: workspace, timeout: undefined }]);
	});

	test("rethrows the mutation error unchanged when then_run is absent", async () => {
		const spy = createBashSpy();
		const failure = new Error("native edit failed");

		const message = await rejectionMessage(
			executeMutationThenRun({
				toolCallId: "call_no_then_run",
				path: "untouched.txt",
				thenRun: undefined,
				signal: undefined,
				ctx: createTestContext(workspace),
				bashOptions: { operations: spy.operations },
				mutate: async () => {
					throw failure;
				},
				yieldForInterference: undefined,
			}),
		);

		assert.equal(message, "native edit failed");
		assert.deepEqual(spy.calls, []);
	});

	test("skips the command when the mutation fails", async () => {
		const spy = createBashSpy();

		const message = await rejectionMessage(
			executeMutationThenRun({
				toolCallId: "call_mutation_failed",
				path: "untouched.txt",
				thenRun: { command: "true" },
				signal: undefined,
				ctx: createTestContext(workspace),
				bashOptions: { operations: spy.operations },
				mutate: async () => {
					throw new Error("native edit failed");
				},
				yieldForInterference: undefined,
			}),
		);

		assert.ok(message.startsWith("native edit failed"));
		assert.ok(message.includes(THEN_RUN_SKIPPED));
		assert.ok(message.includes("The file mutation did not complete successfully"));
		assert.deepEqual(spy.calls, []);
	});

	test("skips the command when the target changes between the two hashes", async () => {
		const file = join(workspace, "changed-during-window.txt");
		const spy = createBashSpy();

		const message = await rejectionMessage(
			executeMutationThenRun({
				toolCallId: "call_changed",
				path: "changed-during-window.txt",
				thenRun: { command: "true" },
				signal: undefined,
				ctx: createTestContext(workspace),
				bashOptions: { operations: spy.operations },
				mutate: mutationStub(file, "first content"),
				yieldForInterference: async () => {
					await writeFile(file, "changed by someone else", "utf-8");
					await new Promise<void>((resolve) => setImmediate(resolve));
				},
			}),
		);

		assert.ok(message.includes(THEN_RUN_SKIPPED));
		assert.ok(message.includes("target content changed after the fused mutation; the command was not run."));
		assert.deepEqual(spy.calls, []);
	});

	test("skips the command when the target cannot be read after the mutation", async () => {
		const file = join(workspace, "removed-during-window.txt");
		const spy = createBashSpy();

		const message = await rejectionMessage(
			executeMutationThenRun({
				toolCallId: "call_removed",
				path: "removed-during-window.txt",
				thenRun: { command: "true" },
				signal: undefined,
				ctx: createTestContext(workspace),
				bashOptions: { operations: spy.operations },
				mutate: mutationStub(file, "content"),
				yieldForInterference: async () => {
					await rm(file, { force: true });
				},
			}),
		);

		assert.ok(message.includes(THEN_RUN_SKIPPED));
		assert.ok(message.includes("ENOENT"));
		assert.deepEqual(spy.calls, []);
	});

	test("skips the command when the target becomes a directory", async () => {
		const parent = join(workspace, "swapped-target");
		const file = join(parent, "file.txt");
		await mkdir(parent, { recursive: true });
		const spy = createBashSpy();

		const message = await rejectionMessage(
			executeMutationThenRun({
				toolCallId: "call_directory",
				path: "swapped-target/file.txt",
				thenRun: { command: "true" },
				signal: undefined,
				ctx: createTestContext(workspace),
				bashOptions: { operations: spy.operations },
				mutate: mutationStub(file, "content"),
				yieldForInterference: async () => {
					await rm(file, { force: true });
					await mkdir(file, { recursive: true });
				},
			}),
		);

		assert.ok(message.includes(THEN_RUN_SKIPPED));
		assert.ok(message.includes("not a regular file"));
		assert.deepEqual(spy.calls, []);
	});

	test("fails on a malformed file URL before mutating or running the command", async () => {
		const spy = createBashSpy();
		let mutated = false;

		const message = await rejectionMessage(
			executeMutationThenRun({
				toolCallId: "call_bad_url",
				path: "file:///tmp/%ZZ.txt",
				thenRun: { command: "true" },
				signal: undefined,
				ctx: createTestContext(workspace),
				bashOptions: { operations: spy.operations },
				mutate: async () => {
					mutated = true;
					return { content: [{ type: "text", text: "mutated" }], details: undefined };
				},
				yieldForInterference: undefined,
			}),
		);

		assert.match(message, /URI malformed/);
		assert.equal(mutated, false);
		assert.deepEqual(spy.calls, []);
	});

	test("reports a failing command without discarding the mutation", async () => {
		const file = join(workspace, "failing-command.txt");
		const spy = createBashSpy({ exitCode: 3, output: "test output" });

		const message = await rejectionMessage(
			executeMutationThenRun({
				toolCallId: "call_failing",
				path: "failing-command.txt",
				thenRun: { command: "npm test" },
				signal: undefined,
				ctx: createTestContext(workspace),
				bashOptions: { operations: spy.operations },
				mutate: mutationStub(file, "new content"),
				yieldForInterference: undefined,
			}),
		);

		assert.ok(message.includes("Successfully wrote to failing-command.txt"));
		assert.ok(message.includes(THEN_RUN_FAILED));
		assert.ok(message.includes("test output"));
		assert.ok(message.includes("Command exited with code 3"));
		assert.equal(await readFile(file, "utf-8"), "new content");
	});

	test("serializes the whole mutation and command window for one file", { timeout: 10_000 }, async () => {
		const file = join(workspace, "serialized-window.txt");
		const events: string[] = [];
		const operations: BashOperations = {
			async exec(command, _cwd, { onData }) {
				events.push(`command:${command}:start`);
				await delay(30);
				onData(Buffer.from(`${command} output`));
				events.push(`command:${command}:end`);
				return { exitCode: 0 };
			},
		};
		let signalFirstMutation: (() => void) | undefined;
		const firstMutationStarted = new Promise<void>((resolve) => {
			signalFirstMutation = resolve;
		});

		const first = executeMutationThenRun({
			toolCallId: "call_first",
			path: "serialized-window.txt",
			thenRun: { command: "first" },
			signal: undefined,
			ctx: createTestContext(workspace),
			bashOptions: { operations },
			mutate: async () => {
				events.push("mutation:first");
				signalFirstMutation?.();
				return mutationStub(file, "first content")();
			},
			yieldForInterference: undefined,
		});
		await firstMutationStarted;

		const second = executeMutationThenRun({
			toolCallId: "call_second",
			path: "serialized-window.txt",
			thenRun: { command: "second" },
			signal: undefined,
			ctx: createTestContext(workspace),
			bashOptions: { operations },
			mutate: async () => {
				events.push("mutation:second");
				return mutationStub(file, "second content")();
			},
			yieldForInterference: undefined,
		});

		await Promise.all([first, second]);

		assert.deepEqual(events, [
			"mutation:first",
			"command:first:start",
			"command:first:end",
			"mutation:second",
			"command:second:start",
			"command:second:end",
		]);
	});
});
