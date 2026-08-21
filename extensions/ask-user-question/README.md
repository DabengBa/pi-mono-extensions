# ask-user-question — Interactive Form Tool for pi

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that registers a tool the LLM can call to ask the user structured questions using rich form controls: **radio buttons**, **checkboxes**, and **text inputs**.

Instead of the LLM asking questions in plain text and waiting for a freeform response, this tool presents an interactive TUI form where each question is typed, validated, and returned as structured data.

## How It Works

1. **LLM calls the tool** — Passes a JSON schema of questions with types, options, and metadata.
2. **Form renders** — An interactive panel appears in the terminal with typed controls for each question.
3. **User answers** — Navigate between questions, select options, type text, toggle checkboxes.
4. **Structured return** — Answers are returned to the LLM in a clean, structured format.

## Question Types

### Radio (single-select)

```
 ❯ ◉ PostgreSQL
   ○ MySQL
   ○ SQLite
   ○ Other
```

Pick exactly one option. Press Enter to select. The "Other" option opens a text editor for a custom answer.

### Checkbox (multi-select)

```
 ❯ ☑ Unit tests
   ☑ Integration tests
   ☐ E2E tests
   ☐ Other
```

Toggle multiple options with Space. The "Other" option opens a text editor. Press Enter to advance.

### Text (free input)

```
 ┌─────────────────────────────────┐
 │ Describe the migration strategy │
 └─────────────────────────────────┘
```

A full multi-line editor. Shift+Enter for newlines, Enter to submit.

## Tool Schema

```json
{
  "title": "Project Setup",
  "description": "Let me configure the project based on your preferences",
  "questions": [
    {
      "id": "database",
      "type": "radio",
      "prompt": "Which database should we use?",
      "label": "Database",
      "options": [
        {
          "value": "postgres",
          "label": "PostgreSQL",
          "description": "Best for complex queries"
        },
        {
          "value": "mysql",
          "label": "MySQL",
          "description": "Widely supported"
        },
        {
          "value": "sqlite",
          "label": "SQLite",
          "description": "Lightweight, file-based"
        }
      ],
      "allowOther": true
    },
    {
      "id": "testing",
      "type": "checkbox",
      "prompt": "Which test types should we set up?",
      "label": "Testing",
      "options": [
        { "value": "unit", "label": "Unit tests" },
        { "value": "integration", "label": "Integration tests" },
        { "value": "e2e", "label": "E2E tests" }
      ],
      "allowOther": true
    },
    {
      "id": "notes",
      "type": "text",
      "prompt": "Any additional notes or requirements?",
      "label": "Notes",
      "required": false,
      "placeholder": "Type any extra context here..."
    }
  ]
}
```

### Question Fields

| Field          | Type                                  | Default                  | Description                            |
| -------------- | ------------------------------------- | ------------------------ | -------------------------------------- |
| `id`           | `string`                              | _required_               | Unique identifier                      |
| `type`         | `"radio"` \| `"checkbox"` \| `"text"` | _required_               | Control type                           |
| `prompt`       | `string`                              | _required_               | The question text                      |
| `label`        | `string`                              | `Q1`, `Q2`, `Q3`         | Short label for tab bar                |
| `options`      | `Option[]`                            | `[]`                     | Choices for radio/checkbox             |
| `allowOther`   | `boolean`                             | `true` (radio/checkbox)  | Show "Other" option with text input    |
| `allowComment` | `boolean`                             | `false` (radio/checkbox) | Show an optional free-text comment row |
| `required`     | `boolean`                             | `true`                   | Must be answered before submit         |
| `placeholder`  | `string`                              | —                        | Placeholder text for text inputs       |
| `default`      | `string` \| `string[]`                | —                        | Default value(s)                       |

### Option Fields

| Field         | Type     | Description                     |
| ------------- | -------- | ------------------------------- |
| `value`       | `string` | Value returned to the LLM       |
| `label`       | `string` | Display label                   |
| `description` | `string` | Help text shown below the label |

## Panel Interface

### Single Question

```
──────────────────────────────────────────────────────
 Which database should we use? [single-select]
 *required

 ❯ ◉ PostgreSQL
      Best for complex queries
   ○ MySQL
      Widely supported
   ○ SQLite
      Lightweight, file-based
   ○ Other

 ↑↓ navigate • Enter select • Esc cancel
──────────────────────────────────────────────────────
```

### Multiple Questions (tab bar)

```
──────────────────────────────────────────────────────
 Project Setup
 Let me configure the project based on your preferences

 ✓ Database │ ❯ Testing │ Notes │ Submit

 Which test types should we set up? [multi-select]
 *required

 ❯ ☑ Unit tests
   ☑ Integration tests
   ☐ E2E tests
   ☐ Other
   ✎ Add a comment

 ↑↓ navigate • Space toggle • Tab/←→ navigate • Enter next question • Esc cancel
──────────────────────────────────────────────────────
```

### Text Wrapping

**Nothing is ever truncated.** Prompts, option labels, descriptions, tab labels,
review values and comments always render in full — no `...`, no clipping. Content
wider than the panel wraps onto continuation lines that inherit the leading indent,
so wrapped text stays visually attached to its bullet or label:

```
────────────────────────────────────────────────
 Which database engine should we standardize on for
 the multi-tenant analytics workload that also
 needs to support geospatial indexing? [single-select]
 *required

 ❯ ○ PostgreSQL with the TimescaleDB and PostGIS
     extensions enabled from day one
      Best for complex relational queries, mature
      geospatial support, and predictable
      operational characteristics.
   ○ Other

 ↑↓ navigate • Enter select • Esc cancel
────────────────────────────────────────────────
```

Wrapping is delegated to pi-tui's `wrapTextWithAnsi`, so ANSI colors survive line
breaks and wide (CJK) glyphs are measured correctly. A single word longer than the
panel is broken across lines rather than clipped. When many questions are present,
the tab bar packs into multiple rows instead of shortening labels.

### Comments

Set `allowComment: true` on a radio or checkbox question to add a `✎` row below the
options. The user can qualify their choice without hijacking the "Other" escape
hatch — useful when the reasoning matters as much as the answer.

```
 Testing: unit, integration
   ✎ e2e later, once the API stabilises
```

### Submit Tab (review)

```
──────────────────────────────────────────────────────
 ✓ Database │✓ Testing │✓ Notes │✓ Submit

 Review & Submit

 Database: PostgreSQL
 Testing: unit, integration
 Notes: Focus on API layer first

 Press Enter to submit

 Tab/←→ navigate questions • Enter submit • Esc cancel
──────────────────────────────────────────────────────
```

## Keyboard Reference

### Navigation

| Key               | Action                              |
| ----------------- | ----------------------------------- |
| `Tab` / `→`       | Next question (multi-question mode) |
| `Shift+Tab` / `←` | Previous question                   |
| `↑` / `↓`         | Navigate options within a question  |

### Selection

| Key                | Action                                  |
| ------------------ | --------------------------------------- |
| `Enter`            | Select radio option / advance / submit  |
| `Space`            | Toggle checkbox option                  |
| `Enter` (checkbox) | Done with this question — next / submit |
| `Enter` (text)     | Submit text answer                      |
| `Shift+Enter`      | Newline in text/other editor            |

On a checkbox question, `Space` is the only key that changes a selection. `Enter`
always means "I'm done here" and moves on — it never toggles the focused option.
On the `Other` and `✎` rows, `Enter` opens the editor instead of advancing.

### Other

| Key   | Action                            |
| ----- | --------------------------------- |
| `Esc` | Cancel (in "Other" mode: go back) |

### Custom keybindings

Keys are resolved through pi's `KeybindingsManager`, so overrides in
`keybindings.json` apply to this panel too. The relevant actions are
`tui.select.up`, `tui.select.down`, `tui.select.confirm`, `tui.select.cancel`,
`tui.input.submit`, `tui.input.tab`, `tui.editor.cursorLeft`, and
`tui.editor.cursorRight`.

## Output Format

The tool returns structured text to the LLM:

```
Database: PostgreSQL
Testing: unit, integration, (wrote) GraphQL tests
Notes: Focus on API layer first
```

Custom "Other" answers are prefixed with `(wrote)` so the LLM knows they were user-typed.
Comments appear on an indented `Comment:` line beneath their answer.

### Rephrase requests

Submitting "Other" **blank** is not an empty answer — it means the question as
written couldn't be answered. The tool returns an explicit signal plus a trailing
note, so the LLM reformulates instead of re-asking the same question:

```
Database: (user asked to rephrase, split, or follow up on this question)

Note: rephrase or split the flagged question(s) instead of asking again as written.
```

The answer also carries `needsRephrase: true` in `details`.

## Non-TUI Fallback

`ctx.ui.custom()` is only available in the interactive TUI. In other UIs (RPC hosts)
the tool falls back to sequential `ctx.ui.select` / `ctx.ui.input` dialogs driving the
same answer store, so it degrades instead of failing. Cancelling any dialog cancels
the whole form.

## Cancellation

The panel subscribes to the turn's `AbortSignal`. Aborting mid-form closes it and
returns a cancelled result rather than leaving the terminal blocked.

## Module Layout

| File         | Role                                            |
| ------------ | ----------------------------------------------- |
| `index.ts`   | Tool registration, result formatting, rendering |
| `schema.ts`  | Tool parameters, types, normalization           |
| `state.ts`   | `AnswerStore` — all mutable form state          |
| `form.ts`    | Interactive TUI panel                           |
| `dialog.ts`  | Fallback dialog flow for non-TUI UIs            |
| `__tests__/` | Keystroke and wrapping regression tests         |

`schema.ts` and `state.ts` are free of TUI imports and unit-testable in isolation.

```bash
npm test   # drives the panel through real keystrokes and asserts layout invariants
```

## System Prompt Integration

The tool includes `promptSnippet` and `promptGuidelines` so the LLM knows when and how to use it:

- Prefers `ask_user_question` over plain-text questions
- Uses radio for single-choice, checkbox for multi-choice, text for open-ended
- Groups related questions in a single call
- Includes "Other" escape hatches by default

## Dependencies

| Package                           | Role                                             |
| --------------------------------- | ------------------------------------------------ |
| `@earendil-works/pi-coding-agent` | Extension API, theme types                       |
| `@earendil-works/pi-tui`          | TUI primitives: Editor, KeybindingsManager, etc. |
| `@sinclair/typebox`               | JSON Schema definitions for tool parameters      |
