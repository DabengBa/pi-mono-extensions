import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Value } from "@sinclair/typebox/value";

import registerMultiEdit, {
  applyPatchSchema,
  multiFileEditSchema,
} from "../index.ts";

describe("multi-file edit schemas", () => {
  test("accepts cross-file replacement batches", () => {
    assert.equal(
      Value.Check(multiFileEditSchema, {
        edits: [
          { path: "src/a.ts", oldText: "before", newText: "after" },
          { path: "src/b.ts", oldText: "before", newText: "after" },
        ],
      }),
      true,
    );
  });

  test("accepts repeated identical replacements in one file", () => {
    assert.equal(
      Value.Check(multiFileEditSchema, {
        path: "src/example.test.ts",
        edits: [
          { oldText: "getByRole('button')", newText: "getByRole('link')" },
          { oldText: "getByRole('button')", newText: "getByRole('link')" },
        ],
      }),
      true,
    );
  });

  test("accepts top-level path inheritance", () => {
    assert.equal(
      Value.Check(multiFileEditSchema, {
        path: "src/index.ts",
        edits: [
          { oldText: "before one", newText: "after one" },
          { oldText: "before two", newText: "after two" },
        ],
      }),
      true,
    );
  });

  test("requires at least two replacements", () => {
    assert.equal(Value.Check(multiFileEditSchema, { edits: [] }), false);
    assert.equal(
      Value.Check(multiFileEditSchema, {
        edits: [{ path: "src/a.ts", oldText: "before", newText: "after" }],
      }),
      false,
    );
  });

  test("accepts only a patch payload for apply_patch", () => {
    assert.equal(
      Value.Check(applyPatchSchema, {
        patch: "*** Begin Patch\n*** End Patch",
      }),
      true,
    );
    assert.equal(
      Value.Check(applyPatchSchema, {
        patch: "*** Begin Patch\n*** End Patch",
        path: "src/index.ts",
      }),
      false,
    );
  });

  test("uses provider-compatible top-level object schemas", () => {
    for (const schema of [multiFileEditSchema, applyPatchSchema]) {
      assert.equal(schema.type, "object");
      assert.equal("anyOf" in schema, false);
      assert.equal("oneOf" in schema, false);
    }
  });
});

describe("tool registration", () => {
  test("keeps native edit and registers only additive tools", () => {
    const tools: Array<{ name: string; promptGuidelines?: string[] }> = [];
    const pi = {
      registerTool(tool: { name: string; promptGuidelines?: string[] }) {
        tools.push(tool);
      },
    };

    registerMultiEdit(pi as never);

    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["multi_file_edit", "apply_patch"],
    );
    assert.equal(tools.some((tool) => tool.name === "edit"), false);
    assert.equal(
      tools
        .find((tool) => tool.name === "multi_file_edit")
        ?.promptGuidelines?.some((guideline) =>
          guideline.includes("same oldText"),
        ),
      true,
    );
  });
});
