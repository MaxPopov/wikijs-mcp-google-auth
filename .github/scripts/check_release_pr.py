#!/usr/bin/env python3
"""Перевірка PR у main: джерело dev + версія + змістовний опис.

Викликається з .github/workflows/pr-policy.yml. Усі вхідні дані читаються
з env, щоб текст із PR ніколи не потрапляв у shell.
"""
import os
import re
import subprocess
import sys

VERSION_LINE = re.compile(
    r"^\s*(?:Version|Версія)\s*[:=]\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$",
    re.IGNORECASE | re.MULTILINE,
)
HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
MIN_DESCRIPTION_CHARS = 30

errors = []


def semver_key(version):
    """Ключ сортування semver: реліз > пререліз тієї ж версії."""
    core, _, pre = version.partition("-")
    numbers = tuple(int(part) for part in core.split("."))
    if not pre:
        return (numbers, (1,))
    parts = []
    for part in pre.split("."):
        parts.append((0, int(part), "") if part.isdigit() else (1, 0, part))
    return (numbers, (0,) + tuple(parts))


head_ref = os.environ.get("HEAD_REF", "")
head_repo = os.environ.get("HEAD_REPO", "")
base_repo = os.environ.get("BASE_REPO", "")
allowed_source = os.environ.get("ALLOWED_SOURCE", "dev")
body = os.environ.get("PR_BODY") or ""

# 1. Джерело — тільки гілка dev цього ж репозиторію.
if head_repo != base_repo:
    errors.append(
        f"PR у main має йти з гілки `{allowed_source}` цього репозиторію, "
        f"а не з форку `{head_repo}`."
    )
elif head_ref != allowed_source:
    errors.append(
        f"PR у main дозволені тільки з гілки `{allowed_source}`, "
        f"а цей — з `{head_ref}`."
    )

# 2. Версія в тілі PR.
match = VERSION_LINE.search(body)
version = None
if not match:
    errors.append(
        "В описі PR немає рядка з версією. Додай окремим рядком: `Version: v1.2.3`."
    )
else:
    version = "v" + match.group(1)

# 3. Тег такої версії ще не має існувати.
if version:
    subprocess.run(["git", "fetch", "--tags", "--quiet"], check=False)
    existing = subprocess.run(
        ["git", "tag", "--list"], capture_output=True, text=True, check=True
    ).stdout.split()

    if version in existing:
        errors.append(f"Тег `{version}` уже існує — візьми більший номер версії.")
    else:
        released = [t for t in existing if re.fullmatch(r"v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", t)]
        if released:
            latest = max(released, key=lambda t: semver_key(t[1:]))
            if semver_key(version[1:]) <= semver_key(latest[1:]):
                errors.append(
                    f"Версія `{version}` не більша за останню випущену `{latest}`."
                )

# 4. Змістовний опис релізу, а не сам лише рядок з версією.
description = HTML_COMMENT.sub("", body)
description = VERSION_LINE.sub("", description)
description = re.sub(r"^\s*#{1,6}.*$", "", description, flags=re.MULTILINE)
if len(description.strip()) < MIN_DESCRIPTION_CHARS:
    errors.append(
        f"Опис релізу закороткий (потрібно щонайменше {MIN_DESCRIPTION_CHARS} "
        "символів окрім рядка з версією та заголовків): опиши, що входить у реліз."
    )

summary = os.environ.get("GITHUB_STEP_SUMMARY")
if errors:
    report = "## ❌ PR policy\n\n" + "\n".join(f"- {e}" for e in errors) + "\n"
else:
    report = f"## ✅ PR policy\n\nРеліз `{version}` з гілки `{head_ref}` — усе гаразд.\n"
if summary:
    with open(summary, "a", encoding="utf-8") as fh:
        fh.write(report)
print(report)

sys.exit(1 if errors else 0)
