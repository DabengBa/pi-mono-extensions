import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runTuiForm } from "../form.js";
import { normalize, type Question } from "../schema.js";

// Default pi keybindings, so these tests exercise the same actions a user hits.
const KEYS: Record<string, string[]> = {
	"tui.select.up": ["\x1b[A"],
	"tui.select.down": ["\x1b[B"],
	"tui.select.confirm": ["\r"],
	"tui.input.submit": ["\r"],
	"tui.select.cancel": ["\x1b"],
	"tui.input.tab": ["\t"],
	"tui.editor.cursorLeft": ["\x1b[D"],
	"tui.editor.cursorRight": ["\x1b[C"],
};

const ENTER = "\r";
const DOWN = "\x1b[B";
const SPACE = " ";
const ESC = "\x1b";

const theme = { fg: (_c: string, x: string) => x, bold: (x: string) => x } as never;
const tui = { requestRender: () => {}, terminal: { rows: 40, columns: 120 } } as never;
const kb = { matches: (d: string, a: string) => (KEYS[a] ?? []).includes(d) } as never;

async function mount(questions: Question[]) {
	let panel: { render(w: number): string[]; invalidate(): void; handleInput(d: string): void } | undefined;
	let result: { answers: { value: string | string[] }[]; cancelled: boolean } | undefined;
	const ctx = {
		hasUI: true,
		ui: {
			custom: async (factory: (t: never, th: never, k: never, done: (r: never) => void) => never) => {
				panel = factory(tui, theme, kb, (r) => {
					result = r;
				});
				return undefined;
			},
		},
	} as never;
	await runTuiForm(ctx, "T", undefined, normalize(questions), undefined);
	const p = panel!;
	return {
		press: (...keys: string[]) => {
			for (const k of keys) p.handleInput(k);
		},
		screen: () => p.render(70).join("\n"),
		get result() {
			return result;
		},
	};
}

const CHECKBOX: Question = { id: "a", type: "checkbox", prompt: "Pick", options: [{ value: "x", label: "X" }] };
const NEXT: Question = { id: "b", type: "radio", prompt: "Then", options: [{ value: "z", label: "Z" }] };

describe("checkbox keys", () => {
	test("Enter on an option row advances instead of toggling", async () => {
		const f = await mount([{ ...CHECKBOX, options: [...CHECKBOX.options!, { value: "y", label: "Y" }] }, NEXT]);
		f.press(SPACE, ENTER);
		const screen = f.screen();
		assert.ok(screen.includes("Then"), "Enter should move to the next question");
		assert.ok(!screen.includes("Pick"), "should have left the checkbox question");
	});

	test("Enter submits the last question without altering the selection", async () => {
		const f = await mount([CHECKBOX]);
		f.press(SPACE, ENTER);
		assert.deepEqual(f.result?.answers[0].value, ["x"], "Enter must not toggle the focused option");
		assert.equal(f.result?.cancelled, false);
	});

	test("Space toggles on and off; selections accumulate", async () => {
		const f = await mount([{ ...CHECKBOX, options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] }]);
		f.press(SPACE, DOWN, SPACE, SPACE, SPACE, ENTER);
		assert.deepEqual(f.result?.answers[0].value, ["x", "y"]);
	});

	test("Enter on the Other row opens the editor rather than advancing", async () => {
		const f = await mount([CHECKBOX, NEXT]);
		f.press(DOWN, ENTER);
		const screen = f.screen();
		assert.ok(screen.includes("Your answer"), "editor should be open");
		assert.ok(!screen.includes("Then"), "should not have advanced");
	});

	test("Enter on the comment row opens the comment editor", async () => {
		const f = await mount([{ ...CHECKBOX, allowComment: true }, NEXT]);
		f.press(DOWN, DOWN, ENTER);
		const screen = f.screen();
		assert.ok(screen.includes("Your comment"), "comment editor should be open");
		assert.ok(!screen.includes("Then"), "should not have advanced");
	});
});

describe("radio keys", () => {
	test("Enter selects the focused option and advances", async () => {
		const f = await mount([
			{ id: "a", type: "radio", prompt: "P", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] },
		]);
		f.press(DOWN, ENTER);
		assert.equal(f.result?.answers[0].value, "y");
	});
});

describe("cancellation", () => {
	test("Esc cancels the form", async () => {
		const f = await mount([CHECKBOX]);
		f.press(ESC);
		assert.equal(f.result?.cancelled, true);
	});
});
