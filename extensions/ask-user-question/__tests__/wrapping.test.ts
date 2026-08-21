import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { runTuiForm } from "../form.js";
import { normalize, type Question } from "../schema.js";

const theme = { fg: (_c: string, x: string) => x, bold: (x: string) => x } as never;
const tui = { requestRender: () => {}, terminal: { rows: 40, columns: 120 } } as never;
const RIGHT = "\x1b[C";
const kb = { matches: (d: string, a: string) => a === "tui.editor.cursorRight" && d === RIGHT } as never;

const LONG_PROMPT =
	"Which database engine should we standardize on for the multi-tenant analytics workload that also needs geospatial indexing and time-series rollups?";
const LONG_OPTION = "PostgreSQL with the TimescaleDB and PostGIS extensions enabled from day one";
const LONG_DESC =
	"Best for complex relational queries, mature geospatial support, and predictable operational characteristics under sustained write load.";
const UNBREAKABLE =
	"supercalifragilisticexpialidociousantidisestablishmentarianismpneumonoultramicroscopicsilicovolcanoconiosis";
const CJK = "この質問は日本語で書かれており、パネルの幅を超えるほど長い文章になっていますので折り返しが必要です";

const QUESTIONS: Question[] = [
	{
		id: "a",
		type: "radio",
		prompt: LONG_PROMPT,
		label: "Database engine selection strategy",
		allowComment: true,
		options: [
			{ value: "p", label: LONG_OPTION, description: LONG_DESC },
			{ value: "u", label: UNBREAKABLE },
			{ value: "j", label: CJK },
		],
	},
	{ id: "b", type: "checkbox", prompt: CJK, label: "Testing", options: [{ value: "x", label: LONG_OPTION }] },
	{ id: "c", type: "text", prompt: LONG_PROMPT, label: "Notes" },
];

const WIDTHS = [20, 30, 40, 52, 60, 80, 100, 120, 200];

async function mount(tabsToAdvance = 0) {
	let panel: { render(w: number): string[]; invalidate(): void; handleInput(d: string): void } | undefined;
	const ctx = {
		hasUI: true,
		ui: {
			custom: async (factory: (t: never, th: never, k: never, done: (r: never) => void) => never) => {
				panel = factory(tui, theme, kb, () => {});
				return undefined;
			},
		},
	} as never;
	await runTuiForm(ctx, "A form title long enough that it exceeds narrow panels", undefined, normalize(QUESTIONS), undefined);
	const p = panel!;
	for (let i = 0; i < tabsToAdvance; i++) p.handleInput(RIGHT);
	return (w: number) => {
		p.invalidate();
		return p.render(w);
	};
}

describe("wrapping", () => {
	test("never emits an ellipsis and never overflows, on every tab and width", async () => {
		for (let tab = 0; tab < QUESTIONS.length + 1; tab++) {
			const render = await mount(tab);
			for (const w of WIDTHS) {
				for (const line of render(w)) {
					assert.ok(!line.includes("..."), `ellipsis at width ${w}, tab ${tab}: ${JSON.stringify(line)}`);
					assert.ok(!line.includes("…"), `unicode ellipsis at width ${w}, tab ${tab}: ${JSON.stringify(line)}`);
					assert.ok(
						visibleWidth(line) <= Math.min(w, 120),
						`overflow ${visibleWidth(line)} > ${Math.min(w, 120)} at width ${w}, tab ${tab}`,
					);
				}
			}
		}
	});

	test("keeps every word of long prompts and options readable", async () => {
		const render = await mount();
		for (const w of WIDTHS) {
			const blob = render(w).join(" ").replace(/\s+/g, " ");
			for (const word of [...LONG_OPTION.split(" "), ...LONG_PROMPT.split(" ")]) {
				assert.ok(blob.includes(word), `lost word "${word}" at width ${w}`);
			}
		}
	});

	test("breaks unbreakable words across lines instead of clipping", async () => {
		const render = await mount();
		const joined = render(52).join("").replace(/\s+/g, "");
		assert.ok(joined.includes(UNBREAKABLE), "unbreakable word was not preserved across wrapped lines");
	});
});
