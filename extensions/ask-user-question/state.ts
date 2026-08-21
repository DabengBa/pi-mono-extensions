/**
 * Answer store for ask-user-question.
 *
 * Holds all mutable form state in one object so tab switching, defaults and
 * submission can't desynchronise across parallel maps. No TUI imports — this
 * module is pure and unit-testable.
 */

import {
	type Answer,
	customValue,
	type NormalizedQuestion,
	REPHRASE_SIGNAL,
	type QuestionOption,
} from "./schema.js";

interface RadioAnswer {
	value: string;
	label: string;
	wasCustom: boolean;
	needsRephrase: boolean;
}

interface CustomEntry {
	value: string;
	needsRephrase: boolean;
}

export class AnswerStore {
	private readonly radio = new Map<string, RadioAnswer>();
	private readonly checked = new Map<string, Set<string>>();
	private readonly custom = new Map<string, CustomEntry>();
	private readonly text = new Map<string, string>();
	private readonly comments = new Map<string, string>();

	constructor(private readonly questions: NormalizedQuestion[]) {
		for (const q of questions) {
			if (q.type === "checkbox") {
				this.checked.set(q.id, new Set(Array.isArray(q.default) ? q.default : []));
			} else if (q.type === "text" && typeof q.default === "string") {
				this.text.set(q.id, q.default);
			} else if (q.type === "radio" && typeof q.default === "string") {
				const opt = q.options.find((o) => o.value === q.default);
				if (opt) this.setRadio(q.id, opt);
			}
		}
	}

	// ── Radio ────────────────────────────────────────────────────────────────

	getRadio(id: string): RadioAnswer | undefined {
		return this.radio.get(id);
	}

	setRadio(id: string, opt: QuestionOption): void {
		this.radio.set(id, { value: opt.value, label: opt.label, wasCustom: false, needsRephrase: false });
	}

	setRadioCustom(id: string, text: string): void {
		const { value, needsRephrase } = customValue(text);
		this.radio.set(id, {
			value,
			label: needsRephrase ? "(rephrase requested)" : value,
			wasCustom: true,
			needsRephrase,
		});
	}

	// ── Checkbox ─────────────────────────────────────────────────────────────

	getChecked(id: string): Set<string> {
		return this.checked.get(id) ?? new Set();
	}

	toggleChecked(id: string, value: string): void {
		const set = this.checked.get(id) ?? new Set<string>();
		if (set.has(value)) set.delete(value);
		else set.add(value);
		this.checked.set(id, set);
	}

	// ── Custom "Other..." (checkbox) ─────────────────────────────────────────

	getCustom(id: string): CustomEntry | undefined {
		return this.custom.get(id);
	}

	setCustom(id: string, text: string): void {
		this.custom.set(id, customValue(text));
	}

	/** Prefill text for reopening the "Other..." editor — never echoes the rephrase sentinel. */
	customDraft(q: NormalizedQuestion): string {
		if (q.type === "radio") {
			const a = this.radio.get(q.id);
			return a?.wasCustom && !a.needsRephrase ? a.value : "";
		}
		const entry = this.custom.get(q.id);
		return entry && !entry.needsRephrase ? entry.value : "";
	}

	// ── Text ─────────────────────────────────────────────────────────────────

	getText(id: string): string {
		return this.text.get(id) ?? "";
	}

	setText(id: string, value: string): void {
		const trimmed = value.trim();
		if (trimmed) this.text.set(id, trimmed);
		else this.text.delete(id);
	}

	// ── Comments ─────────────────────────────────────────────────────────────

	getComment(id: string): string {
		return this.comments.get(id) ?? "";
	}

	setComment(id: string, value: string): void {
		const trimmed = value.trim();
		if (trimmed) this.comments.set(id, trimmed);
		else this.comments.delete(id);
	}

	// ── Queries ──────────────────────────────────────────────────────────────

	isAnswered(q: NormalizedQuestion): boolean {
		if (q.type === "radio") return this.radio.has(q.id);
		if (q.type === "checkbox") return this.getChecked(q.id).size > 0 || this.custom.has(q.id);
		return this.getText(q.id).length > 0;
	}

	allRequiredAnswered(): boolean {
		return this.questions.every((q) => !q.required || this.isAnswered(q));
	}

	missingLabels(): string[] {
		return this.questions.filter((q) => q.required && !this.isAnswered(q)).map((q) => q.label);
	}

	/** Display strings for a checkbox question, custom entry last. */
	checkboxDisplay(q: NormalizedQuestion): string[] {
		const values = [...this.getChecked(q.id)];
		const entry = this.custom.get(q.id);
		if (entry) values.push(entry.needsRephrase ? "(rephrase requested)" : entry.value);
		return values;
	}

	// ── Output ───────────────────────────────────────────────────────────────

	toAnswers(): Answer[] {
		return this.questions.map((q) => {
			const comment = this.getComment(q.id);
			const withComment = <T extends Answer>(a: T): T => (comment ? { ...a, comment } : a);

			if (q.type === "radio") {
				const a = this.radio.get(q.id);
				return withComment({
					id: q.id,
					type: "radio",
					value: a?.value ?? "",
					wasCustom: a?.wasCustom ?? false,
					...(a?.needsRephrase ? { needsRephrase: true } : {}),
				});
			}

			if (q.type === "checkbox") {
				const entry = this.custom.get(q.id);
				const values = [...this.getChecked(q.id)];
				if (entry) values.push(entry.value);
				return withComment({
					id: q.id,
					type: "checkbox",
					value: values,
					wasCustom: entry != null,
					...(entry?.needsRephrase ? { needsRephrase: true } : {}),
				});
			}

			return withComment({ id: q.id, type: "text", value: this.getText(q.id), wasCustom: true });
		});
	}
}

/** Render an answer as a single human-readable line. */
export function formatAnswer(answer: Answer, label: string): string {
	const suffix = answer.comment ? `\n  Comment: ${answer.comment}` : "";

	if (answer.needsRephrase) {
		return `${label}: ${REPHRASE_SIGNAL}${suffix}`;
	}
	if (answer.type === "checkbox") {
		const values = Array.isArray(answer.value) ? answer.value : [answer.value];
		return `${label}: ${values.length ? values.join(", ") : "(none selected)"}${suffix}`;
	}
	if (answer.type === "radio") {
		return `${label}: ${answer.wasCustom ? "(wrote) " : ""}${answer.value}${suffix}`;
	}
	return `${label}: ${answer.value || "(empty)"}${suffix}`;
}
