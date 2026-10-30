#!/usr/bin/env python3
"""Owner interventions: the twenty latest times the owner had to step in, raw signal to closure.

Question:   When did the owner last have to step in (a present human, a decision, a
            correction, an unblock), and what would an ideal autonomous system have done?
Definition keys (../DEFINITIONS.md):
            `owner_touch` -- any action from outside the autonomous loop (a transition
              out of `needs_decision` closed by hand / re-investigation requested /
              adopted by owner, an `operations` row authorized_by owner:* or cli:*,
              a human-queue ask);
            `genuine_escalation_share` -- the fixed rule: only product direction, spend,
              irreversible data loss and other people are the owner's; nothing else is.
Inputs:     human-queue snapshot  ~/.local/share/factory/snapshots/<AS_OF date>/human-queue/
            warden.db snapshot    ~/.local/share/factory/snapshots/<AS_OF date>/warden.db
            transcripts           ~/.claude/projects/**/*.jsonl on this host (read live,
                                  filtered by AS_OF) and on the MacBook through
                                  `ssh iumac 'python3 - scan-transcripts ...' < interventions.py`
                                  (retried: the laptop sleeps; if it stays unreachable its
                                  candidates are carried over from the previous run)
            judgments.json        hand-judged selection (written by the analyst, read by `report`)
Outputs:    candidates.out.json   mechanical: every candidate, redacted excerpt <= 200 chars, tags
            interventions.out.json + interventions.md
                                  the 20 latest genuine interventions and the summary
Run:
    python3 -I interventions.py candidates [--days 21] [--no-macbook]
    python3 -I interventions.py report
    python3 -I interventions.py context <candidate-id> [--before N] [--after N]   (stdout only)
Env:        AS_OF (default 2026-10-22T08:00:00Z), FACTORY_SNAPSHOTS,
            INTERVENTIONS_PERSONAL_TERMS (regex alternation of names and places to withhold).

Heuristics tag, they never decide: whether a candidate is a genuine intervention is a
judgement recorded in judgments.json.  An owner message is a transcript entry carrying
the harness's own origin marker `{"kind":"human"}` (typed in the TUI) -- a `user` entry,
or a `queued_command` attachment when it was typed while the agent was mid-turn.  Tool
results, slash commands, task notifications, peer (agent-to-agent) messages and sdk
sessions never carry it.  But `rd say` / `herdr agent prompt` type an orchestrator's text
into a worker's pane, and the harness records that as owner-typed too: such text is
recognised by role prefix or house style and dropped (`agent_authored`).  The first prompt
of a session is tagged `first_prompt`; wave briefs and long pasted briefs are tagged `brief`
and dropped.

Privacy (public repo): every free-text field passes lib/redact.py plus the extra patterns
below; URLs keep only their host (GitHub excepted); the machines' own hostnames are scrubbed
at source; an excerpt is withheld for IuRoot sessions, the personal vault, personal details
(family words, plus whatever INTERVENTIONS_PERSONAL_TERMS lists: names and places, kept out of
the repo) and candidates with no intervention signal at all.
"""

import argparse
import collections
import datetime as dt
import json
import os
import re
import sqlite3
import subprocess
import sys
import time

AS_OF = os.environ.get("AS_OF", "2026-10-22T08:00:00Z")
HOME = os.path.expanduser("~")
SNAP_ROOT = os.environ.get("FACTORY_SNAPSHOTS", os.path.join(HOME, ".local/share/factory/snapshots"))
PROJECTS = os.path.join(HOME, ".claude/projects")
try:
    HERE = os.path.dirname(os.path.abspath(__file__))
except NameError:  # `python3 -` over ssh: no __file__; only scan-transcripts runs there
    HERE = os.getcwd()

# Agent-only sessions (warden/agw episodes, A/B benches): they never carry a human origin.
SKIP_DIR = re.compile(
    r"local-state-agent-gateway-worktrees|local-state-sideclaw-worktrees|"
    r"local-share-sideclaw-ab|local-share-agent-gateway-bench"
)
H_MARK = b'"origin":{"kind":"human"}'
A_MARK = b'"type":"assistant"'
ASK_MARK = b'"name":"AskUserQuestion","input"'

CLASSES = [
    "business decision",
    "missing capability/permission",
    "agent stopped or asked needlessly",
    "wrong output corrected",
    "infra needing a present human (biometric/TCC/GUI)",
    "other",
]
MECHANISMS = [
    "policy line",
    "verification evidence",
    "host verb",
    "durable retry",
    "known-error recipe",
    "different engine/spawner",
    "genuinely owner",
]

# ----------------------------------------------------------------------------- text helpers


def parse_ts(s):
    """ISO string (Z or +00:00, any fraction) -> aware UTC datetime."""
    s = s.replace("Z", "+00:00")
    d = dt.datetime.fromisoformat(s)
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


def iso(d):
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def norm_ts(s):
    return iso(parse_ts(s))


def home_path(p):
    return re.sub(r"^/Users/[^/]+", "~", p or "")


def is_iu(cwd, branch=None):
    """IuRoot content is never quoted (privacy rule); recognise it by cwd or ticket branch."""
    c = cwd or ""
    if "/IuRoot/" in c or c.endswith("/IuRoot") or "/.herdr/worktrees/" in c:  # herdr worktrees: IuRoot only so far
        return True
    return bool(branch and re.match(r"(?:\w+/)?EP-\d+", branch))


def repo_of(cwd):
    p = home_path(cwd)
    if not p:
        return "?"
    m = re.match(r"~/IuRoot/(.+)", p)
    if m:
        parts = m.group(1).split("/")
        return parts[1] if parts[0] in ("worktrees", ".wt") and len(parts) > 1 else parts[0]
    m = re.match(r"~/\.herdr/worktrees/([^/]+)", p)
    if m:
        return m.group(1)
    m = re.match(r"~/SourceRoot(?:/(.+))?$", p)
    if m:
        first = (m.group(1) or "SourceRoot").split("/")[0]
        return first
    if p == "~":
        return "~"
    if p.startswith("~/.hermes"):
        return "hermes-agent"
    return os.path.basename(p) or "?"


def clip(s, n=200):
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


_REDACT = None


def _redact():
    global _REDACT
    if _REDACT is None:
        sys.path.insert(0, os.path.join(HERE, "..", "lib"))
        from redact import redact  # noqa: E402  (evidence/lib/redact.py)

        _REDACT = redact
    return _REDACT


# lib/redact.py is the gate; these extra patterns close gaps it does not cover
# (a short password in prose, 1Password refs, KEY=value assignments).
EXTRA = [
    (re.compile(r"op://[^\s'\"`)>\]]+"), "op://<ref>"),
    (re.compile(r"(?i)\b(password|passwort|passwd|pw)\b(\s*(?:to|=|:|is|ist|auf|→)\s*)[\"'“”]?[^\s\"'“”,;]+[\"'“”]?"), r"\1\2<redacted>"),
    (re.compile(r"\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|SECRET_KEY)\b\s*=\s*\S+"), "<cred>"),
    (re.compile(r"/tmp/[A-Za-z0-9._-]+\.env\b"), "/tmp/<env-file>"),
]
_HOST_RE = None  # compiled from the machines' own hostnames (never written down in the repo)
ROLE_NAMES = {"mini", "iumac", "homelab", "vps", "localhost"}


def register_hostname(name):
    """A hostname pasted into a message (shell prompt, ssh banner) is scrubbed at its source:
    each scan reports its machine's own hostname, so no hostname literal lives in this file."""
    global _HOST_RE
    names = set(getattr(register_hostname, "names", set()))
    if name and len(name) > 5 and name.lower() not in ROLE_NAMES:
        names.add(name)
    register_hostname.names = names
    _HOST_RE = re.compile("|".join(re.escape(n) for n in sorted(names)), re.I) if names else None


URL_RE = re.compile(r"https?://([^\s/'\")\]|…`]+)(/[^\s'\")\]|…`]*)?")


def _url(m):
    """Keep GitHub URLs (public); for any other host keep the host only, so share tokens,
    query strings and coordinates never reach the repo."""
    host = m.group(1)
    return m.group(0) if host.endswith("github.com") else "https://%s/…" % host


# Personal details the redaction lib does not know. Family words are generic; first names of
# private persons and the owner's whereabouts are NOT written down here (that would publish
# them): pass them at run time as INTERVENTIONS_PERSONAL_TERMS="Name|Place|...". A hit
# withholds the whole excerpt rather than masking a fragment.
PERSONAL_RE = re.compile(
    r"\b(?:dad(?:'s)?|mum|mom|papa|mama%s)\b" % ("|" + os.environ["INTERVENTIONS_PERSONAL_TERMS"] if os.environ.get("INTERVENTIONS_PERSONAL_TERMS") else ""),
    re.I,
)


def scrub(text, n=200):
    """Redact, then clip to n chars (clip last so a pattern is never cut in half)."""
    t = URL_RE.sub(_url, text or "")
    for pat, repl in EXTRA:
        t = pat.sub(repl, t)
    if _HOST_RE:
        t = _HOST_RE.sub("<host>", t)
    return clip(_redact()(t), n)


# ----------------------------------------------------------------------------- heuristics

KW = {
    "neg": r"\b(wrong|falsch|stop|stopp|halt|don'?t|dont|never|nie|not what|nicht das|nicht so|that'?s not|das ist nicht|instead|stattdessen|i said|ich sagte|i meant|ich meinte|nope|doch)\b",
    "why": r"\b(why|warum|wieso|weshalb|how come|what happened|was ist passiert)\b",
    "repeat": r"\b(again|still|schon wieder|immer noch|noch immer|nochmal|erneut|wieder)\b",
    "go": r"^\W*(ja|yes|yep|yeah|ok|okay|go|weiter|continue|proceed|mach|do it|passt|genau|klar|gerne|sure|approved?|genehmigt|freigabe)\b|\b(go ahead|go now|mach weiter|proceed|approve[d]?|continue now|weiter so)\b",
    "broken": r"\b(broken|kaputt|geht nicht|funktioniert nicht|not working|doesn'?t work|fails|failed|failing|stuck|hängt|crash\w*|outage|down)\b",
    "frustrated": r"\b(fuck\w*|shit|stupid|insane|annoying|nervt|scheiß\w*|wtf|omg|ridiculous|useless|why the hell|dumm|blöd|damn)\b",
}
KW_RE = {k: re.compile(v, re.I) for k, v in KW.items()}
NEG_START_RE = re.compile(r"^\W*(no|nein|nope|nicht|stop|stopp|halt|wait|moment|hold on|wrong|falsch|don'?t|dont|doch|aber|actually|eigentlich)\b", re.I)
PERM_RE = re.compile(
    r"(should i|shall i|want me to|would you like|do you want|soll ich|möchtest du|willst du|darf ich|"
    r"let me know|your call|your decision|ok to|go ahead\?|approve|confirm|which (?:one|option)|option [a-c]\b|\(a\)|\(b\))",
    re.I,
)
DONE_RE = re.compile(
    r"(\bdone\b|\bcomplete[d]?\b|\bfinished\b|\bshipped\b|\bmerged\b|\bdeployed\b|\blanded\b|all green|"
    r"\bpassing\b|\bfertig\b|\berledigt\b|✅|\bready\b|\blive\b|verified)",
    re.I,
)
BLOCKED_RE = re.compile(
    r"(\bblocked\b|can'?t|cannot|unable|need you|needs you|\bhuman\b|manually|by hand|biometric|touch id|"
    r"permission denied|requires? (?:access|approval)|not allowed|denied|ask-human|human-queue)",
    re.I,
)
BRIEF_RE = re.compile(
    r"^(Read docs/waves/PLAN\.md|Execute the active wave|You are (?:an?|the) |## |# |<task|<cross-session|\[structured-output)",
)
# `rd say` / `herdr agent prompt` types an agent's text into another agent's pane, and the harness
# records that as owner-typed.  An orchestrator's message is recognised by its role prefix or by
# an agent's house style; those are dropped, the doubtful ones tagged `maybe_agent`.
AGENT_PREFIX_RE = re.compile(
    r"^\W*(?:<pasted_content[^>]*>\s*)?(?:"
    r"(?:Lead|Mother|Orchestrator|Worker|Reviewer|Chain|Merge train)\b|"
    r"\[from [\w.\- ]+\]|From [\w.\-]+(?:-[0-9a-f]{2})?\s*[:,(]|[a-z][\w.]*-[0-9a-f]{2}\s*:|"
    r"Heads-up from|Answers? from|Addendum from|Review of #\d+|Decision from Johannes|"
    r"Your turn ended with|Go with \d|go:\s|[\w.\-]+ Wave \d+ [\w\- ]*closed)",
    re.I,
)
PATHISH_RE = re.compile(r"\b[\w/.\-]+\.(?:ts|tsx|py|md|json|sh|toml|ya?ml|plist)(?::\d+)?\b")
HASH_RE = re.compile(r"\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|#\d{2,}\b|\bitem \d{3,}\b")
SKIP_PREFIX = ("<command-name>", "<local-command", "<bash-", "<system-reminder>", "Caveat:", "<task-notification", "<cross-session-message")


def agent_style_score(text):
    s = 0
    s += 1 if len(PATHISH_RE.findall(text)) >= 2 else 0
    s += 1 if len(HASH_RE.findall(text)) >= 1 else 0
    s += 1 if text.count("—") >= 2 else 0
    s += 1 if re.search(r"\(\d\)|\([a-d]\)", text) else 0
    s += 1 if re.search(r"\b(worktree|rebase|make check|scope frozen|close-out|rd say|PLAN\.md)\b", text) else 0
    return s


def clean_text(t):
    t = re.sub(r"<(ide_[a-z_]+|system-reminder)>.*?</\1>", " ", t, flags=re.S)
    return t.strip()


def tag_message(text, prev_text, first, queued, gap_s):
    n = len(text)
    tags = []
    if queued:
        tags.append("queued")  # typed while the agent was mid-turn: steering, not replying
    if first:
        tags.append("first_prompt")
    if BRIEF_RE.search(text):
        tags.append("brief")
    score = agent_style_score(text)
    if AGENT_PREFIX_RE.search(text) or score >= 4:
        tags.append("agent_authored")  # an orchestrator's `rd say`, recorded as owner-typed
    elif score == 3:
        tags.append("maybe_agent")
    tags.append("short" if n <= 200 else "medium" if n <= 800 else "long")
    if NEG_START_RE.search(text):
        tags.append("kw:neg_start")
    for k, rx in KW_RE.items():
        if rx.search(text):
            tags.append("kw:" + k)
    if "?" in text:
        tags.append("has_q")
    if prev_text:
        tail = prev_text[-500:]
        if tail.rstrip().endswith("?") or "?" in tail[-250:]:
            tags.append("after_question")
        if PERM_RE.search(tail):
            tags.append("after_permission_ask")
        if DONE_RE.search(tail):
            tags.append("after_done_claim")
        if BLOCKED_RE.search(tail):
            tags.append("after_blocked")
        if re.search(r"API Error", tail[-300:]):
            tags.append("after_api_error")  # the agent died on a transient API error; the owner typed 'continue'
    if gap_s is not None:
        tags.append("reply<2m" if gap_s < 120 else "reply<15m" if gap_s < 900 else "gap>15m")
    return tags


def is_candidate(tags, n):
    """Pre-filter only. Never briefs or agent-authored text. A first prompt only when it is a
    short report or question. Otherwise: a short message, a steering message typed mid-turn,
    a keyword, or a reply to an agent turn that asked / claimed done / was blocked."""
    if "brief" in tags or "agent_authored" in tags:
        return False
    ctx = any(t.startswith("after_") for t in tags)
    kw = any(t.startswith("kw:") for t in tags)
    if "kw:frustrated" in tags:
        return n <= 4000  # a frustrated owner is the strongest intervention signal, whatever the length
    if "first_prompt" in tags:
        return n <= 1200 and (any(t in tags for t in ("kw:why", "kw:neg_start", "kw:broken")) or (n <= 400 and (kw or "has_q" in tags)))
    if n > 1500:
        return False
    if "queued" in tags:
        return n <= 800 or kw
    return n <= 400 or (kw and n <= 800) or (ctx and n <= 500)


# ----------------------------------------------------------------------------- transcripts


def _assistant_info(raw):
    try:
        d = json.loads(raw)
    except ValueError:
        return None, [], None, None
    m = d.get("message") or {}
    parts = m.get("content")
    text, tools = "", []
    if isinstance(parts, list):
        text = "\n".join(p.get("text", "") for p in parts if p.get("type") == "text")
        tools = [p.get("name") for p in parts if p.get("type") == "tool_use"]
    elif isinstance(parts, str):
        text = parts
    return text, tools, m.get("stop_reason"), d.get("timestamp")


def _human_text(d):
    """(text, has_image) of an owner message entry, or (None, False) when it is not one."""
    typ = d.get("type")
    if typ == "attachment":
        a = d.get("attachment") or {}
        if a.get("type") != "queued_command" or (a.get("origin") or {}).get("kind") != "human":
            return None, False
        p = a.get("prompt")
        if isinstance(p, list):
            p = "\n".join(x.get("text", "") for x in p if isinstance(x, dict) and x.get("type") == "text")
        return (p if isinstance(p, str) else None), False
    if typ != "user" or d.get("isMeta") or (d.get("origin") or {}).get("kind") != "human":
        return None, False
    c = (d.get("message") or {}).get("content")
    if isinstance(c, str):
        return c, False
    if isinstance(c, list):
        if any(p.get("type") == "tool_result" for p in c if isinstance(p, dict)):
            return None, False
        text = "\n".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text")
        return text, any(p.get("type") == "image" for p in c if isinstance(p, dict))
    return None, False


def scan_file(path, host, since, until, seen, stats):
    session = os.path.basename(path)[:-6]
    prev_raw, seen_assistant = None, False
    asks = {}  # tool_use_id -> (question, ts) for AskUserQuestion
    out = []
    with open(path, "rb") as fh:
        for raw in fh:
            if raw.startswith(b'{"parentUuid"') and A_MARK in raw:
                prev_raw, seen_assistant = raw, True
                if ASK_MARK in raw:
                    try:
                        for p in json.loads(raw)["message"]["content"]:
                            if p.get("name") == "AskUserQuestion":
                                qs = (p.get("input") or {}).get("questions") or [{}]
                                asks[p["id"]] = (qs[0].get("question", ""), json.loads(raw).get("timestamp"))
                    except (ValueError, KeyError, TypeError):
                        pass
                continue
            if asks and b'"tool_result"' in raw and raw.startswith(b'{"parentUuid"'):
                try:
                    d = json.loads(raw)
                    for p in (d.get("message") or {}).get("content") or []:
                        if isinstance(p, dict) and p.get("type") == "tool_result" and p.get("tool_use_id") in asks:
                            q, qts = asks.pop(p["tool_use_id"])
                            ans = p.get("content")
                            ans = ans if isinstance(ans, str) else json.dumps(ans)
                            rec = _record(d, host, session, q + "  =>  " + ans, "", False, False, False, "ask", None, seen, stats, since, until, qts)
                            if rec:
                                out.append(rec)
                except (ValueError, TypeError):
                    pass
                continue
            if H_MARK not in raw:
                continue
            try:
                d = json.loads(raw)
            except ValueError:
                continue
            text, has_image = _human_text(d)
            if text is None:
                continue
            first = not seen_assistant
            queued = d.get("type") == "attachment"
            ptext, ptools, pstop, pts = (None, [], None, None)
            if prev_raw is not None:
                ptext, ptools, pstop, pts = _assistant_info(prev_raw)
            rec = _record(d, host, session, text, ptext or "", first, queued, has_image, "queued" if queued else "typed", (ptools, pstop, pts), seen, stats, since, until, None)
            if rec:
                out.append(rec)
    return out


def _record(d, host, session, text, prev_text, first, queued, has_image, kind, prev, seen, stats, since, until, prev_ts_override):
    uuid = (d.get("uuid") or "")[:8]
    ts = d.get("timestamp")
    if not ts:
        return None
    t = parse_ts(ts)
    if not (since <= t < until):
        return None
    key = d.get("uuid") or (ts, text[:40])
    if key in seen:
        stats["duplicate_entries"] += 1
        return None
    seen.add(key)
    if kind != "ask":
        stats["human_entries"] += 1  # in-window, de-duplicated entries that carry the human marker
    text = clean_text(text)
    if not text or text.startswith(SKIP_PREFIX):
        stats["skipped_non_text_or_command"] += 1
        return None
    ptools, pstop, pts = prev if prev else ([], None, prev_ts_override)
    gap = None
    if pts:
        try:
            gap = (t - parse_ts(pts)).total_seconds()
        except ValueError:
            gap = None
    tags = tag_message(text, prev_text or "", first, queued, gap)
    if kind == "ask":
        tags = ["ask_user_question", "short" if len(text) <= 200 else "medium", "after_question"]
    if has_image:
        tags.append("has_image")
    if "brief" in tags and kind != "ask":
        stats["dropped_brief"] += 1
        return None
    if "agent_authored" in tags and kind != "ask":
        stats["dropped_agent_authored"] += 1
        return None
    if kind != "ask" and not is_candidate(tags, len(text)):
        stats["dropped_by_prefilter"] += 1
        return None
    cwd = home_path(d.get("cwd"))
    iu = is_iu(d.get("cwd"), d.get("gitBranch"))
    return {
        "host": host,
        "session": session[:8],
        "uuid": uuid,
        "ts": iso(t),
        "kind": kind,
        "cwd": cwd,
        "iu": iu,
        "n": len(text),
        "text": None if iu else text[:600],
        "prev_text": None if iu else (prev_text[-400:] if prev_text else None),
        "prev_tools": sorted(set(x for x in (ptools or []) if x))[:6],
        "prev_stop": pstop,
        "gap_s": None if gap is None else int(gap),
        "tags": tags,
    }


def scan_transcripts(root, since, until, host):
    import socket

    seen, stats = set(), collections.Counter()
    out = []
    since_ts = since.timestamp()
    if not os.path.isdir(root):
        return {"host": host, "hostname": socket.gethostname(), "records": [], "stats": {"missing_root": 1}}
    for dirname in sorted(os.listdir(root)):
        if SKIP_DIR.search(dirname):
            stats["skipped_agent_only_dirs"] += 1
            continue
        for dirpath, dirnames, filenames in os.walk(os.path.join(root, dirname)):
            if "subagents" in dirnames:
                dirnames.remove("subagents")  # subagent sessions carry no owner
            for fn in sorted(filenames):
                if not fn.endswith(".jsonl"):
                    continue
                path = os.path.join(dirpath, fn)
                try:
                    if os.stat(path).st_mtime < since_ts:
                        continue
                except OSError:
                    continue
                stats["files_scanned"] += 1
                out.extend(scan_file(path, host, since, until, seen, stats))
    return {"host": host, "hostname": socket.gethostname(), "records": out, "stats": dict(stats)}


def cmd_scan_transcripts(args):
    """Remote entry: print one JSON document with the raw matches (no redaction lib needed)."""
    res = scan_transcripts(args.root or PROJECTS, parse_ts(args.since), parse_ts(args.until), args.host)
    json.dump(res, sys.stdout)
    return 0


# ----------------------------------------------------------------------------- human-queue


def hq_candidates(snap, since, until):
    base = os.path.join(snap, "human-queue")
    out, stats = [], collections.Counter()
    for fn in sorted(os.listdir(base)):
        if not fn.endswith(".req"):
            continue
        with open(os.path.join(base, fn)) as fh:
            req = json.load(fh)
        t = parse_ts(req["created"])
        if not (since <= t < until):
            continue
        res, rp = None, os.path.join(base, fn[:-4] + ".res")
        if os.path.exists(rp):
            try:
                with open(rp) as fh:
                    res = json.load(fh)
            except ValueError:
                res = None
        status = (res or {}).get("status", "pending")
        text, cmd = req.get("text") or "", req.get("cmd") or ""
        iu = is_iu(req.get("cwd"))
        tags = ["status:" + status]
        if re.match(r"(?i)retry|second try|third try", text) or re.search(r"(?i)\bretry\b", text[:60]):
            tags.append("retry")
        if re.search(r"\bop (?:read|item|run|create|edit)\b|secrets-run|secrets-seed|make secrets", cmd + text):
            tags.append("op_biometric")
        if "sudo" in cmd:
            tags.append("sudo")
        if re.search(r"(?i)tailnet acl|acl push|tailscale-acl", cmd + text):
            tags.append("acl_push")
        if re.search(r"(?i)re-?seal|re-?seed|secrets cache|secrets-seed", cmd + text):
            tags.append("reseal_cache")
        if re.search(r"(?i)\bgui\b|click|screen share|system settings|tcc|full disk", text):
            tags.append("gui")
        if iu:
            tags.append("iuroot")
        stats[status] += 1
        out.append({
            "id": "hq:" + req["id"],
            "source": "human-queue",
            "ts": iso(t),
            "closed_ts": norm_ts(res["ran_at"]) if res and res.get("ran_at") else None,
            "repo": repo_of(req.get("cwd")),
            "excerpt": None if iu or PERSONAL_RE.search(text) else scrub(text),
            "excerpt_withheld": "iuroot" if iu else ("personal-detail" if PERSONAL_RE.search(text) else None),
            "tags": tags,
            "exit": (res or {}).get("exit"),
        })
    return out, dict(stats)


# ----------------------------------------------------------------------------- warden


def warden_candidates(snap, since, until):
    con = sqlite3.connect("file:" + os.path.join(snap, "warden.db") + "?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    lo, hi = since.isoformat(), until.isoformat()
    out, stats = [], collections.Counter()

    def item_ctx(event_id, bound):
        """The escalation this owner touch answers: the latest transition into needs_decision
        at or before the touch (never a later re-escalation of the same item)."""
        q = con.execute(
            "select note, at from item_transitions where event_id=? and to_state='needs_decision' and at<=? order by id desc limit 1",
            (event_id, min(bound, hi)),
        ).fetchone()
        first = con.execute("select first_seen, signature from triage_items where event_id=?", (event_id,)).fetchone()
        return q, first

    rows = con.execute(
        """select t.id, t.event_id, t.to_state, t.at, t.note, i.repo
           from item_transitions t join triage_items i on i.event_id = t.event_id
           where t.from_state = 'needs_decision' and t.at >= ? and t.at < ? order by t.at, t.id""",
        (lo, hi),
    ).fetchall()
    for r in rows:
        note = r["note"] or ""
        tags = ["to:" + r["to_state"]]
        if note.startswith("closed by hand"):
            tags.append("closed_by_hand")
        elif note.startswith("re-investigation requested"):
            tags.append("reinvestigation_cli")
        elif note.startswith("adopted by owner"):
            tags.append("adopted_by_owner")
        elif note.startswith("event recovered on its own"):
            tags.append("auto_recovered")
        else:
            tags.append("other_note")
        if "improve loop" in note:
            tags.append("improve_loop")
        stats[[t for t in tags if t != "improve_loop"][1]] += 1
        if "auto_recovered" in tags:
            continue  # not an owner touch: counted, not a candidate
        q, first = item_ctx(r["event_id"], r["at"])
        out.append({
            "id": "wd:%d" % r["id"],
            "source": "warden-needs_decision",
            "ts": norm_ts(r["at"]),
            "closed_ts": norm_ts(r["at"]),
            "repo": r["repo"] or "?",
            "event_id": r["event_id"],
            "excerpt": scrub(re.sub(r"^(closed by hand|re-investigation requested via CLI|adopted by owner):\s*", "", note) or "(no note: answered through Argo)"),
            "question": scrub(q["note"]) if q else None,
            "escalated_ts": norm_ts(q["at"]) if q else None,
            "first_seen": norm_ts(first["first_seen"]) if first and first["first_seen"] else None,
            "tags": tags,
        })
    # operations authorised outside the loop
    for r in con.execute(
        """select op_id, event_id, kind, repo, authorized_by, started_at, outcome, note from operations
           where (authorized_by like 'owner:%' or authorized_by like 'cli:%') and started_at >= ? and started_at < ?
           order by started_at""",
        (lo, hi),
    ).fetchall():
        title = None
        if r["event_id"]:
            q, _ = item_ctx(r["event_id"], r["started_at"])
            title = q["note"] if q else None
        out.append({
            "id": "op:" + r["op_id"][:8],
            "source": "warden-operation",
            "ts": norm_ts(r["started_at"]),
            "closed_ts": None,
            "repo": r["repo"],
            "event_id": r["event_id"],
            "excerpt": scrub("%s authorised by %s%s" % (r["kind"], r["authorized_by"], (" - " + title) if title else "")),
            "tags": ["authorized_by:" + r["authorized_by"], "kind:" + r["kind"], "outcome:" + str(r["outcome"])],
        })
        stats["operations_owner_or_cli"] += 1
    # still waiting on the owner at AS_OF (censored, reported not dropped)
    open_n = con.execute("select count(*) from triage_items where state='needs_decision'").fetchone()[0]
    stats["open_needs_decision_at_snapshot"] = open_n
    return out, dict(stats)


# ----------------------------------------------------------------------------- candidates


def run_macbook(since, until, attempts=4):
    """Run this very script on the MacBook (`python3 -` reads it from stdin), parse its JSON.
    The MacBook sleeps with the lid closed, so retry a few times before giving up."""
    src = open(os.path.abspath(__file__), "rb").read()
    cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "iumac",
           "python3 - scan-transcripts --host macbook --since %s --until %s" % (iso(since), iso(until))]
    err = ""
    for k in range(attempts):
        p = subprocess.run(cmd, input=src, capture_output=True)  # no agent here: plain CLI helper
        if p.returncode == 0 and p.stdout:
            return json.loads(p.stdout.decode("utf-8")), None
        err = p.stderr.decode("utf-8", "replace")[-300:]
        if k < attempts - 1:
            time.sleep(10)
    return None, err


PERSONAL_REPOS = {"brain"}  # the owner's personal vault: chat about life, not about the factory
SIGNAL_TAG = re.compile(r"^(kw:|after_|queued$|ask_user_question$|first_prompt$)")


def withheld_reason(repo, tags, *texts):
    """Why an excerpt is not written: IuRoot (rule), a personal-vault session, a personal detail
    in the text, or no intervention signal at all (a bare short reply tells the judge nothing
    and may be private chat)."""
    if "iuroot" in tags:
        return "iuroot"
    if repo in PERSONAL_REPOS:
        return "personal-session"
    if any(t and PERSONAL_RE.search(t) for t in texts):
        return "personal-detail"
    if not any(SIGNAL_TAG.match(t) for t in tags):
        return "no-signal-tag"
    return None


def tx_candidates(res):
    register_hostname(res.get("hostname"))
    out = []
    for r in res["records"]:
        iu = r["iu"]
        repo = repo_of(r["cwd"])
        why = withheld_reason(repo, r["tags"] + (["iuroot"] if iu else []), r["text"], r["prev_text"])
        out.append({
            "id": "tx:%s:%s:%s" % (r["host"], r["session"], r["uuid"]),
            "source": "transcript-" + r["host"],
            "ts": r["ts"],
            "closed_ts": None,
            "repo": repo,
            "excerpt": None if why or r["text"] is None else scrub(r["text"]),
            "excerpt_withheld": why,
            "prev": None if why or not r["prev_text"] else scrub(r["prev_text"][-300:]),
            "kind": r["kind"],
            "gap_s": r["gap_s"],
            "n_chars": r["n"],
            "tags": r["tags"] + (["iuroot"] if iu else []),
        })
    return out


def cmd_candidates(args):
    until = parse_ts(AS_OF)
    since = until - dt.timedelta(days=args.days)
    snap = os.path.join(SNAP_ROOT, AS_OF[:10])
    # The MacBook first: its hostname must be known before any text is redacted, because
    # an owner message pasted from a shell prompt carries it into either machine's transcripts.
    remote, err = (None, None) if args.no_macbook else run_macbook(since, until)
    if remote is not None:
        register_hostname(remote.get("hostname"))
    hq, hq_stats = hq_candidates(snap, since, until)
    wd, wd_stats = warden_candidates(snap, since, until)
    local = scan_transcripts(PROJECTS, since, until, "mini")
    tx = tx_candidates(local)
    tx_stats = {"mini": local["stats"]}
    if remote is not None:
        tx += tx_candidates(remote)
        tx_stats["macbook"] = remote["stats"]
    else:
        # MacBook skipped or unreachable: carry over its candidates from the previous run (already
        # redacted) rather than silently dropping a whole machine from the pool.
        prev_path = PRIVATE_CANDS if os.path.exists(PRIVATE_CANDS) else os.path.join(HERE, "candidates.out.json")
        old, kept = [], {}
        if os.path.exists(prev_path):
            with open(prev_path) as fh:
                prev = json.load(fh)
            old = [c for c in prev["candidates"] if c["source"] == "transcript-macbook"]
            kept = {k: v for k, v in prev["stats"]["transcripts"].get("macbook", {}).items()
                    if k not in ("error", "reason", "carried_over_from_previous_run")}
        tx_stats["macbook"] = dict(kept, carried_over_from_previous_run=len(old),
                                   reason="skipped (--no-macbook)" if args.no_macbook else "unreachable: " + scrub(err or "", 160))
        tx += old
    cands = sorted(hq + wd + tx, key=lambda c: (c["ts"], c["id"]), reverse=True)
    out = {
        "as_of": AS_OF,
        "window": {"from": iso(since), "to": iso(until), "days": args.days},
        "count": len(cands),
        "by_source": dict(sorted(collections.Counter(c["source"] for c in cands).items())),
        "by_day": dict(sorted(collections.Counter(c["ts"][:10] for c in cands).items(), reverse=True)),
        "stats": {"human_queue": hq_stats, "warden": wd_stats, "transcripts": tx_stats},
        "note": "Candidates are heuristic tags over owner-typed messages, human-queue asks and warden "
                "owner touches. Newest first. IuRoot excerpts are withheld. Judgement lives in judgments.json.",
        "candidates": cands,
    }
    os.makedirs(PRIVATE_DIR, exist_ok=True)
    with open(PRIVATE_CANDS, "w") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    with open(os.path.join(HERE, "candidates.out.json"), "w") as fh:
        json.dump(_strip_excerpts(out), fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print("candidates:", len(cands), out["by_source"])
    return 0


# ----------------------------------------------------------------------------- context (stdout only)


def context_rows(session, uuid, before, after):
    """Neighbouring assistant / owner entries of one owner message (raw text, no redaction)."""
    path = None
    for dirpath, dirnames, filenames in os.walk(PROJECTS):
        if "subagents" in dirnames:
            dirnames.remove("subagents")
        for fn in filenames:
            if fn.startswith(session) and fn.endswith(".jsonl"):
                path = os.path.join(dirpath, fn)
    if not path:
        return None
    rows = []
    with open(path, "rb") as fh:
        for raw in fh:
            if not raw.startswith(b'{"parentUuid"'):
                continue
            try:
                d = json.loads(raw)
            except ValueError:
                continue
            typ = d.get("type")
            if typ == "assistant":
                parts = (d.get("message") or {}).get("content") or []
                txt = " ".join(p.get("text", "") for p in parts if isinstance(p, dict) and p.get("type") == "text")
                tl = [[p.get("name"), json.dumps(p.get("input"))[:90]] for p in parts if isinstance(p, dict) and p.get("type") == "tool_use"]
                rows.append({"ts": d.get("timestamp"), "who": "A", "u": d.get("uuid", "")[:8], "text": txt, "tools": tl})
            elif typ in ("user", "attachment"):
                text, _ = _human_text(d)
                if text is not None:
                    rows.append({"ts": d.get("timestamp"), "who": "H" + ("q" if typ == "attachment" else ""), "u": d.get("uuid", "")[:8], "text": text, "tools": []})
    idx = next((i for i, r in enumerate(rows) if r["u"] == uuid), None)
    if idx is None:
        return None
    lo, hi = max(0, idx - before), min(len(rows), idx + after + 1)
    return [dict(r, hit=(i == idx)) for i, r in enumerate(rows[lo:hi], lo)]


def cmd_context(args):
    """Print the redacted neighbourhood of a transcript candidate for judging. Nothing is written."""
    m = re.match(r"tx:(mini|macbook):([0-9a-f]{8}):([0-9a-f]{8})$", args.id)
    if not m:
        print("context supports tx:<host>:<session>:<uuid> ids only")
        return 1
    host, session, uuid = m.groups()
    if args.json:  # remote leg: raw rows, redaction happens on the calling side
        rows = context_rows(session, uuid, args.before, args.after)
        json.dump(rows, sys.stdout)
        return 0 if rows else 1
    if host == "mini":
        rows = context_rows(session, uuid, args.before, args.after)
    else:
        cmd = ["ssh", "-o", "BatchMode=yes", "iumac", "python3 - context tx:mini:%s:%s --json --before %d --after %d" % (session, uuid, args.before, args.after)]
        p = subprocess.run(cmd, input=open(os.path.abspath(__file__), "rb").read(), capture_output=True)
        rows = json.loads(p.stdout.decode("utf-8")) if p.returncode == 0 and p.stdout else None
    if not rows:
        print("message not found")
        return 1
    for r in rows:
        tools = ", ".join("%s%s" % (n, a) for n, a in r["tools"][:3])
        print("%s %s %s %s: %s%s" % (">>" if r["hit"] else "  ", norm_ts(r["ts"]), r["who"], r["u"], scrub(r["text"], args.width) if r["text"] else "", (" tools=" + scrub(tools, 240)) if tools else ""))
    return 0


# ----------------------------------------------------------------------------- report


def rd(text):
    """redact() without clipping, for the hand-written fields of judgments.json."""
    t = URL_RE.sub(_url, text or "")
    for pat, repl in EXTRA:
        t = pat.sub(repl, t)
    if _HOST_RE:
        t = _HOST_RE.sub("<host>", t)
    return _redact()(t)


PRIVATE_DIR = os.path.expanduser("~/.local/share/factory/private")
PRIVATE_CANDS = os.path.join(PRIVATE_DIR, "interventions.candidates.json")


def _strip_excerpts(obj):
    """The public file keeps ids, times, tags and classes; owner-message text stays private."""
    if isinstance(obj, dict):
        return {k: _strip_excerpts(v) for k, v in obj.items() if k not in ("excerpt", "text", "excerpts")}
    if isinstance(obj, list):
        return [_strip_excerpts(v) for v in obj]
    return obj


def cmd_report(args):
    with open(os.path.join(HERE, "judgments.json")) as fh:
        j = json.load(fh)
    with open(PRIVATE_CANDS if os.path.exists(PRIVATE_CANDS) else os.path.join(HERE, "candidates.out.json")) as fh:
        meta = json.load(fh)
    cand = {c["id"]: c for c in meta["candidates"]}
    judged_from = j["judged_from"]
    judged = [c for c in meta["candidates"] if judged_from <= c["ts"] < AS_OF]
    items = j["interventions"]
    problems = []
    for it in items:
        if it["class"] not in CLASSES:
            problems.append("bad class %r in #%s" % (it["class"], it["n"]))
        if it["genuinely_owner"] not in ("y", "n"):
            problems.append("bad genuinely_owner in #%s" % it["n"])
        for m in it["mechanism"]:
            if m not in MECHANISMS:
                problems.append("bad mechanism %r in #%s" % (m, it["n"]))
        for s in it["sources"]:
            if s not in cand:
                problems.append("unknown candidate %s in #%s" % (s, it["n"]))
    if problems:
        print("\n".join(problems))
        return 1
    items.sort(key=lambda it: it["when"], reverse=True)
    out_items = []
    for k, it in enumerate(items, 1):
        srcs = [cand[s] for s in it["sources"]]
        out_items.append({
            "n": k,
            "when": it["when"],
            "signal_ts": it.get("signal_ts"),
            "closure_ts": it.get("closure_ts"),
            "repo": it["repo"],
            "repos": it.get("repos") or [it["repo"]],
            "episode": it.get("episode"),
            "sources": [{"id": s["id"], "source": s["source"], "ts": s["ts"]} for s in srcs],
            "iuroot": bool(it.get("iuroot")),
            "signal": rd(it["signal"]),
            "agent_did": rd(it["agent_did"]),
            "owner_did": rd(it["owner_did"]),
            "closure": rd(it["closure"]),
            "class": it["class"],
            "genuinely_owner": it["genuinely_owner"],
            "ideal_path": rd(it["ideal_path"]),
            "mechanism": it["mechanism"],
        })
    n = len(out_items)
    by_class = collections.Counter(i["class"] for i in out_items)
    by_repo = collections.Counter(r for i in out_items for r in i["repos"])
    by_src = collections.Counter(s["source"] for i in out_items for s in i["sources"])
    by_mech = collections.Counter(m for i in out_items for m in i["mechanism"])
    by_episode = collections.Counter(i["episode"] or ("single:%d" % i["n"]) for i in out_items)
    genuine = sum(1 for i in out_items if i["genuinely_owner"] == "y")
    summary = {
        "n": n,
        "genuinely_owner": genuine,
        "genuinely_owner_share": round(genuine / n, 3) if n else None,
        "by_class": {c: by_class.get(c, 0) for c in CLASSES},
        "by_repo": dict(sorted(by_repo.items(), key=lambda kv: (-kv[1], kv[0]))),
        "by_source_row": dict(sorted(by_src.items())),
        "by_mechanism": {m: by_mech.get(m, 0) for m in MECHANISMS},
        "span": {"from": out_items[-1]["when"], "to": out_items[0]["when"]},
        "span_hours": round((parse_ts(out_items[0]["when"]) - parse_ts(out_items[-1]["when"])).total_seconds() / 3600, 1),
        "episodes": len(by_episode),
        "by_episode": {k: v for k, v in sorted(by_episode.items(), key=lambda kv: (-kv[1], kv[0])) if not k.startswith("single:")},
        "removable_without_owner": n - genuine,
    }
    tstats = meta["stats"]["transcripts"]
    human_marked = sum(v.get("human_entries", 0) for v in tstats.values())
    agent_typed = sum(v.get("dropped_agent_authored", 0) for v in tstats.values())
    pool = {
        "window": meta["window"],
        "candidates_total": meta["count"],
        "candidates_by_source": meta["by_source"],
        "judged_from": judged_from,
        "judged_candidates": len(judged),
        "judged_by_source": dict(sorted(collections.Counter(c["source"] for c in judged).items())),
        "transcript_entries_with_human_origin_marker": human_marked,
        "of_which_agent_authored_dropped": agent_typed,
        "human_queue_status_in_window": meta["stats"]["human_queue"],
        "warden_needs_decision_exits_in_window": meta["stats"]["warden"],
    }
    doc = {
        "as_of": AS_OF,
        "definition": "owner_touch / genuine_escalation_share (DEFINITIONS.md); genuine = product direction, spend, irreversible data loss, other people",
        "pool": pool,
        "summary": summary,
        "interventions": out_items,
        "not_counted": j.get("not_counted", []),
    }
    with open(os.path.join(HERE, "interventions.out.json"), "w") as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    with open(os.path.join(HERE, "interventions.md"), "w") as fh:
        fh.write(render_md(doc, j))
    print("report:", n, "interventions,", genuine, "genuinely the owner's")
    return 0


def fmt_when(ts):
    return ts.replace("T", " ").replace(":00Z", "Z") if ts.endswith(":00Z") else ts.replace("T", " ")


def render_md(doc, j):
    s, items, pool = doc["summary"], doc["interventions"], doc["pool"]
    L = []
    w = L.append
    w("# The twenty latest owner interventions, raw signal to closure")
    w("")
    w("As of %s. Mechanical part: `interventions.py` (candidates, `candidates.out.json`). Judgement: `judgments.json`. Rendered into `interventions.out.json` and this file by `interventions.py report`." % doc["as_of"])
    w("")
    w("**How to read.** *When* is the moment the owner acted (a typed message, an approval click, an answer in Argo), UTC, newest first. An intervention is one owner action needed to unblock, correct or decide; several sources describing the same action are one entry, and distinct actions in one episode stay distinct (the `episode` field links them). *Genuinely the owner's* applies the fixed rule: only product direction, spend, irreversible data loss and other people are the owner's, nothing else. Owner quotes are translated or short; IuRoot sessions show repo and class only. A candidate is a heuristic tag set, never a verdict: I judged newest first and stopped at twenty distinct owner actions. New tasks, design talk, status pings, personal chat and agents relaying agents are not interventions.")
    w("")
    w("**Pool.** Window %s to %s (%d d). %d candidates: %s. I read all %d candidates since %s (%s) and a second pass over what the prefilter dropped. The harness records text that an orchestrator types into a worker pane (`rd say`) as owner-typed: %d of %d entries with the human marker in the window were agent-authored and are dropped before any candidate exists." % (
        pool["window"]["from"], pool["window"]["to"], pool["window"]["days"], pool["candidates_total"],
        ", ".join("%s %d" % kv for kv in pool["candidates_by_source"].items()),
        pool["judged_candidates"], pool["judged_from"], ", ".join("%s %d" % kv for kv in pool["judged_by_source"].items()),
        pool["of_which_agent_authored_dropped"], pool["transcript_entries_with_human_origin_marker"]))
    w("")
    for para in j.get("intro", []):
        w(rd(para))
        w("")
    top = ", ".join("%s (%d)" % kv for kv in list(s["by_episode"].items())[:2])
    y_all_business = all(i["class"] == "business decision" for i in items if i["genuinely_owner"] == "y")
    n_any_business = any(i["class"] == "business decision" for i in items if i["genuinely_owner"] == "n")
    why = ("each of them is in the business-decision class and no other class was genuine" if y_all_business and not n_any_business
           else "the class column shows which")
    w("**Headline.** %d of %d were genuinely the owner's (%.0f %%): %s. The %d interventions are %d episodes spanning %s to %s (%.0f h); the largest are %s." % (
        s["genuinely_owner"], s["n"], 100 * s["genuinely_owner_share"], why, s["n"], s["episodes"],
        fmt_when(s["span"]["from"]), fmt_when(s["span"]["to"]), s["span_hours"], top))
    w("")
    w("## The interventions, newest first")
    w("")
    for i in items:
        src = ", ".join(sorted({x["source"] for x in i["sources"]}))
        w("### %d. %s, %s (%s)" % (i["n"], fmt_when(i["when"]), i["repo"], src))
        w("")
        if i["episode"]:
            w("- **Episode:** %s" % i["episode"])
        if i["iuroot"]:
            w("- **IuRoot session:** repo name and class only; the content is withheld by rule.")
        else:
            w("- **Signal:** %s" % i["signal"])
            w("- **Agent/system did:** %s" % i["agent_did"])
            w("- **Owner had to:** %s" % i["owner_did"])
            w("- **Closure:** %s" % i["closure"])
        w("- **Class:** %s. **Genuinely the owner's:** %s." % (i["class"], i["genuinely_owner"]))
        if i["iuroot"]:
            w("- **Ideal path** (mechanism only): %s." % ", ".join(i["mechanism"]))
        else:
            w("- **Ideal path** (%s): %s" % (", ".join(i["mechanism"]), i["ideal_path"]))
        w("")
    w("## Summary")
    w("")
    w("| Class | n |")
    w("|-|-|")
    for c in CLASSES:
        w("| %s | %d |" % (c, s["by_class"][c]))
    w("| **total** | **%d** |" % s["n"])
    w("")
    w("| Genuinely the owner's (y) | Removable (n) | Share y |")
    w("|-|-|-|")
    w("| %d | %d | %.0f %% |" % (s["genuinely_owner"], s["removable_without_owner"], 100 * s["genuinely_owner_share"]))
    w("")
    w("This share is among interventions, not items: the 0.1 % target is per warden item and has a different denominator.")
    w("")
    w("| Repo (an entry spanning several repos counts once in each) | n |")
    w("|-|-|")
    for r, c in s["by_repo"].items():
        w("| %s | %d |" % (r, c))
    w("")
    w("| Mechanism that removes the need (an entry can cite several) | entries |")
    w("|-|-|")
    for m in MECHANISMS:
        w("| %s | %d |" % (m, s["by_mechanism"][m]))
    w("")
    w("| Episode with more than one entry | entries |")
    w("|-|-|")
    for e, c in s["by_episode"].items():
        w("| %s | %d |" % (e, c))
    w("")
    w("| # | When (UTC) | Repo | Class | Owner's |")
    w("|-|-|-|-|-|")
    for i in items:
        w("| %d | %s | %s | %s | %s |" % (i["n"], fmt_when(i["when"]), i["repo"], i["class"], i["genuinely_owner"]))
    w("")
    for para in j.get("outro", []):
        w(rd(para))
        w("")
    if doc["not_counted"]:
        w("## Not counted, and why")
        w("")
        for line in doc["not_counted"]:
            w("- " + rd(line))
        w("")
    return "\n".join(L).rstrip() + "\n"


# ----------------------------------------------------------------------------- main


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("candidates")
    c.add_argument("--days", type=int, default=21)
    c.add_argument("--no-macbook", action="store_true")
    c.set_defaults(fn=cmd_candidates)
    s = sub.add_parser("scan-transcripts")
    s.add_argument("--host", default="mini")
    s.add_argument("--since", required=True)
    s.add_argument("--until", required=True)
    s.add_argument("--root")
    s.set_defaults(fn=cmd_scan_transcripts)
    x = sub.add_parser("context")
    x.add_argument("id")
    x.add_argument("--before", type=int, default=3)
    x.add_argument("--after", type=int, default=3)
    x.add_argument("--width", type=int, default=400)
    x.add_argument("--json", action="store_true", help=argparse.SUPPRESS)
    x.set_defaults(fn=cmd_context)
    r = sub.add_parser("report")
    r.set_defaults(fn=cmd_report)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
