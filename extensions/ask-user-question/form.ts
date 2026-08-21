/**
 * Interactive TUI form for ask-user-question.
 *
 * All key handling goes through the KeybindingsManager so user overrides in
 * keybindings.json apply here too.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	type KeybindingsManager,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type FormResult, type NormalizedQuestion, OTHER_LABEL } from "./schema.js";
import { AnswerStore } from "./state.js";

const SYM = {
	radioOn: "◉",
	radioOff: "○",
	checkOn: "☑",
	checkOff: "☐",
	pointer: "❯",
	check: "✓",
	pencil: "✎",
};

/** Editing target within a question. */
type EditMode = "other" | "comment" | null;

/**
 * Wrap text to a visible width, never truncating.
 *
 * Delegates to pi-tui so ANSI codes, wide (CJK) glyphs and over-long unbreakable
 * words are all handled — a word longer than the width is broken across lines
 * rather than clipped. Questions and options must always be readable in full.
 */
function wrapText(text: string, maxWidth: number): string[] {
	return wrapTextWithAnsi(text, Math.max(1, maxWidth));
}

/**
 * Emit `prefix + body`, wrapping the body and indenting continuation lines to
 * `continuation` so wrapped text stays visually attached to its label.
 */
function addHanging(
	add: (s: string) => void,
	maxW: number,
	prefix: string,
	body: string,
	continuation: string,
): void {
	const wrapped = wrapText(body, Math.max(1, maxW - visibleWidth(prefix)));
	wrapped.forEach((line, i) => add(i === 0 ? `${prefix}${line}` : `${continuation}${line}`));
}

function editorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

export async function runTuiForm(
	ctx: ExtensionContext,
	title: string | undefined,
	description: string | undefined,
	questions: NormalizedQuestion[],
	signal?: AbortSignal,
): Promise<FormResult | undefined> {
	const isMulti = questions.length > 1;
	const totalTabs = questions.length + (isMulti ? 1 : 0); // +1 for Submit tab

	return await ctx.ui.custom<FormResult>((tui, theme, kb: KeybindingsManager, done) => {
		const store = new AnswerStore(questions);

		let currentTab = 0;
		let cursorIdx = 0;
		let editMode: EditMode = null;
		let editQuestionId: string | null = null;
		let cachedLines: string[] | undefined;

		// ── Abort wiring ─────────────────────────────────────────────────────
		let settled = false;
		const finish = (result: FormResult) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			done(result);
		};
		function onAbort() {
			finish({ title, questions, answers: store.toAnswers(), cancelled: true });
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) queueMicrotask(onAbort);

		const editor = new Editor(tui, editorTheme(theme));

		// ── Row model ────────────────────────────────────────────────────────
		// Rows for radio/checkbox: [...options, other?, comment?]

		const curQ = (): NormalizedQuestion | undefined => questions[currentTab];
		const otherRow = (q: NormalizedQuestion): number => (q.allowOther ? q.options.length : -1);
		const commentRow = (q: NormalizedQuestion): number =>
			q.allowComment ? q.options.length + (q.allowOther ? 1 : 0) : -1;
		const rowCount = (q: NormalizedQuestion): number =>
			q.type === "text" ? 0 : q.options.length + (q.allowOther ? 1 : 0) + (q.allowComment ? 1 : 0);

		const isSubmitTab = () => isMulti && currentTab === questions.length;

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		/** Persist whatever the editor currently holds for the active context. */
		function commitEditor() {
			const text = editor.getText();
			if (editMode && editQuestionId) {
				const q = questions.find((x) => x.id === editQuestionId);
				if (!q) return;
				if (editMode === "comment") store.setComment(q.id, text);
				else if (q.type === "radio") store.setRadioCustom(q.id, text);
				else store.setCustom(q.id, text);
				return;
			}
			const q = curQ();
			if (q?.type === "text") store.setText(q.id, text);
		}

		function exitEditMode() {
			editMode = null;
			editQuestionId = null;
			editor.setText("");
		}

		function loadTextEditor() {
			const q = curQ();
			editor.setText(q?.type === "text" ? store.getText(q.id) : "");
		}

		function switchTab(idx: number) {
			commitEditor();
			exitEditMode();
			currentTab = ((idx % totalTabs) + totalTabs) % totalTabs;
			cursorIdx = 0;
			loadTextEditor();
			refresh();
		}

		function advance() {
			if (!isMulti) submit(false);
			else switchTab(currentTab < questions.length - 1 ? currentTab + 1 : questions.length);
		}

		function submit(cancelled: boolean) {
			commitEditor();
			finish({ title, questions, answers: store.toAnswers(), cancelled });
		}

		function startEdit(q: NormalizedQuestion, mode: Exclude<EditMode, null>) {
			editMode = mode;
			editQuestionId = q.id;
			editor.setText(mode === "comment" ? store.getComment(q.id) : store.customDraft(q));
			refresh();
		}

		// The editor clears itself before onSubmit fires, so Enter is normally
		// intercepted in handleInput. This stays as a defensive path.
		editor.onSubmit = (value) => {
			if (editMode && editQuestionId) {
				const q = questions.find((x) => x.id === editQuestionId);
				if (q) {
					if (editMode === "comment") store.setComment(q.id, value);
					else if (q.type === "radio") store.setRadioCustom(q.id, value);
					else store.setCustom(q.id, value);
				}
				const wasComment = editMode === "comment";
				exitEditMode();
				if (wasComment) refresh();
				else advance();
				return;
			}
			const q = curQ();
			if (q?.type === "text") {
				store.setText(q.id, value);
				advance();
			}
		};

		// ── Input ────────────────────────────────────────────────────────────

		const isTab = (d: string) => kb.matches(d, "tui.input.tab");
		const isConfirm = (d: string) => kb.matches(d, "tui.select.confirm") || kb.matches(d, "tui.input.submit");
		const isCancel = (d: string) => kb.matches(d, "tui.select.cancel");
		const isPrevTab = (d: string) => kb.matches(d, "tui.editor.cursorLeft");
		const isNextTab = (d: string) => kb.matches(d, "tui.editor.cursorRight");

		function handleInput(data: string) {
			// ── Editing "Other..." or a comment ──────────────────────────────
			if (editMode) {
				if (isCancel(data)) {
					exitEditMode();
					refresh();
					return;
				}
				if (isConfirm(data)) {
					const wasComment = editMode === "comment";
					commitEditor();
					exitEditMode();
					if (wasComment) refresh();
					else advance();
					return;
				}
				if (isMulti && isTab(data)) {
					commitEditor();
					exitEditMode();
					switchTab(currentTab + 1);
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			// ── Text question — editor owns most input ───────────────────────
			const q = curQ();
			if (q?.type === "text") {
				if (isConfirm(data)) {
					commitEditor();
					advance();
					return;
				}
				if (isMulti && isTab(data)) {
					commitEditor();
					switchTab(currentTab + 1);
					return;
				}
				if (isCancel(data)) {
					submit(true);
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			// ── Submit tab ───────────────────────────────────────────────────
			if (isSubmitTab()) {
				if (isCancel(data)) submit(true);
				else if (isConfirm(data) && store.allRequiredAnswered()) submit(false);
				else if (isTab(data) || isNextTab(data)) switchTab(0);
				else if (isPrevTab(data)) switchTab(currentTab - 1);
				return;
			}

			if (!q) return;

			if (isCancel(data)) {
				submit(true);
				return;
			}
			if (isMulti && (isTab(data) || isNextTab(data))) {
				switchTab(currentTab + 1);
				return;
			}
			if (isMulti && isPrevTab(data)) {
				switchTab(currentTab - 1);
				return;
			}
			if (kb.matches(data, "tui.select.up")) {
				cursorIdx = Math.max(0, cursorIdx - 1);
				refresh();
				return;
			}
			if (kb.matches(data, "tui.select.down")) {
				cursorIdx = Math.min(rowCount(q) - 1, cursorIdx + 1);
				refresh();
				return;
			}

			const onOther = cursorIdx === otherRow(q);
			const onComment = cursorIdx === commentRow(q);

			// Space toggles checkbox options. Only meaningful on an option row —
			// the Other and comment rows open an editor instead.
			if (q.type === "checkbox" && data === " " && !onOther && !onComment) {
				const opt = q.options[cursorIdx];
				if (opt) {
					store.toggleChecked(q.id, opt.value);
					refresh();
				}
				return;
			}

			if (!isConfirm(data)) return;

			if (onComment) {
				startEdit(q, "comment");
				return;
			}
			if (onOther) {
				startEdit(q, "other");
				return;
			}
			if (q.type === "radio") {
				const opt = q.options[cursorIdx];
				if (opt) {
					store.setRadio(q.id, opt);
					advance();
				}
				return;
			}
			// Checkbox: selection is already expressed via Space, so Enter means
			// "I'm done with this question" — next question, or submit if single.
			advance();
		}

		// ── Render ───────────────────────────────────────────────────────────

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const maxW = Math.min(width, 120);
			// Never truncates. Content wider than the panel wraps onto continuation
			// lines, which inherit the leading indent so wrapped text stays aligned
			// under its first line instead of falling back to column 0.
			const add = (s: string) => {
				const indent = /^[ \t]*/.exec(s)?.[0] ?? "";
				if (!indent) {
					lines.push(...wrapText(s, maxW));
					return;
				}
				addHanging(add0, maxW, indent, s.slice(indent.length), indent);
			};
			const add0 = (s: string) => lines.push(s);
			const hr = () => lines.push(theme.fg("accent", "─".repeat(maxW)));

			hr();

			if (title) add(` ${theme.fg("accent", theme.bold(title))}`);
			if (description) add(` ${theme.fg("muted", description)}`);
			if (title || description) lines.push("");

			if (isMulti) {
				renderTabs(add, maxW);
				lines.push("");
			}

			if (isSubmitTab()) {
				renderSubmitTab(add, lines, maxW);
				hr();
				cachedLines = lines;
				return lines;
			}

			const q = curQ();
			if (!q) {
				hr();
				cachedLines = lines;
				return lines;
			}

			// Prompt
			const typeTag = theme.fg(
				"dim",
				q.type === "radio" ? "[single-select]" : q.type === "checkbox" ? "[multi-select]" : "[text]",
			);
			// Reserve room for the type tag so it never forces the prompt to re-wrap.
			const tagWidth = visibleWidth(typeTag) + 1;
			const promptLines = wrapText(q.prompt, maxW - 2);
			const lastFits = visibleWidth(promptLines[promptLines.length - 1] ?? "") + tagWidth <= maxW - 2;
			promptLines.forEach((line, i) => {
				const tag = lastFits && i === promptLines.length - 1 ? ` ${typeTag}` : "";
				add(` ${theme.fg("text", theme.bold(line))}${tag}`);
			});
			if (!lastFits) add(` ${typeTag}`);
			if (q.required) add(` ${theme.fg("warning", "*required")}`);
			lines.push("");

			if (q.type === "text") renderTextInput(add, q, maxW);
			else renderOptions(add, lines, q, maxW);

			lines.push("");
			add(theme.fg("dim", ` ${footerHint(q)}`));
			hr();

			cachedLines = lines;
			return lines;
		}

		/**
		 * Tab labels are shown in full. Rather than clipping them, tabs are packed
		 * into as many rows as needed so every label stays readable.
		 */
		function renderTabs(push: (s: string) => void, maxW: number) {
			const states = questions.map((q, i) => ({
				isActive: i === currentTab,
				answered: store.isAnswered(q),
				label: q.label,
			}));
			states.push({
				isActive: currentTab === questions.length,
				answered: store.allRequiredAnswered(),
				label: "Submit",
			});

			const tabs = states.map((s) => {
				const parts = [...(s.isActive ? [SYM.pointer] : []), ...(s.answered ? [SYM.check] : [])];
				const raw = `${parts.length ? `${parts.join(" ")} ` : ""}${s.label}`;
				const styled = s.isActive
					? theme.fg("accent", theme.bold(raw))
					: theme.fg(s.answered ? "success" : "muted", raw);
				return { text: ` ${styled} `, width: visibleWidth(raw) + 2 };
			});

			const divider = theme.fg("dim", "│");
			const dividerWidth = visibleWidth("│");
			const indent = " ";
			const budget = Math.max(1, maxW - visibleWidth(indent));

			let row = "";
			let rowWidth = 0;
			const flush = () => {
				if (row) push(`${indent}${row}`);
				row = "";
				rowWidth = 0;
			};

			for (const tab of tabs) {
				const sep = row ? dividerWidth : 0;
				if (row && rowWidth + sep + tab.width > budget) flush();
				row += row ? divider + tab.text : tab.text;
				rowWidth += sep + tab.width;
			}
			flush();
		}

		function renderSubmitTab(add: (s: string) => void, lines: string[], maxW: number) {
			add(` ${theme.fg("accent", theme.bold("Review & Submit"))}`);
			lines.push("");

			for (const q of questions) {
				const label = theme.fg("muted", `${q.label}:`);
				let value: string;

				if (q.type === "radio") {
					const a = store.getRadio(q.id);
					value = a
						? `${a.wasCustom ? theme.fg("dim", "(wrote) ") : ""}${a.label}`
						: theme.fg("warning", "(unanswered)");
				} else if (q.type === "checkbox") {
					const values = store.checkboxDisplay(q);
					value = values.length ? values.join(", ") : theme.fg("warning", "(unanswered)");
				} else {
					const t = store.getText(q.id);
					value = t || theme.fg("warning", "(unanswered)");
				}

				// Hanging indent keeps long answers aligned under the first line.
				addHanging(add, maxW, ` ${label} `, value, "   ");
				const comment = store.getComment(q.id);
				if (comment) addHanging(add, maxW, `   ${theme.fg("dim", `${SYM.pencil} `)}`, theme.fg("dim", comment), "     ");
			}

			lines.push("");
			if (store.allRequiredAnswered()) add(` ${theme.fg("success", "Press Enter to submit")}`);
			else add(` ${theme.fg("warning", `Required: ${store.missingLabels().join(", ")}`)}`);

			lines.push("");
			add(theme.fg("dim", " ←→ navigate • Enter submit • Esc cancel"));
		}

		function renderTextInput(add: (s: string) => void, q: NormalizedQuestion, maxW: number) {
			if (q.placeholder && !editor.getText()) add(` ${theme.fg("dim", q.placeholder)}`);
			for (const line of editor.render(maxW - 4)) add(`  ${line}`);
		}

		/** Shared row renderer for radio and checkbox options. */
		function renderRow(
			add: (s: string) => void,
			maxW: number,
			opts: { marked: boolean; isCursor: boolean; label: string; description?: string; radio: boolean },
		) {
			const on = opts.radio ? SYM.radioOn : SYM.checkOn;
			const off = opts.radio ? SYM.radioOff : SYM.checkOff;
			const bullet = opts.marked ? theme.fg("accent", on) : theme.fg("dim", off);
			const pointer = opts.isCursor ? theme.fg("accent", SYM.pointer) : " ";
			const color = opts.isCursor ? "accent" : opts.marked ? "text" : "muted";
			const prefix = ` ${pointer} ${bullet} `;
			const prefixWidth = visibleWidth(prefix);

			wrapText(opts.label, Math.max(1, maxW - prefixWidth)).forEach((line, i) => {
				add(`${i === 0 ? prefix : " ".repeat(prefixWidth)}${theme.fg(color, line)}`);
			});
			if (opts.description) {
				for (const dl of wrapText(opts.description, Math.max(1, maxW - 6))) add(`      ${theme.fg("dim", dl)}`);
			}
		}

		function renderOptions(add: (s: string) => void, lines: string[], q: NormalizedQuestion, maxW: number) {
			const radio = q.type === "radio";
			const selected = store.getRadio(q.id);
			const checked = store.getChecked(q.id);

			q.options.forEach((opt, i) => {
				renderRow(add, maxW, {
					marked: radio ? selected?.value === opt.value && !selected.wasCustom : checked.has(opt.value),
					isCursor: i === cursorIdx,
					label: opt.label,
					description: opt.description,
					radio,
				});
			});

			if (q.allowOther) {
				const entry = radio ? undefined : store.getCustom(q.id);
				const marked = radio ? selected?.wasCustom === true : entry != null;
				const shown = radio
					? selected?.needsRephrase
						? "(rephrase requested)"
						: selected?.value
					: entry?.needsRephrase
						? "(rephrase requested)"
						: entry?.value;
				renderRow(add, maxW, {
					marked,
					isCursor: cursorIdx === otherRow(q),
					label: marked && shown ? `Other: ${shown}` : OTHER_LABEL,
					radio,
				});
			}

			if (q.allowComment) {
				const comment = store.getComment(q.id);
				const isCursor = cursorIdx === commentRow(q);
				const pointer = isCursor ? theme.fg("accent", SYM.pointer) : " ";
				const prefix = ` ${pointer} ${theme.fg("dim", SYM.pencil)} `;
				const label = comment ? `Comment: ${comment}` : "Add a comment";
				addHanging(add, maxW, prefix, theme.fg(isCursor ? "accent" : "muted", label), " ".repeat(visibleWidth(prefix)));
			}

			if (editMode) {
				lines.push("");
				add(` ${theme.fg("muted", editMode === "comment" ? "  Your comment:" : "  Your answer:")}`);
				for (const line of editor.render(maxW - 6)) add(`   ${line}`);
			}
		}

		function footerHint(q: NormalizedQuestion): string {
			if (editMode) {
				return editMode === "comment"
					? "Enter save comment • Esc discard"
					: "Enter submit • blank = ask to rephrase • Esc go back";
			}
			const nav = isMulti ? "Tab/←→ navigate • " : "";
			if (q.type === "text") return `${nav}Enter submit • Esc cancel`;
			if (q.type === "checkbox") {
				const done = isMulti ? "next question" : "submit";
				return `↑↓ navigate • Space toggle • ${nav}Enter ${done} • Esc cancel`;
			}
			return `↑↓ navigate • ${nav}Enter select • Esc cancel`;
		}

		loadTextEditor();

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}
