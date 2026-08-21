/**
 * Schema, types and normalization for ask-user-question.
 *
 * Kept free of TUI imports so it can be unit-tested in isolation.
 */

import { Type } from "@sinclair/typebox";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Returned when the user opens "Other..." and submits it blank.
 *
 * A blank custom answer is not an empty answer — it means the question as
 * written could not be answered, so the agent should rephrase, split it, or
 * ask a follow-up instead of treating it as a non-response.
 */
export const REPHRASE_SIGNAL = "(user asked to rephrase, split, or follow up on this question)";

/** No trailing ellipsis: labels are always rendered in full, never clipped. */
export const OTHER_LABEL = "Other";

// ─── Types ───────────────────────────────────────────────────────────────────

export type QuestionType = "radio" | "checkbox" | "text";

export interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

export interface Question {
	id: string;
	type: QuestionType;
	prompt: string;
	label?: string;
	options?: QuestionOption[];
	allowOther?: boolean;
	allowComment?: boolean;
	required?: boolean;
	placeholder?: string;
	default?: string | string[];
}

export interface NormalizedQuestion extends Question {
	label: string;
	options: QuestionOption[];
	allowOther: boolean;
	allowComment: boolean;
	required: boolean;
}

export interface Answer {
	id: string;
	type: QuestionType;
	value: string | string[];
	wasCustom: boolean;
	/** True when the user opened "Other..." and submitted it blank. */
	needsRephrase?: boolean;
	comment?: string;
}

export interface FormResult {
	title?: string;
	questions: NormalizedQuestion[];
	answers: Answer[];
	cancelled: boolean;
}

export interface AskUserQuestionInput {
	title?: string;
	description?: string;
	questions: Question[];
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const OptionSchema = Type.Object({
	value: Type.String({ description: "Value returned when selected" }),
	label: Type.String({ description: "Display label" }),
	description: Type.Optional(Type.String({ description: "Help text shown below the label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	type: Type.Unsafe<QuestionType>({
		type: "string",
		enum: ["radio", "checkbox", "text"],
		description: "Question type: radio (single-select), checkbox (multi-select), or text (free input)",
	}),
	prompt: Type.String({ description: "The question text to display" }),
	label: Type.Optional(Type.String({ description: "Short label for tab bar (defaults to Q1, Q2, Q3)" })),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Options for radio/checkbox types" })),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Add an 'Other' option with text input (default: true for radio/checkbox)" }),
	),
	allowComment: Type.Optional(
		Type.Boolean({
			description:
				"Add an optional free-text comment row so the user can qualify their choice (default: false, radio/checkbox only)",
		}),
	),
	required: Type.Optional(Type.Boolean({ description: "Whether an answer is required (default: true)" })),
	placeholder: Type.Optional(Type.String({ description: "Placeholder for text inputs" })),
	default: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description: "Default value(s). String for radio/text, string[] for checkbox",
		}),
	),
});

export const AskUserQuestionParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Form title displayed at the top" })),
	description: Type.Optional(Type.String({ description: "Brief context or instructions shown under the title" })),
	questions: Type.Array(QuestionSchema, {
		description:
			"One or more questions to ask. Use radio for single-select, checkbox for multi-select, text for free input",
	}),
});

// ─── Normalization ───────────────────────────────────────────────────────────

export function normalize(questions: Question[]): NormalizedQuestion[] {
	return questions.map((q, i) => ({
		...q,
		label: q.label || `Q${i + 1}`,
		options: q.options || [],
		allowOther: q.type === "text" ? false : q.allowOther !== false,
		allowComment: q.type === "text" ? false : q.allowComment === true,
		required: q.required !== false,
	}));
}

/** Resolve a custom "Other..." submission into its stored value. */
export function customValue(text: string): { value: string; needsRephrase: boolean } {
	const trimmed = text.trim();
	return trimmed ? { value: trimmed, needsRephrase: false } : { value: REPHRASE_SIGNAL, needsRephrase: true };
}
