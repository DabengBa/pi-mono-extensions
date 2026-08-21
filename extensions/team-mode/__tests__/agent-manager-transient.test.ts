import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
	DEFAULT_MODEL_CONFIG,
	invalidateModelConfigCache,
	saveModelConfig,
} from "../core/model-config.ts";
import { TeamMateStore } from "../core/store.ts";
import {
	AgentManager,
	isActivityEvent,
	isStartupFailure,
} from "../managers/agent-manager.ts";

async function withManager(fn: (manager: AgentManager, store: TeamMateStore) => Promise<void>) {
	const root = await mkdtemp(path.join(tmpdir(), "team-mode-test-"));
	try {
		const store = new TeamMateStore(root);
		const manager = new AgentManager({
			store,
			getParentSessionId: () => "parent",
			getDefaultCwd: () => process.cwd(),
			runTransientSession: async (opts) => ({
				teammateId: opts.id,
				name: opts.name,
				description: opts.description,
				status: "completed",
				result: `TRANSIENT:${opts.message}`,
				exitCode: 0,
				provider: opts.provider,
				model: opts.model,
				thinkingLevel: opts.thinkingLevel,
				modelRationale: opts.modelRationale,
				runtime: "transient",
			}),
		});
		await fn(manager, store);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("startup fallback detection", () => {
	test("does not treat error-only assistant messages as activity", () => {
		assert.equal(
			isActivityEvent({
				type: "assistant_message",
				text: "[assistant error] model not found",
				errorMessage: "model not found",
			}),
			false,
		);
		assert.equal(isActivityEvent({ type: "assistant_message", text: "working" }), true);
	});

	test("retries errors and empty non-zero exits, but not output or aborts", () => {
		assert.equal(
			isStartupFailure({
				finalMessage: "",
				exitCode: 1,
				exitSignal: null,
				stderr: "",
				errorMessage: "model not found",
			}),
			true,
		);
		assert.equal(
			isStartupFailure({ finalMessage: "", exitCode: 1, exitSignal: null, stderr: "" }),
			true,
		);
		assert.equal(
			isStartupFailure({ finalMessage: "done", exitCode: 1, exitSignal: null, stderr: "" }),
			false,
		);
		assert.equal(
			isStartupFailure({ finalMessage: "", exitCode: 1, exitSignal: "SIGTERM", stderr: "" }),
			false,
		);
	});
});

describe("AgentManager transient runtime", () => {
	test("routes transient spawn without durable teammate record", async () => {
		await withManager(async (manager, store) => {
			const result = await manager.spawn({
				description: "quick scan",
				prompt: "Summarize files",
				runtime: "transient",
			});

			assert.equal(result.status, "completed");
			assert.equal(result.runtime, "transient");
			assert.match(result.result, /Task: quick scan/);
			assert.deepEqual(await store.listTeammates(), []);
			assert.deepEqual(await store.getNameIndex("parent"), {});
		});
	});

	test("retries the next v2 candidate after a startup failure", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "team-mode-fallback-test-"));
		const previousStorageRoot = process.env.PI_TEAM_MATE_STORAGE_ROOT;
		process.env.PI_TEAM_MATE_STORAGE_ROOT = root;
		invalidateModelConfigCache();
		try {
			await saveModelConfig(
				{
					...DEFAULT_MODEL_CONFIG,
					version: 2,
					provider: "openai-codex",
					roleTiers: {},
					providers: {
						"openai-codex": {
							md: [
								{ model: "openai-codex/primary", effort: "low" },
								{ model: "openai-codex/fallback", effort: "high" },
							],
						},
					},
				},
				root,
			);

			const attempts: string[] = [];
			const manager = new AgentManager({
				store: new TeamMateStore(root),
				getParentSessionId: () => "parent",
				getDefaultCwd: () => process.cwd(),
				runTransientSession: async (opts) => {
					attempts.push(`${opts.model}:${opts.thinkingLevel}`);
					return {
						teammateId: opts.id,
						name: opts.name,
						description: opts.description,
						status: opts.model === "primary" ? "failed" : "completed",
						result: opts.model === "primary" ? "[transient error] unavailable" : "ok",
						startupFailure: opts.model === "primary",
						exitCode: opts.model === "primary" ? null : 0,
						runtime: "transient",
					};
				},
			});

			const result = await manager.spawn({
				description: "fallback",
				prompt: "try models",
				runtime: "transient",
				subagentType: "backend",
			});
			assert.equal(result.result, "ok");
			assert.deepEqual(attempts, ["primary:low", "fallback:high"]);
		} finally {
			if (previousStorageRoot === undefined) delete process.env.PI_TEAM_MATE_STORAGE_ROOT;
			else process.env.PI_TEAM_MATE_STORAGE_ROOT = previousStorageRoot;
			invalidateModelConfigCache();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects transient-incompatible options", async () => {
		await withManager(async (manager) => {
			await assert.rejects(
				() => manager.spawn({ description: "x", prompt: "p", runtime: "transient", isolation: "worktree" }),
				/does not support isolation "worktree"/,
			);
			await assert.rejects(
				() => manager.spawn({ description: "x", prompt: "p", runtime: "transient", background: true }),
				/does not support run_in_background/,
			);
			await assert.rejects(
				() => manager.spawn({ description: "x", prompt: "p", runtime: "transient", teamId: "team-1" }),
				/does not support team_name/,
			);
			await assert.rejects(
				() => manager.spawn({ description: "x", prompt: "p", runtime: "transient", name: "later" }),
				/does not support name/,
			);
		});
	});
});
