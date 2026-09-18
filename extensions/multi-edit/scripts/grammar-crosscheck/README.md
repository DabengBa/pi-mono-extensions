# APPLY_PATCH_GRAMMAR ↔ parsePatch differential cross-check

`APPLY_PATCH_GRAMMAR` (exported from `../../patch.ts`) is the Lark grammar pi-ai
sends to Codex-capable providers as a custom tool. It must stay in lockstep
with `parsePatch`: every string the grammar accepts must parse, and every
patch the parser accepts must be in the grammar's language.

Node's `pnpm test` only pins the parser surface and required grammar
constructs (see `../../__tests__/grammar.test.ts`); it cannot execute Lark. These
scripts are the real equivalence check. **Run them whenever you change the
parser or the grammar.**

## Prerequisites

- `python3` with `lark>=1.3,<2` (for example, `python3 -m venv /tmp/larkvenv && /tmp/larkvenv/bin/pip install 'lark>=1.3,<2'`)
- `npx tsx` (repo dev environment already provides it)

## Usage

Run from the worktree root (the dir containing `extensions/multi-edit`):

```bash
EXT=extensions/multi-edit/scripts/grammar-crosscheck
WT=$(pwd)

# 1. Dump the shipped grammar (never validates a stale copy)
npx tsx "$EXT/dump-grammar.ts" "$EXT/shipped.lark"

# 2. Corpus check: 64 hand-picked boundary cases, parser vs grammar
npx tsx "$EXT/dump-parser-verdicts.ts" "$EXT/corpus.json" > "$EXT/parser-verdicts.json"
python3 "$EXT/validate_grammar.py" "$EXT/shipped.lark" "$EXT/corpus.json" "$EXT/parser-verdicts.json"

# 3. Differential fuzz: structure-aware mutations, parser vs grammar
python3 "$EXT/fuzz_crosscheck.py" "$EXT/shipped.lark" "$WT" "$EXT/dump-parser-verdicts-batch.ts" 2000 20260916
```

Exit code 0 == zero accept/reject disagreements. Any mismatch means the
grammar is too narrow or too wide relative to `parsePatch` — fix the grammar
(or the parser, deliberately) and re-run.

## Files

- `dump-grammar.ts` — writes the shipped `APPLY_PATCH_GRAMMAR` constant.
- `dump-parser-verdicts.ts` — per-case `parsePatch` verdicts for `corpus.json`.
- `dump-parser-verdicts-batch.ts` — batch verdicts for fuzzing.
- `corpus.json` — 64 boundary cases with expected verdicts.
- `validate_grammar.py` — corpus comparison.
- `fuzz_crosscheck.py` — differential fuzzer.
- `shipped.lark`, `parser-verdicts.json` — generated artifacts (regenerate; safe to delete).
