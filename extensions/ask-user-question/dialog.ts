/**
 * Fallback flow for UIs without a custom-component surface (RPC hosts, etc).
 *
 * ctx.ui.custom() resolves to undefined outside the interactive TUI, so instead
 * of failing we drive the same form through sequential select/input dialogs.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type FormResult, type NormalizedQuestion, OTHER_LABEL } from "./schema.js";
import { AnswerStore } from "./state.js";

const DONE_LABEL = "Done selecting";

function dialogOpts(signal?: AbortSignal): { signal: AbortSignal } | undefined {
	return signal ? { signal } : undefined;
}

function promptText(q: NormalizedQuestion): string {
	return q.required ? `${q.prompt} *` : q.prompt;
}

/** Ensure synthetic labels can't collide with real option labels. */
function uniqueLabel(base: string, taken: Set<string>): string {
	let label = base;
	let n = 2;
	while (taken.has(label)) label = `${base} (${n++})`;
	taken.add(label);
	return label;
}

async function askOther(
	ctx: ExtensionContext,
	q: NormalizedQuestion,
	prefill: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return await ctx.ui.input(
		`${q.prompt} — other`,
		prefill || "Your answer (blank = ask me to rephrase)",
		dialogOpts(signal),
	);
}

async function askComment(
	ctx: ExtensionContext,
	q: NormalizedQuestion,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return await ctx.ui.input(`${q.prompt} — comment`, "Optional comment", dialogOpts(signal));
}

async function askRadio(
	ctx: ExtensionContext,
	q: NormalizedQuestion,
	store: AnswerStore,
	signal?: AbortSignal,
): Promise<boolean> {
	const byLabel = new Map(q.options.map((o) => [o.label, o]));
	const taken = new Set(byLabel.keys());
	const otherLabel = q.allowOther ? uniqueLabel(OTHER_LABEL, taken) : undefined;

	const choices = [...byLabel.keys(), ...(otherLabel ? [otherLabel] : [])];
	const picked = choices.length
		? await ctx.ui.select(promptText(q), choices, dialogOpts(signal))
		: await ctx.ui.input(promptText(q), q.placeholder, dialogOpts(signal));
	if (picked === undefined) return false;

	if (otherLabel && picked === otherLabel) {
		const text = await askOther(ctx, q, store.customDraft(q), signal);
		if (text === undefined) return false;
		store.setRadioCustom(q.id, text);
		return true;
	}

	const opt = byLabel.get(picked);
	if (opt) store.setRadio(q.id, opt);
	else store.setRadioCustom(q.id, picked);
	return true;
}

async function askCheckbox(
	ctx: ExtensionContext,
	q: NormalizedQuestion,
	store: AnswerStore,
	signal?: AbortSignal,
): Promise<boolean> {
	const byLabel = new Map(q.options.map((o) => [o.label, o]));
	const taken = new Set(byLabel.keys());
	const otherLabel = q.allowOther ? uniqueLabel(OTHER_LABEL, taken) : undefined;
	const doneLabel = uniqueLabel(DONE_LABEL, taken);

	while (true) {
		const selected = store.getChecked(q.id);
		const choices = [
			...[...byLabel.entries()].map(([label, opt]) => (selected.has(opt.value) ? `✓ ${label}` : label)),
			...(otherLabel ? [otherLabel] : []),
			doneLabel,
		];
		const picked = await ctx.ui.select(promptText(q), choices, dialogOpts(signal));
		if (picked === undefined) return false;
		if (picked === doneLabel) return true;

		if (otherLabel && picked === otherLabel) {
			const text = await askOther(ctx, q, store.customDraft(q), signal);
			if (text === undefined) return false;
			store.setCustom(q.id, text);
			continue;
		}

		const opt = byLabel.get(picked.replace(/^✓ /, ""));
		if (opt) store.toggleChecked(q.id, opt.value);
	}
}

export async function runDialogForm(
	ctx: ExtensionContext,
	title: string | undefined,
	questions: NormalizedQuestion[],
	signal?: AbortSignal,
): Promise<FormResult> {
	const store = new AnswerStore(questions);
	const cancelled = (): FormResult => ({ title, questions, answers: store.toAnswers(), cancelled: true });

	for (const q of questions) {
		if (signal?.aborted) return cancelled();

		if (q.type === "text") {
			const value = await ctx.ui.input(promptText(q), q.placeholder, dialogOpts(signal));
			if (value === undefined) return cancelled();
			store.setText(q.id, value);
			continue;
		}

		const ok = q.type === "radio" ? await askRadio(ctx, q, store, signal) : await askCheckbox(ctx, q, store, signal);
		if (!ok) return cancelled();

		if (q.allowComment) {
			const comment = await askComment(ctx, q, signal);
			if (comment === undefined) return cancelled();
			store.setComment(q.id, comment);
		}
	}

	return { title, questions, answers: store.toAnswers(), cancelled: false };
}
