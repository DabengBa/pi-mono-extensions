#!/usr/bin/env python3
"""
Differential fuzz: APPLY_PATCH_GRAMMAR (Lark) vs parsePatch (TypeScript).

Strategy: build a structurally valid patch from templates, then apply a few
mutations (insert / delete / duplicate / replace lines, switch line endings,
change surrounding whitespace). This concentrates samples on the accept/reject
boundary, where grammar/parser divergence actually lives.

Usage:
  python3 fuzz_crosscheck.py <grammar.lark> <worktree> <batch-dumper.ts> [count] [seed]
"""

import json
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path

from lark import Lark
from lark.exceptions import LarkError

grammar_path, worktree, batch_script = sys.argv[1:4]
batch_script = os.path.abspath(batch_script)
count = int(sys.argv[4]) if len(sys.argv) > 4 else 2000
seed = int(sys.argv[5]) if len(sys.argv) > 5 else 20260916

POOL = [
    "*** Add File: ",
    "*** Add File:   ",
    "*** Add File:x",
    "*** Add File: nested/dir file.txt",
    "*** Delete File: ",
    "*** Delete File:   ",
    "*** Update File: ",
    "*** Update File:   ",
    "*** Move to: ",
    "*** Move to:   ",
    "*** Move to: other name.txt",
    "@@",
    "@@ ctx",
    "@@  ",
    "@@ ",
    "@@x",
    "@@\tx",
    "@@@",
    "+",
    "-",
    " ",
    "   ",
    "\t",
    "",
    "junk",
    "* junk",
    "*** End of File",
    "*** End of File ",
    "*** Frobnicate: z",
    "*** Begin Patch",
    "*** End Patch",
]

random.seed(seed)


def valid_patch() -> list[str]:
    lines: list[str] = ["*** Begin Patch"]
    if random.random() < 0.2:
        lines.append(random.choice(["", " ", "   "]))
    for _ in range(random.randint(0, 3)):
        kind = random.choice(["add", "delete", "update"])
        if kind == "add":
            lines.append(f"*** Add File: {random.choice(['a.txt', 'b/c.txt', 'my file.txt'])}")
            for _ in range(random.randint(0, 3)):
                lines.append("+" + random.choice(["", "line", "  indented", "*** not a directive"]))
        elif kind == "delete":
            lines.append(f"*** Delete File: {random.choice(['a.txt', 'gone.txt'])}")
        else:
            lines.append(f"*** Update File: {random.choice(['a.txt', 'dir/src.txt'])}")
            if random.random() < 0.3:
                lines.append(f"*** Move to: {random.choice(['b.txt', 'dir/dst.txt'])}")
            if random.random() < 0.3:
                lines.append(random.choice(["", "   "]))
            hunk_count = random.randint(1, 2)
            for hunk_index in range(hunk_count):
                lines.append(random.choice(["@@", "@@ anchor", "@@  spaced ctx"]))
                for _ in range(random.randint(1, 4)):
                    marker = random.choice([" ", "+", "-"])
                    lines.append(marker + random.choice(["", "text", "code()  ", ""]))
                if hunk_index == hunk_count - 1 and random.random() < 0.25:
                    lines.append("*** End of File")
            if random.random() < 0.35:
                lines.append(random.choice(["", "   "]))
    lines.append("*** End Patch")
    return lines


def mutate(lines: list[str]) -> list[str]:
    lines = list(lines)
    for _ in range(random.randint(0, 3)):
        op = random.random()
        if not lines:
            break
        index = random.randint(0, len(lines) - 1)
        if op < 0.3:
            lines.insert(index, random.choice(POOL))
        elif op < 0.5:
            del lines[index]
        elif op < 0.65:
            lines[index] = random.choice(POOL)
        elif op < 0.8:
            lines.insert(index, lines[index])
        else:
            lines[index] = lines[index].rstrip() + random.choice([" ", "  ", "\t"])
    return lines


def make_patch() -> str:
    lines = mutate(valid_patch())
    text = "\n".join(lines)
    roll = random.random()
    if roll < 0.12:
        text = text.replace("\n", "\r\n")
    elif roll < 0.2:
        text += "\n"
    elif roll < 0.26:
        text += random.choice([" ", "\n", "\n\n"])
    if random.random() < 0.06:
        text = " \n" + text
    return text


patches = [make_patch() for _ in range(count)]

grammar = Lark(open(grammar_path, encoding="utf-8").read(), start="start", parser="earley")

with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
    json.dump(patches, handle)
    batch_path = handle.name

try:
    result = subprocess.run(
        ["npx", "tsx", batch_script, batch_path],
        cwd=worktree,
        capture_output=True,
        text=True,
        timeout=900,
    )
finally:
    Path(batch_path).unlink(missing_ok=True)

if result.returncode != 0:
    sys.stderr.write(result.stdout)
    sys.stderr.write(result.stderr)
    raise SystemExit(f"parser batch failed with exit code {result.returncode}")

verdicts = json.loads(result.stdout)

mismatches = []
valid_count = 0
for entry in verdicts:
    patch = entry["patch"]
    parser_valid = entry["valid"]
    valid_count += parser_valid
    try:
        grammar.parse(patch)
        grammar_valid = True
    except LarkError:
        grammar_valid = False
    if grammar_valid != parser_valid:
        mismatches.append((patch, parser_valid, grammar_valid, entry["error"]))

print(f"fuzz cases         : {len(verdicts)}")
print(f"parser-valid cases : {valid_count}")
print(f"grammar/parser disagreements: {len(mismatches)}")
for patch, parser_valid, grammar_valid, error in mismatches[:25]:
    print("---")
    print(f"parser={parser_valid} grammar={grammar_valid} error={error}")
    print(json.dumps(patch))

raise SystemExit(1 if mismatches else 0)