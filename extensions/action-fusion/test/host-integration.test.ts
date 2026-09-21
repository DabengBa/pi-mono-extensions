import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSessionEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type Tool } from "@earendil-works/pi-ai";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
let workspace: string;

before(async () => {
	workspace = await mkdtemp(join(tmpdir(), "action-fusion-host-"));
});

after(async () => {
	await rm(workspace, { recursive: true, force: true });
});

interface ToolExecution {
	readonly toolName: string;
	readonly result: {
		readonly content: readonly unknown[];
		readonly details?: unknown;
	};
	readonly isError: boolean;
}

interface HostRun {
	readonly tools: readonly Tool[];
	readonly executions: readonly ToolExecution[];
}

function toolExecutionEvents(events: AgentSessionEvent[]): ToolExecution[] {
	return events
		.filter((event): event is Extract<AgentSessionEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end")
		.map((event) => ({
			toolName: event.toolName,
			result: event.result as { content: readonly unknown[]; details?: unknown },
			isError: event.isError,
		}));
}

async function runHostScenario(scenario: "success" | "failure"): Promise<HostRun> {
	const provider = fauxProvider({ provider: "action-fusion-host", api: "action-fusion-faux" });
	const visibleTools: Tool[] = [];
	provider.setResponses([
		(context) => {
			visibleTools.push(...getCurrentTools(context.messages));
			if (scenario === "success") {
				return fauxAssistantMessage(
					fauxToolCall("write", {
						path: "host-success.txt",
						content: "written by the real host\n",
						then_run: { command: "cat host-success.txt" },
					}),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage(
				fauxToolCall("edit", {
					path: "host-failure.txt",
					edits: [{ oldText: "missing", newText: "replacement" }],
					then_run: { command: "touch should-not-run.txt" },
				}),
				{ stopReason: "toolUse" },
			);
		},
		() => fauxAssistantMessage("deterministic provider completed the tool call"),
	]);

	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: workspace,
		agentDir: join(workspace, ".agent"),
		settingsManager,
		additionalExtensionPaths: [packageDir],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();

	const modelRuntime = await ModelRuntime.create({
		authPath: join(workspace, ".auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(provider.provider);

	const { session, extensionsResult } = await createAgentSession({
		cwd: workspace,
		model: provider.getModel(),
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(workspace),
		tools: ["edit", "write"],
	});
	assert.equal(extensionsResult.errors.length, 0, JSON.stringify(extensionsResult.errors));
	assert.ok(extensionsResult.extensions.some((extension) => extension.path.includes("action-fusion")));

	const registeredTools = session.getAllTools().map((tool) => tool.name).sort();
	assert.deepEqual(registeredTools, ["edit", "write"]);
	const editDefinition = session.getToolDefinition("edit") as ToolDefinition;
	const writeDefinition = session.getToolDefinition("write") as ToolDefinition;
	assert.ok(editDefinition);
	assert.ok(writeDefinition);

	const events: AgentSessionEvent[] = [];
	const unsubscribe = session.subscribe((event) => {
		events.push(event);
	});
	try {
		await session.prompt(`run the ${scenario} action-fusion scenario`);
		await session.waitForIdle();
	} finally {
		unsubscribe();
		session.dispose();
	}

	assert.equal(visibleTools.length > 0, true);
	return { tools: visibleTools, executions: toolExecutionEvents(events) };
}

test("real AgentSession loads the package and exposes fused edit/write schemas", async () => {
	const result = await runHostScenario("success");
	const edit = result.tools.find((tool) => tool.name === "edit");
	const write = result.tools.find((tool) => tool.name === "write");

	assert.ok(edit);
	assert.ok(write);
	assert.equal(JSON.stringify(edit.parameters).includes("then_run"), true);
	assert.equal(JSON.stringify(write.parameters).includes("then_run"), true);
	assert.equal(JSON.stringify(edit.parameters).includes('"edits"'), true);
	assert.equal(JSON.stringify(write.parameters).includes('"content"'), true);

	assert.equal(result.executions.length, 1);
	const execution = result.executions[0];
	assert.equal(execution.toolName, "write");
	assert.equal(execution.isError, false);
	assert.ok(Array.isArray(execution.result.content));
	assert.equal(execution.result.details, undefined);
	const content = execution.result.content as Array<{ type: string; text?: string }>;
	assert.ok(content.some((block) => block.type === "text" && block.text?.includes("[then_run:succeeded]")));
	assert.ok(content.some((block) => block.type === "text" && block.text?.includes("written by the real host")));
	assert.equal(await readFile(join(workspace, "host-success.txt"), "utf8"), "written by the real host\n");
});

test("real AgentSession reports a failed fused mutation as an error result", async () => {
	const result = await runHostScenario("failure");

	assert.equal(result.executions.length, 1);
	const execution = result.executions[0];
	assert.equal(execution.toolName, "edit");
	assert.equal(execution.isError, true);
	assert.ok(Array.isArray(execution.result.content));
	assert.deepEqual(execution.result.details, {});
	const content = execution.result.content as Array<{ type: string; text?: string }>;
	assert.ok(content.some((block) => block.type === "text" && block.text?.includes("[then_run:skipped]")));
	assert.equal(await readFile(join(workspace, "host-failure.txt"), "utf8").catch(() => undefined), undefined);
	assert.equal(await readFile(join(workspace, "should-not-run.txt"), "utf8").catch(() => undefined), undefined);
});

console.log(JSON.stringify({ host: "AgentSession", package: packageDir, scenarios: ["success", "failure"] }));
