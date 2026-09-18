/**
 * Batch parser-verdict dumper for fuzz cross-checking.
 *
 * Input : JSON array of patch strings (argv[2]).
 * Output: JSON array of { patch, valid, error }.
 */

import { readFileSync } from "node:fs";

import { parsePatch } from "../../patch.ts";

const patches = JSON.parse(readFileSync(process.argv[2], "utf-8")) as string[];

const verdicts = patches.map((patch) => {
  try {
    parsePatch(patch);
    return { patch, valid: true, error: null as string | null };
  } catch (error) {
    return {
      patch,
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

process.stdout.write(JSON.stringify(verdicts) + "\n");
