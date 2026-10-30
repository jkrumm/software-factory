#!/usr/bin/env python3
"""Redaction for evidence that lands in the public dotfiles repo.

Scope: evidence/, spikes/, design/, adr/ and the report. research/ holds public web reports
and is not gated. Every evidence script pipes free text (payload excerpts, titles, owner messages,
commands) through `redact()` before writing an output. `--check` is the gate run
before each commit: it exits 1 if any committed output still matches a pattern.

Usage:
  from redact import redact            # sys.path.insert(0, <evidence>/lib)
  python3 -I redact.py --check <files…>   # exit 1 on a leak, lists file:line
  python3 -I redact.py --fix <files…>     # rewrite in place
"""

import re
import sys

PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"/Users/(?:jkrumm|johannes\.krumm)\b"), "~"),
    (re.compile(r"(~/IuRoot/[A-Za-z0-9._-]+)/[^\s'\"`)\]]+"), r"\1/…"),
    (re.compile(r"\b(?:sk-|sk_|ghp_|gho_|ghs_|github_pat_|xox[abprs]-|AKIA|glpat-)[A-Za-z0-9_\-]{10,}"), "<token>"),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._\-+/]{16,}", re.I), "<cred>"),
    (re.compile(r"\b(?:token|apikey|api_key|secret|password)\s*[:=]\s*[\"'][A-Za-z0-9._\-+/]{16,}[\"']", re.I), "<cred>"),  # quoted values only: identifiers are not secrets
    (re.compile(r"(?i)\b(?:okta|epos)\b(?![._][a-z]|-(?:customers|data|orchestrator)-)"), "<work-stack>"),  # work-stack systems: IuRoot repo names only, never their content
    (re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"), "<email>"),
    (re.compile(r"\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b"), "<ip>"),  # loopback is not an address leak
    (re.compile(r"\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b", re.I), "<ip6>"),
    (re.compile(r"\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b", re.I), "<tailnet-host>"),
    (re.compile(r"\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.iu\.org\b", re.I), "<iu-host>"),
    (re.compile(r"\b(?!www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.jkrumm\.com\b", re.I), "<internal-host>"),
    (re.compile(r"\b[a-z0-9-]+\.(?:internal|lan|local|home\.arpa)\b", re.I), "<lan-host>"),
    # long mixed-case base64-ish runs (keys, cookies); commit SHAs are lowercase hex and survive
    (re.compile(r"(?<![/\w.-])(?=[A-Za-z0-9+_-]*[A-Z])(?=[A-Za-z0-9+_-]*[a-z])(?=[A-Za-z0-9+_-]*\d)[A-Za-z0-9+_-]{40,}={0,2}(?![/\w.-])"), "<secret>"),
]


def redact(text: str) -> str:
    if not text:
        return text
    for pat, repl in PATTERNS:
        text = pat.sub(repl, text)
    return text


def _check(paths: list[str]) -> int:
    leaks = 0
    for path in paths:
        try:
            lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
        except (IsADirectoryError, FileNotFoundError):
            continue
        for n, line in enumerate(lines, 1):
            if redact(line) != line:
                leaks += 1
                print(f"{path}:{n}: {line[:160]}")
    return 1 if leaks else 0


def _fix(paths: list[str]) -> int:
    for path in paths:
        src = open(path, encoding="utf-8", errors="replace").read()
        out = redact(src)
        if out != src:
            open(path, "w", encoding="utf-8").write(out)
            print(f"redacted {path}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] not in ("--check", "--fix"):
        sys.exit(__doc__)
    sys.exit(_check(sys.argv[2:]) if sys.argv[1] == "--check" else _fix(sys.argv[2:]))
