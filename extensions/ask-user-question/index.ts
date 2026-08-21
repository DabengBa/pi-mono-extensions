/**
 * ask-user-question — Interactive form tool for pi
 *
 * A tool the LLM can call to ask the user one or more questions using rich
 * form controls: radio buttons, checkboxes, and text inputs. Each question
 * type supports an optional "Other..." escape hatch for custom input.
 *
 * Question types:
 *   - radio:    Single-select from options (with optional custom "Other")
 *   - checkbox: Multi-select from options (with optional custom "Other")
 *   - text:     Free-form text input
 *
 * Renders as an interactive panel in the TUI, and degrades to sequential
 * select/input dialogs in UIs without a custom-component surface.
 *
 * Layout:
 *   schema.ts — tool parameters, types, normalization
 *   state.ts  — answer store and result formatting
 *   form.ts   — interactive TUI panel
 *   dialog.ts — fallback dialog flow
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { runDialogForm } from "./dialog.js";
import { runTuiForm } from "./form.js";
import {
	type AskUserQuestionInput,
	AskUserQuestionParams,
	type FormResult,
	normalize,
	REPHRASE_SIGNAL,
} from "./schema.js";
import { formatAnswer } from "./state.js";

const CHECK = "✓";

function errorResult(msg: string): { content: { type: "text"; text: string }[]; details: FormResult } {
	return {
		content: [{ type: "text", text: msg }],
		details: { questions: [], answers: [], cancelled: true },
	};
}

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User",
		description: `Ask the user one or more questions using an interactive form. Supports three question types:
- **radio**: Single-select from predefined options (like multiple choice)
- **checkbox**: Multi-select from options (pick all that apply)
- **text**: Free-form text input

Each radio/checkbox question can include an "Other" option that lets the user type a custom answer, and an optional comment row to qualify their choice. If the user submits "Other" blank, the result says they want the question rephrased or split — ask a better question rather than retrying the same one.

Use this tool when you need user input to proceed — for clarifying requirements, getting preferences, confirming decisions, or choosing between alternatives. Prefer this over asking plain-text questions in your response.`,
		promptSnippet: "Ask the user interactive questions with radio, checkbox, or text inputs",
		promptGuidelines: [
			"Use ask_user_question instead of asking questions in plain text when you need structured user input.",
			"Prefer radio for single-choice, checkbox for multi-choice, text for open-ended answers.",
			"Always include an 'Other' escape hatch (allowOther: true) unless the options are exhaustive.",
			"Group related questions in a single call rather than making multiple separate calls.",
			"Set allowComment: true when the reasoning behind a choice matters as much as the choice.",
			"If an answer asks for a rephrase, reformulate or split that question instead of repeating it.",
		],
		parameters: AskUserQuestionParams as any,
		// The form owns the terminal while open; concurrent tool calls would fight over it.
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			const input = params as AskUserQuestionInput;
			if (!input.questions.length) {
				return errorResult("Error: No questions provided");
			}
			if (signal?.aborted) {
				return errorResult("Cancelled before the form was shown");
			}

			const questions = normalize(input.questions);

			// ctx.ui.custom resolves to undefined outside the interactive TUI.
			const result =
				(await runTuiForm(ctx, input.title, input.description, questions, signal)) ??
				(await runDialogForm(ctx, input.title, questions, signal));

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: signal?.aborted ? "Form aborted" : "User cancelled the form" }],
					details: result,
				};
			}

			const lines = result.answers.map((a) => {
				const q = questions.find((x) => x.id === a.id);
				return formatAnswer(a, q?.label || a.id);
			});
			if (result.answers.some((a) => a.needsRephrase)) {
				lines.push("", "Note: rephrase or split the flagged question(s) instead of asking again as written.");
			}

			return { content: [{ type: "text", text: lines.join("\n") }], details: result };
		},

		// ── Custom rendering ─────────────────────────────────────────────────

		renderCall(args, theme, _context) {
			const input = args as Partial<AskUserQuestionInput>;
			const qs = input.questions || [];
			let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
			if (input.title) text += `${theme.fg("accent", input.title)} `;
			text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
			const types = [...new Set(qs.map((q) => q.type))].join(", ");
			if (types) text += theme.fg("dim", ` (${types})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as FormResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			const lines: string[] = [];
			for (const a of details.answers) {
				const label = details.questions.find((q) => q.id === a.id)?.label || a.id;
				const mark = theme.fg(a.needsRephrase ? "warning" : "success", CHECK);
				let value: string;

				if (a.needsRephrase) {
					value = theme.fg("warning", "needs rephrasing");
				} else if (a.type === "checkbox") {
					const values = Array.isArray(a.value) ? a.value : [a.value];
					value = values.length ? values.join(", ") : theme.fg("dim", "(none)");
				} else if (a.type === "radio") {
					value = `${a.wasCustom ? theme.fg("dim", "(wrote) ") : ""}${a.value}`;
				} else {
					value = a.value ? String(a.value) : theme.fg("dim", "(empty)");
				}

				lines.push(`${mark} ${theme.fg("accent", label)}: ${value}`);
				if (a.comment) lines.push(`  ${theme.fg("dim", `✎ ${a.comment}`)}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

export { REPHRASE_SIGNAL };
