#!/usr/bin/env python3
"""
Cross-checks APPLY_PATCH_GRAMMAR against the real TypeScript parser verdicts.

Usage:
  python3 validate_grammar.py candidate.lark corpus.json parser-verdicts.json

Exit code 0 == every corpus case gets the same accept/reject verdict from the
Lark grammar as from `parsePatch` in extensions/multi-edit/patch.ts.
"""

import json
import sys

from lark import Lark
from lark.exceptions import LarkError

grammar_path, corpus_path, verdicts_path = sys.argv[1:4]

grammar_text = open(grammar_path, encoding="utf-8").read()
corpus = json.load(open(corpus_path, encoding="utf-8"))["cases"]
parser_verdicts = {v["id"]: v["parserValid"] for v in json.load(open(verdicts_path, encoding="utf-8"))}

parser = Lark(grammar_text, start="start", parser="earley")

mismatches = []
rows = []
for case in corpus:
    try:
        parser.parse(case["patch"])
        grammar_valid, error = True, ""
    except LarkError as exc:
        grammar_valid, error = False, f"{type(exc).__name__}: {exc}".replace("\n", " ")[:160]
    parser_valid = parser_verdicts[case["id"]]
    agree = grammar_valid == parser_valid
    if not agree:
        mismatches.append(case["id"])
    rows.append((case["id"], case["valid"], parser_valid, grammar_valid, agree, error))

print(f"{'id':<5} {'expect':<7} {'parser':<7} {'grammar':<8} {'agree':<6} error")
for cid, expect, pv, gv, agree, error in rows:
    print(f"{cid:<5} {str(expect):<7} {str(pv):<7} {str(gv):<8} {str(agree):<6} {error}")

print()
print(f"cases={len(rows)} mismatches={mismatches}")
sys.exit(1 if mismatches else 0)
