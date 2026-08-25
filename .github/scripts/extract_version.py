#!/usr/bin/env python3
"""Дістає версію з тіла змердженого PR і віддає її як output кроку."""
import os
import re
import sys

VERSION_LINE = re.compile(
    r"^\s*(?:Version|Версія)\s*[:=]\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$",
    re.IGNORECASE | re.MULTILINE,
)

body = os.environ.get("PR_BODY") or ""
match = VERSION_LINE.search(body)
if not match:
    print("В описі PR немає рядка `Version: vX.Y.Z` — тег не створюю.", file=sys.stderr)
    sys.exit(1)

version = "v" + match.group(1)
with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as fh:
    fh.write(f"version={version}\n")
print(f"Версія релізу: {version}")
