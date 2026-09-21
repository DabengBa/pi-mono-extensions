# Pi Action Fusion

Action Fusion overrides Pi's built-in `edit` and `write` tools with the same
tool names and native behavior, plus an optional `then_run` object. A fused
call performs one file mutation and, after the mutation succeeds, runs one
verification command through Pi's native bash tool.

## Install

From this package directory:

```bash
npm install
npm run typecheck
npm test
```

To try the extension for one Pi process without installing it into user
settings:

```bash
pi -e /absolute/path/to/action-fusion
```

The package is also loadable from a checkout with the workspace tooling:

```bash
pnpm --dir extensions/action-fusion typecheck
pnpm --dir extensions/action-fusion test
```

## Usage

`edit` and `write` retain their native parameters. Add `then_run` when the
mutation should be followed by one verification command:

```json
{
  "path": "src/app.ts",
  "content": "export const ready = true;\n",
  "then_run": {
    "command": "npm test -- --runInBand",
    "timeout": 120
  }
}
```

`command` is required and is passed unchanged to Pi's bash definition.
`timeout` is optional and is measured in seconds by Pi bash. A successful
result retains the native mutation content and details, then appends
`[then_run:succeeded]` and the command output.

Without `then_run`, the extension delegates directly to the native tool. The
native tool name, schema, argument preparation, prompt metadata, renderer,
diff/highlighting, and details shape are preserved.

## Credential-Free Smoke Test

This command loads only the explicitly supplied extension, disables automatic
extension discovery, uses a temporary config directory, avoids sessions and
startup network work, and uses JSON print mode. It does not modify Pi settings
or require an external provider credential. With no model credential, Pi
prints its JSON session header and exits with its expected no-API-key status;
the final `test` makes that expected status a successful shell smoke check.

```bash
tmpdir=$(mktemp -d); set +e; output=$(env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u GEMINI_API_KEY PI_CODING_AGENT_DIR="$tmpdir" PI_OFFLINE=1 pi --no-session --no-extensions -e /absolute/path/to/action-fusion --mode json --print "Check the loaded edit and write tools" 2>&1); status=$?; printf '%s\n' "$output"; rm -rf "$tmpdir"; test "$status" -eq 1 && printf '%s' "$output" | grep -Fq '{"type":"session"' && ! printf '%s' "$output" | grep -Fq 'Failed to load extension'
```

For a deterministic host proof that also executes successful and failing tool
calls without credentials, run:

```bash
pnpm --dir extensions/action-fusion exec tsx --test test/host-integration.test.ts
```

That test uses Pi's real `DefaultResourceLoader`, `AgentSession`, and
in-memory `fauxProvider`. It does not use a fake `ExtensionAPI` as its host.

## Execution Semantics

The fused operation is serialized per canonical target path across the full
window:

```text
native edit/write mutation -> SHA-256 hash -> one event-loop turn -> SHA-256 hash -> bash
```

The two hashes are an observation window, not a transaction. If the target
changes, disappears, becomes a directory, or cannot be read between the two
hashes, the command is skipped and the tool error contains
`[then_run:skipped]`. The extension's queue covers only fused operations from
this extension instance. External processes and unrelated tools are outside
that queue, and a write after the second hash can still race the command.

If the native mutation fails, the command is not run and the mutation error is
reported with `[then_run:skipped]`. If bash exits non-zero, times out, or is
aborted, the completed file mutation remains in place and the error contains
`[then_run:failed]`. There is no rollback or automatic retry.

The same `AbortSignal` is passed to the native mutation and Pi bash. The
extension does not add a second timeout timer; `timeout` is handled only by
Pi bash. Queue entries are released on success, mutation errors, command
errors, timeout, and cancellation.

Different target files may run in parallel. Existing files are canonicalized
with `realpath()` so relative, absolute, symlink, and `file://` aliases share
one queue key. New files use their resolved absolute path. File URLs are
parsed with Node's `fileURLToPath()`, including percent-encoded names.

## Security And Limits

`then_run.command` is arbitrary shell text and is intentionally executed as-is
by Pi's bash tool. Action Fusion adds no command allowlist, confirmation
dialog, rewriting, sandbox, privilege boundary, retry, or rollback. The
command has the same filesystem, process, and network permissions as the Pi
process that loaded this extension. Only use commands and extension packages
you trust.

The extension reuses Pi's public `createBashToolDefinition()` API, so it uses
Pi's shell selection, environment, abort behavior, timeout behavior, output
truncation, and error formatting exposed by that API. Pi 0.86.0's public
`BashToolOptions` supports `shellPath` and `commandPrefix`; this wrapper calls
`createBashToolDefinition(ctx.cwd)` without forwarding session-level shell
settings, so those settings are not inherited by this wrapper.

This package implements exactly one mutation followed by one command. It does
not implement pipelines, workflow orchestration, automatic test selection,
automatic repair, context compaction, or GPT-Load integration.

## Development Version

Development and host tests are pinned to Pi `0.86.0` in this package. The
runtime Pi package is supplied by the host through the peer dependency.
