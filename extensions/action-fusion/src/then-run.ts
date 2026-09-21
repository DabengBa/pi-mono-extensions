import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import {
	type AgentToolResult,
	type BashToolOptions,
	createBashToolDefinition,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { withFusedFileQueue } from "./file-queue.ts";
import { resolveFusionPath } from "./path.ts";

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";

export interface ThenRunInput {
	readonly command: string;
	readonly timeout?: number;
}

const THEN_RUN_DESCRIPTION =
	"Command to run only after the file mutation succeeds. The command is passed to Pi's bash tool unchanged. " +
	"A non-zero exit, timeout, or abort is reported as a tool error, but the mutation is not rolled back. " +
	"The command is skipped when the mutation fails or the file changes in between.";

export function createThenRunSchema() {
	return Type.Optional(
		Type.Object(
			{
				command: Type.String({ description: "Shell command to run after the mutation succeeds" }),
				timeout: Type.Optional(
					Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
				),
			},
			{ description: THEN_RUN_DESCRIPTION },
		),
	);
}

/**
 * Read `then_run` from model-supplied arguments. `null` means "not requested":
 * providers using strict JSON-schema sampling send optional fields as `null`.
 */
export function normalizeThenRun(value: unknown): ThenRunInput | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object") throw new Error("Invalid then_run: expected an object with a command.");
	const { command, timeout } = value as { command?: unknown; timeout?: unknown };
	if (typeof command !== "string") throw new Error("Invalid then_run: command must be a string.");
	if (timeout === undefined || timeout === null) return { command };
	if (typeof timeout !== "number") throw new Error("Invalid then_run: timeout must be a number of seconds.");
	return { command, timeout };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

async function fileSha256(filePath: string): Promise<string> {
	const stats = await stat(filePath);
	if (!stats.isFile()) {
		throw new Error(`target is not a regular file: ${filePath}`);
	}
	return createHash("sha256")
		.update(await readFile(filePath))
		.digest("hex");
}

/**
 * Confirm the target still holds the content the mutation produced before the
 * command runs. Two hashes with one event-loop turn in between only observe an
 * interleaving that already happened; this is not a transaction and it cannot
 * stop a later external write. A target that vanished, stopped being a regular
 * file, or is unreadable also skips the command.
 */
export async function assertUnchangedBeforeCommand(
	filePath: string,
	yieldForInterference: () => Promise<void> = () => new Promise<void>((resolve) => setImmediate(resolve)),
): Promise<void> {
	try {
		const mutationHash = await fileSha256(filePath);
		await yieldForInterference();
		const commandHash = await fileSha256(filePath);
		if (mutationHash !== commandHash) {
			throw new Error("target content changed after the fused mutation");
		}
	} catch (error: unknown) {
		throw new Error(`${THEN_RUN_SKIPPED} ${errorText(error)}; the command was not run.`);
	}
}

export interface FusedMutationOptions<TDetails> {
	readonly toolCallId: string;
	/** Raw `path` argument of the tool call, resolved like the native tool resolves it. */
	readonly path: string;
	readonly thenRun: ThenRunInput | undefined;
	readonly signal: AbortSignal | undefined;
	readonly ctx: ExtensionContext;
	/** Apply the native file mutation. */
	readonly mutate: () => Promise<AgentToolResult<TDetails>>;
	/** Passed to Pi's bash definition; tests use it to observe command and timeout forwarding. */
	readonly bashOptions?: BashToolOptions;
	/** Test seam for the window between the two content hashes. Default: one `setImmediate` turn. */
	readonly yieldForInterference?: () => Promise<void>;
}

/**
 * Apply one file mutation and, when the model asked for one, run its follow-up
 * command before returning a single observation. Both steps run inside one
 * fused queue slot for the resolved target.
 */
export async function executeMutationThenRun<TDetails>(
	options: FusedMutationOptions<TDetails>,
): Promise<AgentToolResult<TDetails>> {
	const { toolCallId, path, thenRun, signal, ctx, mutate, bashOptions, yieldForInterference } = options;
	const absolutePath = resolveFusionPath(ctx.cwd, path);

	return withFusedFileQueue(absolutePath, async () => {
		let mutationResult: AgentToolResult<TDetails>;
		try {
			mutationResult = await mutate();
		} catch (error: unknown) {
			if (thenRun === undefined) throw error;
			throw new Error(
				`${errorText(error)}\n\n${THEN_RUN_SKIPPED} The file mutation did not complete successfully; the command was not run.`,
			);
		}

		if (thenRun === undefined) return mutationResult;

		await assertUnchangedBeforeCommand(absolutePath, yieldForInterference);

		const bash = createBashToolDefinition(ctx.cwd, bashOptions);
		try {
			const bashResult = await bash.execute(`${toolCallId}:then_run`, thenRun, signal, undefined, ctx);
			const output = resultText(bashResult);
			return {
				...mutationResult,
				content: [
					...mutationResult.content,
					{ type: "text", text: output ? `${THEN_RUN_SUCCEEDED}\n${output}` : THEN_RUN_SUCCEEDED },
				],
			};
		} catch (error: unknown) {
			const mutationOutput = resultText(mutationResult);
			throw new Error([mutationOutput, THEN_RUN_FAILED, errorText(error)].filter(Boolean).join("\n\n"));
		}
	});
}
