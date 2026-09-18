/**
 * Dumps the real parser verdict for every corpus case.
 *
 * Run from the U002 worktree so that tsx resolves the extension's deps:
 *   npx tsx <abs path>/dump-parser-verdicts.ts <abs path>/corpus.json
 *
 * Output: JSON array of { id, expected, parserValid, error }.
 */

import { readFileSync } from "node:fs";

import { parsePatch } from "../../patch.ts";

type Case = { id: string; valid: boolean; why: string; patch: string };

const corpusPath = process.argv[2];
const corpus = JSON.parse(readFileSync(corpusPath, "utf-8")) as {
  cases: Case[];
};

const verdicts = corpus.cases.map((testCase) => {
  try {
    parsePatch(testCase.patch);
    return {
      id: testCase.id,
      expected: testCase.valid,
      parserValid: true,
      error: null as string | null,
    };
  } catch (error) {
    return {
      id: testCase.id,
      expected: testCase.valid,
      parserValid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

process.stdout.write(JSON.stringify(verdicts, null, 2) + "\n");
