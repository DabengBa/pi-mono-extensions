/**
 * Action Fusion — fuse a file mutation with its follow-up command.
 *
 * Coding agents repeatedly spend two round-trips on "edit the file, then run a
 * command to verify it". This extension overrides the native `edit` and `write`
 * tools with versions that accept an optional `then_run` object: the mutation
 * runs first, the file is checked for external changes, and Pi's own bash tool
 * runs the command before a single combined result is returned.
 *
 * Everything else is inherited from the native definitions — their schemas,
 * prompt text, argument shim, details shape, and renderers — so a call without
 * `then_run` behaves exactly like the built-in tool.
 */

import {
	createEditToolDefinition,
	createWriteToolDefinition,
	type EditToolDetails,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createThenRunSchema, executeMutationThenRun, normalizeThenRun } from "./then-run.ts";

export default function registerActionFusion(pi: ExtensionAPI): void {
	const baseEdit = createEditToolDefinition(process.cwd());
	const baseWrite = createWriteToolDefinition(process.cwd());

	const editParameters = Type.Object({
		...baseEdit.parameters.properties,
		then_run: createThenRunSchema(),
	});
	const writeParameters = Type.Object({
		...baseWrite.parameters.properties,
		then_run: createThenRunSchema(),
	});

	pi.registerTool<typeof editParameters, EditToolDetails | undefined>({
		...baseEdit,
		parameters: editParameters,
		async execute(toolCallId, input, signal, onUpdate, ctx) {
			const { then_run: thenRun, ...editInput } = input;
			return executeMutationThenRun<EditToolDetails | undefined>({
				toolCallId,
				path: editInput.path,
				thenRun: normalizeThenRun(thenRun),
				signal,
				ctx,
				mutate: () => baseEdit.execute(toolCallId, editInput, signal, onUpdate, ctx),
			});
		},
	});

	pi.registerTool<typeof writeParameters, undefined>({
		...baseWrite,
		parameters: writeParameters,
		async execute(toolCallId, input, signal, onUpdate, ctx) {
			const { then_run: thenRun, ...writeInput } = input;
			return executeMutationThenRun<undefined>({
				toolCallId,
				path: writeInput.path,
				thenRun: normalizeThenRun(thenRun),
				signal,
				ctx,
				mutate: () => baseWrite.execute(toolCallId, writeInput, signal, onUpdate, ctx),
			});
		},
	});
}

export { executeMutationThenRun, THEN_RUN_FAILED, THEN_RUN_SKIPPED, THEN_RUN_SUCCEEDED } from "./then-run.ts";
export type { ThenRunInput } from "./then-run.ts";
