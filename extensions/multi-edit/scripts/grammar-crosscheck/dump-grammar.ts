/**
 * Writes the shipped APPLY_PATCH_GRAMMAR string to disk so the Lark
 * cross-check validates the exact constant that providers receive, not a copy.
 *
 * Run from the U002 worktree:
 *   npx tsx <abs path>/dump-grammar.ts <abs path>/shipped.lark
 */

import { writeFileSync } from "node:fs";

import { APPLY_PATCH_GRAMMAR } from "../../patch.ts";

writeFileSync(process.argv[2], APPLY_PATCH_GRAMMAR);
process.stdout.write(`wrote ${APPLY_PATCH_GRAMMAR.length} chars\n`);
