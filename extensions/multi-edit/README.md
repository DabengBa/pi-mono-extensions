# Multi-Edit — Additive Editing Tools for Pi

A Pi extension that complements the native `edit` tool with two capabilities the core tool does not provide:

- `multi_file_edit` — preflighted exact replacements across multiple files or repeated identical occurrences in one file
- `apply_patch` — Codex-style add, update, and delete operations

The extension does **not** override `edit`. Pi's native tool remains the preferred path for ordinary single-file work, including multiple disjoint replacements through its `edits[]` parameter.

## Why additive tools?

Pi's native `edit` now provides robust same-file batching, uniqueness and overlap validation, Unicode/whitespace normalization, CRLF and BOM preservation, mutation queuing, and live diff previews. Maintaining a replacement for that behavior would duplicate core functionality and drift as Pi improves.

This package therefore keeps only its differentiated cross-file and patch workflows.

## `multi_file_edit`

Use this tool when exact replacements span multiple files and should be preflighted together, or when the same `oldText` must replace multiple occurrences in one file. Native `edit` requires each `oldText` to be unique in the original file; `multi_file_edit` resolves repeated identical entries positionally.

```json
{
  "edits": [
    {
      "path": "src/a.ts",
      "oldText": "export const oldName = 1;",
      "newText": "export const newName = 1;"
    },
    {
      "path": "src/b.ts",
      "oldText": "import { oldName } from './a';",
      "newText": "import { newName } from './a';"
    }
  ]
}
```

A top-level `path` can be inherited by entries that omit their own path:

```json
{
  "path": "src/index.ts",
  "edits": [
    { "oldText": "before one", "newText": "after one" },
    { "oldText": "before two", "newText": "after two" }
  ]
}
```

For ordinary changes confined to one file, use native `edit` instead.

For repeated identical occurrences, repeat the edit entry once per intended replacement:

```json
{
  "path": "src/example.test.ts",
  "edits": [
    { "oldText": "getByRole('button')", "newText": "getByRole('link')" },
    { "oldText": "getByRole('button')", "newText": "getByRole('link')" }
  ]
}
```

This replaces the first two matching occurrences in file order without requiring artificial surrounding context.

### Behavior

- Every replacement is checked against a virtual filesystem before real files are changed.
- Same-file entries are ordered by their position in the original content.
- Repeated identical entries match successive occurrences; repeat an entry only as many times as it should be replaced.
- Cross-file writes use best-effort rollback if an unexpected I/O failure or abort interrupts the batch.
- Exact matching falls back to curly-quote and trailing-whitespace normalization.
- Per-file diffs are returned in the tool result.

## `apply_patch`

Use this tool for coordinated patches that add, update, or delete files.

```json
{
  "patch": "*** Begin Patch\n*** Add File: src/new.ts\n+export const value = 1;\n*** Update File: src/index.ts\n@@\n-export { oldValue } from './old';\n+export { value } from './new';\n*** Delete File: src/old.ts\n*** End Patch"
}
```

Supported operations:

| Header                    | Effect                                             |
| ------------------------- | -------------------------------------------------- |
| `*** Add File: <path>`    | Create or overwrite a file from `+`-prefixed lines |
| `*** Update File: <path>` | Apply one or more `@@`-delimited hunks; optionally move to a new path |
| `*** Delete File: <path>` | Delete an existing file                            |

Patch operations are preflighted against a virtual filesystem before mutation. Update hunks support exact matching followed by per-line trailing-whitespace tolerance. A `*** Move to: <path>` line may appear immediately after an `*** Update File:` header to write the updated content to a new path and remove the source. `*** End of File` after a hunk requires that hunk to match through the file end, including pure appends.

### Move and EOF limitations

- `*** Move to: <path>` is valid only immediately after its `*** Update File:` header and before the first hunk.
- A move writes the destination before deleting the source. Validation failures are preflighted without mutation, but an unexpected source-delete I/O failure after a successful destination write is not compensated.
- `*** End of File` is a hunk terminator, not a standalone file operation; its hunk must match the end of the current file.
- Full whitespace or Unicode-normalized patch matching is not supported.

### Grammar constrained sampling and fallback

`apply_patch` declares a Lark grammar (`APPLY_PATCH_GRAMMAR` in `patch.ts`) for providers that support OpenAI grammar-constrained custom tools:

```ts
constrainedSampling: {
  type: "grammar",
  variants: { openai_lark: APPLY_PATCH_GRAMMAR },
}
```

- When the model supports grammar tools, pi-ai advertises `apply_patch` as an OpenAI `custom` tool whose `format` is `{ type: "grammar", syntax: "lark", definition }`. The patch payload is then generated against the grammar.
- When the model does not support grammar tools, pi-ai ignores the declaration and advertises the ordinary `function` tool built from `parameters`, so the JSON schema and the parser remain the only contract. The fallback is resolved per request from provider capability, not from a model-id list, so unsupported models keep working with the same `patch` payload.
- The grammar mirrors the parser exactly: `*** Begin Patch` / `*** End Patch` envelope, `*** Add File:`, `*** Delete File:`, `*** Update File:`, `*** Move to:`, `@@` and `@@ <context>` hunk headers, `+`/`-`/space hunk lines, blank-line separators, and the `*** End of File` hunk terminator, with CRLF tolerance.
- `patch` must stay the only required property, because grammar constrained sampling derives the constrained input property from the single required string field.

## Choosing a tool

| Task                                              | Tool                                                  |
| ------------------------------------------------- | ----------------------------------------------------- |
| One replacement in one file                       | Native `edit`                                         |
| Several unique, disjoint replacements in one file | Native `edit` with `edits[]`                          |
| Repeated identical occurrences in one file        | `multi_file_edit`, repeating the entry per occurrence |
| Exact replacements across multiple files          | `multi_file_edit`                                     |
| Add/delete files or apply coordinated hunks       | `apply_patch`                                         |
| Create or fully rewrite one file                  | Native `write`                                        |

## Development

```bash
npm test
npm run bench
npm run bench -- --from-session --all
```

The benchmark supports synthetic scenarios and historical Pi JSONL session analysis.
