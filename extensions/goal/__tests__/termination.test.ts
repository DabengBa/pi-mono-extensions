import assert from "node:assert/strict";
import { describe, test } from "node:test";

import goalExtension from "../index.ts";
import { createGoalEvent, GOAL_EVENT } from "../state.ts";

describe("goal update termination", () => {
	test("keeps terminal updates non-terminating for teammates only", async () => {
		const tools = new Map<string, { execute: (...args: any[]) => Promise<{ terminate?: boolean }> }>();
		const pi = {
			appendEntry() {},
			on() {},
			registerCommand() {},
			registerTool(tool: { name: string; execute: (...args: any[]) => Promise<{ terminate?: boolean }> }) {
				tools.set(tool.name, tool);
			},
		};
		goalExtension(pi as any);

		const created = createGoalEvent("return a worker result", "manual");
		const ctx = {
			sessionManager: { getBranch: () => [{ type: "custom", customType: GOAL_EVENT, data: created }] },
			ui: { setStatus() {}, setWidget() {} },
		};
		const updateGoal = tools.get("update_goal");
		assert.ok(updateGoal);

		const previous = process.env.PI_TEAM_MATE_SUBPROCESS;
		try {
			delete process.env.PI_TEAM_MATE_SUBPROCESS;
			assert.equal((await updateGoal.execute("call", { status: "completed" }, undefined, undefined, ctx)).terminate, true);

			process.env.PI_TEAM_MATE_SUBPROCESS = "1";
			assert.equal((await updateGoal.execute("call", { status: "completed" }, undefined, undefined, ctx)).terminate, false);
			assert.equal((await updateGoal.execute("call", { status: "active" }, undefined, undefined, ctx)).terminate, false);
		} finally {
			if (previous === undefined) delete process.env.PI_TEAM_MATE_SUBPROCESS;
			else process.env.PI_TEAM_MATE_SUBPROCESS = previous;
		}
	});
});
