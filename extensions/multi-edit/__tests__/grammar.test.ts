/**
 * Provider-facing grammar integration for the apply_patch tool.
 *
 * Proves three contracts:
 * 1. `apply_patch` declares a Lark grammar for constrained sampling.
 * 2. pi-ai turns that declaration into an OpenAI custom (grammar) tool when the
 *    model supports grammar tools, and falls back to a plain function tool
 *    otherwise (no model-id sniffing involved).
 * 3. The patch language the grammar describes matches the surface that
 *    `parsePatch` accepts — `PATCH_SURFACE_CASES` is the pinned parser contract.
 *
 * The grammar string itself is checked against a real Lark parser by
 * `scripts/grammar-crosscheck/validate_grammar.py` and
 * `scripts/grammar-crosscheck/fuzz_crosscheck.py`, which differential-test
 * the grammar against this very parser.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Tool } from "@earendil-works/pi-ai";
import {
  createGrammarToolInputProperties,
  getGrammarToolInput,
} from "@earendil-works/pi-ai/api/constrained-sampling";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";

import registerMultiEdit from "../index.ts";
import { APPLY_PATCH_GRAMMAR, parsePatch } from "../patch.ts";

type RegisteredTool = {
  name: string;
  description: string;
  parameters: Tool["parameters"];
  constrainedSampling?: Tool["constrainedSampling"];
};

function registeredTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  };
  registerMultiEdit(pi as never);
  return tools;
}

function applyPatchTool(): RegisteredTool {
  const tool = registeredTools().find((entry) => entry.name === "apply_patch");
  assert.ok(tool, "apply_patch must be registered");
  return tool;
}

/** Patch surface that the Lark grammar must mirror exactly. */
const PATCH_SURFACE_CASES: ReadonlyArray<{
  id: string;
  valid: boolean;
  patch: string;
}> = [
  { id: "V01", valid: true, patch: "*** Begin Patch\n*** Add File: new.txt\n+line one\n+line two\n*** End Patch" },
  { id: "V02", valid: true, patch: "*** Begin Patch\n*** Delete File: old.txt\n*** End Patch" },
  { id: "V03", valid: true, patch: "*** Begin Patch\n*** Update File: src.txt\n@@\n unchanged\n-old line\n+new line\n*** End Patch" },
  { id: "V04", valid: true, patch: "*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@\n-old\n+new\n*** End Patch" },
  { id: "V05", valid: true, patch: "*** Begin Patch\n*** Update File: src.txt\n@@\n-a\n+b\n@@\n-c\n+d\n*** End Patch" },
  { id: "V06", valid: true, patch: "*** Begin Patch\n*** Update File: src.txt\n@@\n-old\n+new\n*** End of File\n*** End Patch" },
  { id: "V07", valid: true, patch: "*** Begin Patch\n*** Update File: empty.txt\n@@\n+appended\n*** End of File\n*** End Patch" },
  { id: "V08", valid: true, patch: "*** Begin Patch\n*** Update File: context.txt\n@@ anchor\n-old\n+new\n*** End of File\n*** End Patch" },
  { id: "V09", valid: true, patch: "*** Begin Patch\n*** Add File: new.txt\n+created\n*** Update File: keep.txt\n@@\n foo\n-bar\n+BAR\n*** Delete File: gone.txt\n*** End Patch" },
  { id: "V10", valid: true, patch: "*** Begin Patch\n*** Update File: src.txt\n@@\n a\n-b\n+B\n@@\n e\n-f\n+F\n*** End Patch" },
  { id: "V11", valid: true, patch: "*** Begin Patch\r\n*** Update File: src.txt\r\n@@\r\n unchanged\r\n-old line\r\n+new line\r\n*** End Patch" },
  { id: "V12", valid: true, patch: "*** Begin Patch\n*** Update File: src.txt\n@@\n\n-old\n+new\n*** End Patch" },
  { id: "V13", valid: true, patch: "*** Begin Patch\n*** Update File: src.txt\n@@\n-a\n+b\n\n@@\n-c\n+d\n*** End Patch" },
  { id: "V14", valid: true, patch: "*** Begin Patch\n*** Add File: empty.txt\n*** End Patch" },
  { id: "V15", valid: true, patch: "*** Begin Patch\n\n*** Add File: new.txt\n+line\n*** End Patch" },
  { id: "V16", valid: true, patch: "*** Begin Patch\n*** Update File: src.txt\n@@\n-a\n+b\n@@\n-c\n+d\n*** End of File\n*** End Patch" },
  { id: "V17", valid: true, patch: "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+new\n*** Add File: added.txt\n+added\n*** End Patch" },
  { id: "V18", valid: true, patch: "*** Begin Patch\n*** Add File: my file.txt\n+content\n*** End Patch" },
  { id: "V19", valid: true, patch: "*** Begin Patch\n*** Update File: src.txt\n@@   \n-old\n+new\n*** End Patch" },
  { id: "V20", valid: true, patch: "*** Begin Patch\r\n*** Add File: a.txt\r\n+a\r\n*** Delete File: b.txt\r\n*** End Patch" },
  { id: "V21", valid: true, patch: "*** Begin Patch\n*** End Patch" },
  { id: "V22", valid: true, patch: "*** Begin Patch\n*** Update File: append.txt\n@@\n+tail\n*** End of File\n*** End Patch" },
  { id: "V23", valid: true, patch: "*** Begin Patch\n   \n*** Delete File: a.txt\n*** End Patch" },
  { id: "V24", valid: true, patch: "*** Begin Patch\n*** Delete File: a.txt\n\n*** Delete File: b.txt\n*** End Patch" },
  { id: "V25", valid: true, patch: "*** Begin Patch\n*** Delete File: a.txt\n \n*** End Patch" },
  { id: "V26", valid: true, patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End of File\n\n*** Delete File: b.txt\n*** End Patch" },
  { id: "V27", valid: true, patch: "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n\n@@\n-a\n+b\n*** End Patch" },
  { id: "V28", valid: true, patch: "*** Begin Patch\n*** End Patch " },
  { id: "V29", valid: true, patch: "*** Begin Patch\n*** Delete File: a.txt\n   *** End Patch" },
  { id: "V30", valid: true, patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n   \n*** End Patch" },
  { id: "V31", valid: true, patch: "*** Begin Patch\r\n*** Delete File: a.txt\r\n\r\n*** End Patch" },
  { id: "V32", valid: true, patch: "*** Begin Patch\n\t\n*** Delete File: a.txt\n*** End Patch" },
  { id: "V33", valid: true, patch: "*** Begin Patch\n*** Update File: a.txt\n   \n@@\n-a\n+b\n*** End Patch" },
  { id: "I01", valid: false, patch: "not a patch\n*** End Patch" },
  { id: "I02", valid: false, patch: "*** Begin Patch\nno end" },
  { id: "I03", valid: false, patch: "" },
  { id: "I04", valid: false, patch: "*** Begin Patch\n*** Frobnicate: a.txt\n*** End Patch" },
  { id: "I05", valid: false, patch: "*** Begin Patch\n*** Update File: src/old.ts\n@@\n-old\n+new\n*** Move to: src/new.ts\n*** End Patch" },
  { id: "I06", valid: false, patch: "*** Begin Patch\n*** Move to: src/new.ts\n*** End Patch" },
  { id: "I07", valid: false, patch: "*** Begin Patch\n*** Update File: src.txt\n*** Move to: dst.txt\n*** End Patch" },
  { id: "I08", valid: false, patch: "*** Begin Patch\n*** Update File: src.txt\n*** End of File\n*** End Patch" },
  { id: "I09", valid: false, patch: "*** Begin Patch\n*** Update File: src.txt\n@@\n-old\n+new\n*** End of File\n context after eof\n*** End Patch" },
  { id: "I10", valid: false, patch: "*** Begin Patch\n*** Update File: src.txt\n@@\n-old\n+new\n*** End of File\n@@\n-tail\n+TAIL\n*** End Patch" },
  { id: "I11", valid: false, patch: "*** Begin Patch\n*** Add File: x.txt\nnotplus\n*** End Patch" },
  { id: "I12", valid: false, patch: "*** Begin Patch\n*** Update File: x.txt\n@@\nx\n*** End Patch" },
  { id: "I13", valid: false, patch: "*** Begin Patch\n*** Update File: x.txt\n@@foo\n-a\n+b\n*** End Patch" },
  { id: "I14", valid: false, patch: "*** Begin Patch\n*** Add File: x.txt\n+ok\n\n*** End Patch" },
  { id: "I15", valid: false, patch: "*** Begin Patch\n*** Update File: x.txt\n@@\n-a\n+b\n*** End of File\n*** End of File\n*** End Patch" },
  { id: "I16", valid: false, patch: "*** Begin Patch\n*** Update File: x.txt\n-a\n+b\n*** End Patch" },
  { id: "I17", valid: false, patch: "*** Begin Patch\n*** Update File: x.txt\n@@\n@@\n-a\n+b\n*** End Patch" },
  { id: "I18", valid: false, patch: "*** Begin Patch\n*** Add File: x.txt\n+ok\n\n*** Delete File: y.txt\n*** End Patch" },
  { id: "I19", valid: false, patch: "*** Begin Patch\n*** Add File:x.txt\n+ok\n*** End Patch" },
  { id: "I20", valid: false, patch: "*** Begin Patch\n*** Update File: x.txt\n@@\n-a\n*** Frobnicate: z\n*** End Patch" },
  { id: "I21", valid: false, patch: "*** Begin Patch\n*** Update File: x.txt\n@@\n*** End of File\n*** End Patch" },
  { id: "I22", valid: false, patch: "*** Begin Patch\n*** Update File: x.txt\n*** End Patch" },
  { id: "I23", valid: false, patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n\t\n*** End Patch" },
  { id: "I24", valid: false, patch: "*** Begin Patch\n*** Add File:    \n+x\n*** End Patch" },
  { id: "I25", valid: false, patch: "*** Begin Patch\n*** Update File:    \n@@\n-a\n+b\n*** End Patch" },
  { id: "I26", valid: false, patch: "*** Begin Patch\n*** Update File: a.txt\n*** Move to:    \n@@\n-a\n+b\n*** End Patch" },
  { id: "I27", valid: false, patch: "*** Begin Patch\n*** Add File: a.txt\n+x\n\t\n*** End Patch" },
  { id: "I28", valid: false, patch: "*** Begin Patch\n*** End Patch junk" },
  { id: "I29", valid: false, patch: "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** Move to: c.txt\n@@\n-a\n+b\n*** End Patch" },
  { id: "I30", valid: false, patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n\t\n@@\n-c\n+d\n*** End Patch" },
  { id: "I31", valid: false, patch: "*** Begin Patch\n*** Add File: a.txt\n+x\n\n*** Add File: b.txt\n+y\n*** End Patch" },
];

describe("apply_patch grammar constrained sampling", () => {
  test("declares an openai_lark grammar variant", () => {
    const tool = applyPatchTool();
    assert.deepEqual(tool.constrainedSampling, {
      type: "grammar",
      variants: { openai_lark: APPLY_PATCH_GRAMMAR },
    });
    assert.equal(typeof APPLY_PATCH_GRAMMAR, "string");
    assert.ok(APPLY_PATCH_GRAMMAR.trim().length > 0);
  });

  test("grammar covers every apply_patch construct the parser accepts", () => {
    for (const construct of [
      "*** Begin Patch",
      "*** End Patch",
      "*** Add File: ",
      "*** Delete File: ",
      "*** Update File: ",
      "*** Move to: ",
      "@@",
      "@@ ",
      "*** End of File",
    ]) {
      assert.ok(
        APPLY_PATCH_GRAMMAR.includes(construct),
        `grammar must mention ${JSON.stringify(construct)}`,
      );
    }
  });

  test("keeps patch as the single required grammar input property", () => {
    const parameters = applyPatchTool().parameters as {
      type?: string;
      required?: string[];
      properties?: Record<string, { type?: string }>;
    };
    assert.equal(parameters.type, "object");
    assert.deepEqual(parameters.required, ["patch"]);
    assert.equal(parameters.properties?.patch?.type, "string");
  });

  test("pins the parser surface the grammar mirrors", () => {
    for (const testCase of PATCH_SURFACE_CASES) {
      if (testCase.valid) {
        assert.doesNotThrow(
          () => parsePatch(testCase.patch),
          Error,
          `${testCase.id} should parse`,
        );
      } else {
        assert.throws(
          () => parsePatch(testCase.patch),
          Error,
          `${testCase.id} should be rejected`,
        );
      }
    }
  });
});

describe("provider routing for grammar tools", () => {
  test("emits an OpenAI custom grammar tool when grammar tools are supported", () => {
    const [converted] = convertResponsesTools([applyPatchTool() as Tool], {
      supportsOpenAIGrammarTools: true,
    });

    const custom = converted as unknown as Record<string, unknown>;
    assert.equal(custom.type, "custom");
    assert.equal(custom.name, "apply_patch");
    assert.deepEqual(custom.format, {
      type: "grammar",
      syntax: "lark",
      definition: APPLY_PATCH_GRAMMAR,
    });
  });

  test("falls back to a function tool when grammar tools are unsupported", () => {
    const [converted] = convertResponsesTools([applyPatchTool() as Tool], {
      supportsOpenAIGrammarTools: false,
    });

    const fallback = converted as unknown as Record<string, unknown>;
    assert.equal(fallback.type, "function");
    assert.equal("format" in fallback, false);
    const parameters = fallback.parameters as {
      type?: string;
      required?: string[];
      properties?: Record<string, { type?: string }>;
    };
    assert.equal(parameters.type, "object");
    assert.deepEqual(parameters.required, ["patch"]);
    assert.equal(parameters.properties?.patch?.type, "string");
  });

  test("rebuilds the patch payload from a grammar tool call", () => {
    const patch = "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch";
    assert.equal(getGrammarToolInput("apply_patch", { patch }, "patch"), patch);
    assert.throws(
      () => getGrammarToolInput("apply_patch", { patch: 42 }, "patch"),
      /requires argument "patch" to be a string/,
    );
  });

  test("derives the grammar input property from the tool schema", () => {
    const properties = createGrammarToolInputProperties(
      [applyPatchTool() as Tool],
      true,
    );
    assert.equal(properties.get("apply_patch"), "patch");
    assert.equal(
      createGrammarToolInputProperties([applyPatchTool() as Tool], false).size,
      0,
    );
  });
});