#!/usr/bin/env python3
"""git_delivery — how much was delivered, how much of it was rework, and by whom.

Question
    Per repo over the 90 days before AS_OF: commit volume per week, owner vs bot authors,
    revert rate, rework share (new definition) next to the old `fix`-prefix proxy, and how
    much of the history can be attributed to agents.

Definition keys (evidence/DEFINITIONS.md)
    revert_rate   commits whose subject starts `Revert "` or has type `revert` / all commits,
                  plus warden's own half (items with revert_pr or reverting_sha / items merged
                  by warden, from the frozen warden.db).
    rework_share  commits of type `fix` or `revert` that touch >= 1 file changed by another
                  commit in the preceding 7 days / all commits. The `fix`-prefix proxy
                  (fix commits / all commits) is reported alongside for continuity only.

Choices the definitions leave open (stated, not hidden)
    * Repos: every directory directly under ~/SourceRoot and ~/IuRoot whose `.git` is a
      directory. Linked worktrees (`.git` is a file) share their parent's history and are listed
      as skipped, never counted twice. The set of checkouts is live: a repo cloned after AS_OF is
      still analysed and flagged in `inventory.checkouts_created_after_as_of`.
    * History: the default branch only (origin/HEAD, else origin/main|master, else the local
      branch). The remote-tracking ref wins over the local branch because the local one can lag
      (the divergence is recorded per repo). No fetch is run; staleness is recorded as the tip
      date and the FETCH_HEAD date.
    * Window: committer date in [AS_OF - 90 d, AS_OF). Rework looks back 7 days further than the
      window (history is read from AS_OF - 100 d) so the first window days are not under-counted.
    * "Another commit in the preceding 7 days": any earlier commit in git's topological order
      whose committer date is at most 7 days before the fix/revert commit (ties and rebased
      batches that share one timestamp are ordered by the graph, not by the clock).
    * Merge commits are reported separately and are not in `commits` (they carry no diff of
      their own; the findings' proxy also excluded them).
    * Commit type: conventional-commit prefix, with an optional leading ticket id
      (`EP-123: fix: ...`). Subjects that do not parse count as `untyped`.

Inputs
    git (read-only `git log`, `git for-each-ref`, `git rev-list`) in ~/SourceRoot/* and
    ~/IuRoot/*; ~/.local/share/factory/snapshots/<AS_OF date>/warden.db (SQLite, mode=ro).

IuRoot rule
    Counts only. No subjects, paths, branch names, author identities or SHAs are written for
    IuRoot repos; the inputs are read in memory and reduced to numbers.

Run
    python3 -I git_delivery.py            (AS_OF=2026-10-22T08:00:00Z overrides the default)
    -> git_delivery.out.json, git_delivery.out.md
"""

import datetime as dt
import json
import os
import re
import sqlite3
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True  # evidence scripts write only their own outputs, never a __pycache__
sys.path.insert(0, str(HERE.parent / "lib"))
from redact import redact  # noqa: E402

AS_OF_STR = os.environ.get("AS_OF", "2026-10-22T08:00:00Z")
AS_OF = dt.datetime.fromisoformat(AS_OF_STR.replace("Z", "+00:00"))
AS_OF_TS = int(AS_OF.timestamp())
WINDOW_DAYS = 90
REWORK_DAYS = 7
LOOKBACK_DAYS = 100  # window + rework look-back + slack for git's --after early stop
W0_TS = AS_OF_TS - WINDOW_DAYS * 86400
HIST0 = AS_OF - dt.timedelta(days=LOOKBACK_DAYS)
SNAP = Path(os.environ.get("FACTORY_SNAPSHOTS", Path.home() / ".local/share/factory/snapshots")) / AS_OF_STR[:10]
MIN_COMMITS_FOR_RANKING = 25
REWRITTEN_GAP_S = 60

ROOTS = [("SourceRoot", Path.home() / "SourceRoot"), ("IuRoot", Path.home() / "IuRoot")]

# Identity facts. The owner commits under two names and several emails; agents commit as the
# owner by design (agent-gateway's dispatch lane documents "there is no bot author here").
OWNER_NAMES = {"jkrumm", "johannes krumm"}
OWNER_EMAIL_RX = re.compile(r"^(?:\d+\+)?jkrumm@users\.noreply\.github\.com$|^jkrumm@|^johannes\.krumm@", re.I)
AGENT_NAMES = {"hermes"}
BOT_RX = re.compile(r"\[bot\]|(?:^|[-_ ])bot$|^dependabot|^renovate|github-actions|semantic-release|^gitlab|^ci$", re.I)
WEB_COMMITTER_RX = re.compile(r"^GitHub$|^GitLab$", re.I)
AGENT_BRANCH_RX = re.compile(r"^(?:origin/)?(?:dispatch|wave|warden|agw|fan|claude|codex|hermes|w\d+)(?:[/-]|$)", re.I)
MERGE_BRANCH_RXS = [
    re.compile(r"^Merge (?:remote-tracking )?branch '([^']+)'"),
    re.compile(r"^Merge pull request #\d+ from [^/\s]+/(\S+)"),
]
TYPE_RX = re.compile(r"^(?:[A-Z][A-Z0-9]+-\d+[:\s-]+\s*)?(?P<type>[A-Za-z]+)(?:\([^)]*\))?!?:(?:\s|$)")
REVERT_SUBJECT_RX = re.compile(r'^Revert "')
KNOWN_TYPES = {"feat", "fix", "docs", "chore", "refactor", "test", "tests", "perf", "build", "ci", "style", "revert", "release"}
# warden's `repo` is free text; one rename is known (sideclaw -> agent-gateway, 2026-10-09).
WARDEN_REPO_ALIAS = {"sideclaw": "agent-gateway"}

RS, US, GS = "\x1e", "\x1f", "\x1d"
LOG_FORMAT = RS + US.join(["%H", "%ct", "%at", "%an", "%ae", "%cn", "%ce", "%P", "%s",
                           "%(trailers:key=Claude-Session,valueonly,unfold)"]) + GS


def git(repo: Path, *args: str, timeout: int = 600) -> tuple[int, str]:
    try:
        r = subprocess.run(
            ["git", "-C", str(repo), "-c", "core.quotePath=false", *args],
            capture_output=True, text=True, errors="replace", timeout=timeout,
            env={**os.environ, "GIT_PAGER": "cat", "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C.UTF-8"},
        )
    except subprocess.TimeoutExpired:
        return 124, ""
    return r.returncode, r.stdout


def iso(ts: int) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def day(ts: int) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%d")


def iso_week(ts: int) -> str:
    y, w, _ = dt.datetime.fromtimestamp(ts, dt.timezone.utc).isocalendar()
    return f"{y}-W{w:02d}"


def ratio(n: int, d: int) -> float | None:
    return round(n / d, 4) if d else None


def classify_author(name: str, email: str) -> str:
    n, e = name.strip().lower(), email.strip().lower()
    if n in AGENT_NAMES or e.split("@")[0] in AGENT_NAMES:
        return "agent_identity"
    if BOT_RX.search(name) or BOT_RX.search(e.split("@")[0]):
        return "bot"
    if n in OWNER_NAMES or OWNER_EMAIL_RX.search(e):
        return "owner"
    return "other_human"


def commit_type(subject: str) -> str | None:
    if REVERT_SUBJECT_RX.match(subject):
        return "revert"
    m = TYPE_RX.match(subject)
    if not m:
        return None
    t = m.group("type").lower()
    return "test" if t == "tests" else t


def resolve_ref(repo: Path) -> tuple[str | None, str, dict]:
    """Default-branch ref, how it was found, and local-vs-remote divergence."""
    info: dict = {}
    code, out = git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    candidates: list[tuple[str, str]] = []
    if code == 0 and out.strip():
        candidates.append((out.strip(), "origin/HEAD"))
    candidates += [("origin/main", "origin/main heuristic"), ("origin/master", "origin/master heuristic"),
                   ("main", "local main"), ("master", "local master")]
    code, out = git(repo, "symbolic-ref", "--short", "HEAD")
    if code == 0 and out.strip():
        candidates.append((out.strip(), "current branch"))
    for ref, how in candidates:
        if git(repo, "rev-parse", "--verify", "--quiet", ref + "^{commit}")[0] == 0:
            if ref.startswith("origin/"):
                local = ref[len("origin/"):]
                if git(repo, "rev-parse", "--verify", "--quiet", local + "^{commit}")[0] == 0:
                    c, o = git(repo, "rev-list", "--left-right", "--count", f"{local}...{ref}")
                    if c == 0 and len(o.split()) == 2:
                        info = {"local_ahead_of_remote": int(o.split()[0]), "local_behind_remote": int(o.split()[1])}
            return ref, how, info
    return None, "none", info


def read_history(repo: Path, ref: str) -> list[dict]:
    """Commits oldest->newest (topological) with committer date < AS_OF and within the look-back."""
    code, out = git(repo, "log", ref, "--topo-order", "--reverse", f"--before={AS_OF_STR}",
                    f"--after={HIST0.strftime('%Y-%m-%dT%H:%M:%SZ')}", "--name-only", "--no-renames",
                    f"--format={LOG_FORMAT}")
    if code != 0:
        return []
    commits = []
    for rec in out.split(RS):
        if not rec.strip():
            continue
        head, _, files_txt = rec.partition(GS)
        f = head.split(US)
        if len(f) < 10:
            continue
        ct = int(f[1])
        if ct >= AS_OF_TS:
            continue
        commits.append({
            "sha": f[0], "ct": ct, "at": int(f[2]), "an": f[3], "ae": f[4], "cn": f[5], "ce": f[6],
            "parents": len(f[7].split()), "subject": f[8], "trailer": bool(f[9].strip()),
            "files": {x for x in files_txt.split("\n") if x},
        })
    return commits


def annotate(hist: list[dict]) -> None:
    """In place, oldest -> newest: author class, commit type and the rework flags.

    Rework pass over the full look-back; a commit counts as rework when it is a fix/revert and touches a file
    that an earlier commit (graph order) changed at most 7 days before it. Reused by dora.py.
    """
    last_touch_any: dict[str, int] = {}
    last_touch_nonbot: dict[str, int] = {}
    for c in hist:
        is_merge = c["parents"] > 1
        c["cls"] = classify_author(c["an"], c["ae"])
        c["type"] = commit_type(c["subject"])
        c["rework"] = c["rework_nonbot"] = False
        if is_merge:
            continue
        if c["type"] in ("fix", "revert") and c["files"]:
            c["rework"] = any(f in last_touch_any and c["ct"] - last_touch_any[f] <= REWORK_DAYS * 86400 for f in c["files"])
            c["rework_nonbot"] = any(f in last_touch_nonbot and c["ct"] - last_touch_nonbot[f] <= REWORK_DAYS * 86400 for f in c["files"])
        for f in c["files"]:
            last_touch_any[f] = max(last_touch_any.get(f, 0), c["ct"])
            if c["cls"] != "bot":
                last_touch_nonbot[f] = max(last_touch_nonbot.get(f, 0), c["ct"])


def analyse_repo(name: str, root: str, path: Path, ledger: dict[str, set[str]]) -> dict:
    ref, how, divergence = resolve_ref(path)
    rec: dict = {"repo": name, "root": root, "ref": ref, "ref_found_by": how}
    if not ref:
        rec["error"] = "no default branch ref"
        return rec
    # `live` holds what is true of the checkout at run time and moves after AS_OF (so re-runs differ only here).
    live: dict = dict(divergence)
    fh = path / ".git" / "FETCH_HEAD"
    live["last_fetch_date"] = day(int(fh.stat().st_mtime)) if fh.exists() else None
    try:
        born = int((path / ".git").stat().st_birthtime)
        live["checkout_created_date"] = day(born)
        live["checkout_created_after_as_of"] = born >= AS_OF_TS  # history is still valid for AS_OF; the clone is just newer
    except (OSError, AttributeError):
        live["checkout_created_date"] = None
    rec["live"] = live
    # Last commit on the ref at or before AS_OF: shows how stale an un-fetched remote-tracking ref was.
    c, o = git(path, "log", "-1", "--format=%ct", f"--before={AS_OF_STR}", ref)
    rec["tip_date"] = day(int(o.strip())) if c == 0 and o.strip() else None

    hist = read_history(path, ref)
    annotate(hist)
    win = [c for c in hist if W0_TS <= c["ct"] < AS_OF_TS]

    plain = [c for c in win if c["parents"] <= 1]
    merges = [c for c in win if c["parents"] > 1]
    n = len(plain)
    rec["commits"] = n
    rec["merge_commits"] = len(merges)
    rec["commits_30d"] = sum(1 for c in plain if c["ct"] >= AS_OF_TS - 30 * 86400)
    rec["commits_14d"] = sum(1 for c in plain if c["ct"] >= AS_OF_TS - 14 * 86400)
    rec["commits_per_week"] = round(n / (WINDOW_DAYS / 7), 2)
    rec["first_commit_in_window"] = day(min(c["ct"] for c in plain)) if plain else None
    rec["last_commit_in_window"] = day(max(c["ct"] for c in plain)) if plain else None

    authors = Counter(c["cls"] for c in plain)
    rec["authors"] = {k: authors.get(k, 0) for k in ("owner", "bot", "agent_identity", "other_human")}
    rec["owner_share"] = ratio(authors.get("owner", 0), n)
    if root == "SourceRoot":
        rec["non_owner_identities"] = sorted({redact(c["an"]) for c in plain if c["cls"] in ("bot", "agent_identity")})
    rec["committer_is_web_flow"] = sum(1 for c in plain if WEB_COMMITTER_RX.match(c["cn"]))

    types = Counter(c["type"] or "untyped" for c in plain)
    rec["types"] = {k: types[k] for k in sorted(types) if k in KNOWN_TYPES or k == "untyped"}
    rec["types_other"] = sum(v for k, v in types.items() if k not in KNOWN_TYPES and k != "untyped")
    rec["typed_share"] = ratio(n - types.get("untyped", 0), n)

    fix_typed = sum(1 for c in plain if c["type"] == "fix")
    fix_prefix = sum(1 for c in plain if c["subject"].lower().startswith("fix"))
    rec["fix_proxy"] = {"fix_prefixed": fix_prefix, "fix_typed": fix_typed, "share": ratio(fix_prefix, n)}

    reverts = [c for c in plain if c["type"] == "revert"]
    rec["revert"] = {"count": len(reverts), "rate": ratio(len(reverts), n),
                     "subject_mentions_revert_loose": sum(1 for c in plain if "revert" in c["subject"].lower())}
    if root == "SourceRoot":
        rec["revert"]["commits"] = [{"sha": c["sha"][:10], "date": day(c["ct"])} for c in reverts]

    rw = [c for c in plain if c["rework"]]
    rw_nb = [c for c in plain if c["rework_nonbot"]]
    bots = authors.get("bot", 0)
    rec["rework"] = {
        "count": len(rw),
        "share": ratio(len(rw), n),
        "fix_commits": sum(1 for c in rw if c["type"] == "fix"),
        "revert_commits": sum(1 for c in rw if c["type"] == "revert"),
        "fix_or_revert_commits": sum(1 for c in plain if c["type"] in ("fix", "revert")),
        "fix_or_revert_without_files": sum(1 for c in plain if c["type"] in ("fix", "revert") and not c["files"]),
        "share_excl_bot_commits": ratio(sum(1 for c in rw_nb if c["cls"] != "bot"), n - bots) if bots else None,
        "share_of_fix_or_revert": ratio(len(rw), sum(1 for c in plain if c["type"] in ("fix", "revert"))),
    }

    weeks: dict[str, Counter] = defaultdict(Counter)
    for c in plain:
        w = iso_week(c["ct"])
        weeks[w]["commits"] += 1
        weeks[w]["fix_proxy"] += c["subject"].lower().startswith("fix")
        weeks[w]["rework"] += c["rework"]
        weeks[w]["revert"] += c["type"] == "revert"
        weeks[w]["trailer"] += c["trailer"]
    rec["weekly"] = {w: dict(weeks[w]) for w in sorted(weeks)}

    # Agent signals. Counts only; how each was detected is in the docstring/notes of the output.
    ledger_hits = sum(1 for c in plain if c["sha"] in ledger.get(name, set()))
    branch_hits: Counter = Counter()
    for c in merges:
        for rx in MERGE_BRANCH_RXS:
            m = rx.match(c["subject"])
            if m:
                branch_hits["agent_named" if AGENT_BRANCH_RX.match(m.group(1)) else "other_named"] += 1
                break
        else:
            branch_hits["unparsed"] += 1
    c1, refs = git(path, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin", "refs/heads")
    names = [r for r in refs.split("\n") if r and r not in ("origin", ref)]
    c2, merged_out = git(path, "branch", "-r", "--merged", ref, "--format=%(refname:short)")
    merged_names = {r for r in merged_out.split("\n") if r} if c2 == 0 else set()
    agent_names = [r for r in names if AGENT_BRANCH_RX.match(r)]
    rec["agent_signals"] = {
        "claude_session_trailer": sum(1 for c in plain if c["trailer"]),
        "agent_identity_author": authors.get("agent_identity", 0),
        "bot_author": bots,
        "warden_ledger_merge_commits": ledger_hits,
        "rewritten_committer_date": sum(1 for c in plain if abs(c["ct"] - c["at"]) > REWRITTEN_GAP_S),
        "committer_name_differs_from_author": sum(1 for c in plain if c["cn"] != c["an"]),
        "merge_commit_branch_names": dict(branch_hits),
    }
    live.update({"agent_named_branches_total": len(agent_names),
                 "agent_named_branches_merged_into_default": sum(1 for r in agent_names if r in merged_names),
                 "branches_total": len(names)})
    rec["_trailer_days"] = sorted({day(c["ct"]) for c in plain if c["trailer"]})
    rec["_plain"] = [(c["ct"], c["trailer"], c["cls"]) for c in plain]
    return rec


def warden_half() -> dict:
    db = SNAP / "warden.db"
    if not db.exists():
        return {"error": f"missing snapshot {db.name}; run snapshot.sh"}
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    lo, hi = iso(W0_TS)[:19], AS_OF_STR[:19]
    rows = con.execute(
        "SELECT COALESCE(NULLIF(repo,''),'<none>'), merged_sha IS NOT NULL, (revert_pr IS NOT NULL OR reverting_sha IS NOT NULL) "
        "FROM triage_items WHERE created_at >= ? AND created_at < ? AND duplicate_of IS NULL AND COALESCE(close_reason,'') != 'duplicate'",
        (lo, hi)).fetchall()
    per: dict[str, Counter] = defaultdict(Counter)
    for repo, merged, reverted in rows:
        repo = WARDEN_REPO_ALIAS.get(repo, repo)
        per[repo]["items"] += 1
        per[repo]["merged"] += bool(merged)
        per[repo]["reverted"] += bool(reverted)
    tot = Counter()
    for v in per.values():
        tot.update(v)
    merge_ops = con.execute(
        "SELECT COUNT(*), SUM(outcome='done') FROM operations WHERE kind='merge' AND started_at >= ? AND started_at < ?",
        (lo, hi)).fetchone()
    return {
        "definition": "items (not duplicates) created in the window; merged = merged_sha set; reverted = revert_pr or reverting_sha set",
        "items": tot["items"], "merged_by_warden": tot["merged"], "reverted": tot["reverted"],
        "revert_rate": ratio(tot["reverted"], tot["merged"]),
        "merge_operations_in_window": {"total": merge_ops[0], "done": merge_ops[1] or 0},
        "per_repo": {r: {"items": per[r]["items"], "merged": per[r]["merged"], "reverted": per[r]["reverted"]}
                     for r in sorted(per) if per[r]["merged"] or per[r]["reverted"]},
    }


def warden_ledger_shas() -> dict[str, set[str]]:
    """repo -> full SHAs warden merged (merge receipts + items.merged_sha). SourceRoot repos only."""
    db = SNAP / "warden.db"
    out: dict[str, set[str]] = defaultdict(set)
    if not db.exists():
        return out
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    for repo, receipt in con.execute("SELECT repo, receipt_json FROM operations WHERE kind='merge' AND outcome='done'"):
        try:
            sha = json.loads(receipt or "{}").get("mergeCommit")
        except json.JSONDecodeError:
            continue
        if sha:
            out[WARDEN_REPO_ALIAS.get(repo, repo)].add(sha)
    for repo, sha in con.execute("SELECT repo, merged_sha FROM triage_items WHERE merged_sha IS NOT NULL"):
        out[WARDEN_REPO_ALIAS.get(repo or "", repo or "")].add(sha)
    return out


def discover() -> tuple[list[tuple[str, str, Path]], list[dict], list[dict]]:
    repos, worktrees, non_git = [], [], []
    for root_name, root in ROOTS:
        if not root.is_dir():
            continue
        for p in sorted(root.iterdir(), key=lambda x: x.name):
            if not p.is_dir() or p.name.startswith("."):
                continue
            g = p / ".git"
            if g.is_dir():
                repos.append((root_name, p.name, p))
            elif g.is_file():
                c, o = git(p, "rev-parse", "--git-common-dir")
                parent = Path(o.strip()).parent.name if c == 0 and o.strip() else None
                worktrees.append({"dir": p.name, "root": root_name, "worktree_of": parent})
            else:
                non_git.append({"dir": p.name, "root": root_name})
    return repos, worktrees, non_git


def pooled(recs: list[dict]) -> dict:
    n = sum(r["commits"] for r in recs)
    t = Counter()
    for r in recs:
        t["owner"] += r["authors"]["owner"]
        t["bot"] += r["authors"]["bot"]
        t["agent_identity"] += r["authors"]["agent_identity"]
        t["other_human"] += r["authors"]["other_human"]
        t["fix_prefixed"] += r["fix_proxy"]["fix_prefixed"]
        t["revert"] += r["revert"]["count"]
        t["rework"] += r["rework"]["count"]
        t["trailer"] += r["agent_signals"]["claude_session_trailer"]
        t["rewritten"] += r["agent_signals"]["rewritten_committer_date"]
        t["merges"] += r["merge_commits"]
    return {
        "repos": len(recs), "repos_with_commits": sum(1 for r in recs if r["commits"]), "commits": n,
        "merge_commits": t["merges"], "commits_per_week": round(n / (WINDOW_DAYS / 7), 1),
        "authors": {k: t[k] for k in ("owner", "bot", "agent_identity", "other_human")},
        "fix_proxy_share": ratio(t["fix_prefixed"], n), "fix_prefixed": t["fix_prefixed"],
        "revert_count": t["revert"], "revert_rate": ratio(t["revert"], n),
        "rework_count": t["rework"], "rework_share": ratio(t["rework"], n),
        "claude_session_trailer": t["trailer"], "rewritten_committer_date": t["rewritten"],
    }


def agent_share(recs: list[dict]) -> dict:
    """Overall agent attribution, pooled over SourceRoot repos only (IuRoot stays per-repo counts)."""
    src = [r for r in recs if r["root"] == "SourceRoot"]
    total = sum(r["commits"] for r in src)
    tr = sum(r["agent_signals"]["claude_session_trailer"] for r in src)
    days = sorted({d for r in src for d in r["_trailer_days"]})
    weekly: dict[str, Counter] = defaultdict(Counter)
    for r in src:
        for ct, trailer, cls in r["_plain"]:
            weekly[iso_week(ct)]["commits"] += 1
            weekly[iso_week(ct)]["trailer"] += trailer
    series = {w: {"commits": weekly[w]["commits"], "trailer": weekly[w]["trailer"],
                  "trailer_share": ratio(weekly[w]["trailer"], weekly[w]["commits"])} for w in sorted(weekly)}
    qualifying = [(w, v["trailer_share"]) for w, v in series.items() if v["commits"] >= 100 and v["trailer_share"] is not None]
    peak = max(qualifying, key=lambda x: x[1]) if qualifying else None
    saturated = [w for w, v in series.items() if v["commits"] >= 100 and (v["trailer_share"] or 0) >= 0.5]
    sat_commits = sum(series[w]["commits"] for w in saturated)
    sat_trailer = sum(series[w]["trailer"] for w in saturated)
    ident = sum(r["agent_signals"]["agent_identity_author"] for r in src)
    ledger = sum(r["agent_signals"]["warden_ledger_merge_commits"] for r in src)
    rewritten = sum(r["agent_signals"]["rewritten_committer_date"] for r in src)
    differs = sum(r["agent_signals"]["committer_name_differs_from_author"] for r in src)
    in_period = None
    if days:
        lo = dt.datetime.strptime(days[0], "%Y-%m-%d").replace(tzinfo=dt.timezone.utc).timestamp()
        hi = dt.datetime.strptime(days[-1], "%Y-%m-%d").replace(tzinfo=dt.timezone.utc).timestamp() + 86400
        n_in = sum(1 for r in src for ct, _, _ in r["_plain"] if lo <= ct < hi)
        in_period = {"first_day": days[0], "last_day": days[-1], "commits_in_period": n_in,
                     "with_trailer": tr, "share": ratio(tr, n_in)}
    return {
        "scope": "SourceRoot repos pooled (IuRoot trailer counts stay per repo in repos[].agent_signals)",
        "commits": total,
        "detected_certain": {
            "claude_session_trailer": tr, "claude_session_trailer_share_of_90d": ratio(tr, total),
            "agent_identity_author": ident, "warden_ledger_merge_commits": ledger,
            "bot_author_automation_not_agent": sum(r["agent_signals"]["bot_author"] for r in src),
        },
        "trailer_first_to_last_day": in_period,
        "trailer_saturated_weeks": {"weeks": saturated, "commits": sat_commits, "with_trailer": sat_trailer,
                                    "share": ratio(sat_trailer, sat_commits),
                                    "rule": "weeks with >= 100 commits where >= 50% carry the trailer; its value is a claude.ai/code session URL, so a Claude Code session wrote the commit"},
        "trailer_peak_week": {"week": peak[0], "share": peak[1]} if peak else None,
        "trailer_weekly": series,
        "landed_through_a_branch": {
            "rewritten_committer_date": rewritten, "share": ratio(rewritten, total),
            "committer_name_differs_from_author": differs, "differs_share": ratio(differs, total),
            "meaning": "committer date differs from author date by > 60 s: the commit was rebased, cherry-picked or "
                       "rebase-merged after it was written, which is what branch lanes (rd merge, warden merge train, "
                       "agw dispatch PRs) do. Owner-driven branch work does it too, so this is a lane indicator, not authorship.",
        },
    }


def fmt_pct(x: float | None) -> str:
    return "-" if x is None else f"{x * 100:.1f}%"


def write_md(out: dict, path: Path) -> None:
    recs = [r for r in out["repos"] if "error" not in r]
    L = []
    L.append("# git_delivery — delivery, rework and reverts")
    L.append("")
    L.append(f"AS_OF `{out['as_of']}`, window {WINDOW_DAYS} d (committer date in [{out['window_start']}, AS_OF)), "
             f"default branch only. Definition keys: `revert_rate`, `rework_share`. Script: `git_delivery.py`.")
    L.append("")
    L.append("## Pooled")
    L.append("")
    L.append("|scope|repos|commits|per week|owner|bot|agent identity|other human|fix proxy|rework share|reverts|")
    L.append("|-|-|-|-|-|-|-|-|-|-|-|")
    for key in ("all", "SourceRoot", "IuRoot"):
        p = out["pooled"][key]
        a = p["authors"]
        L.append(f"|{key}|{p['repos_with_commits']}/{p['repos']}|{p['commits']}|{p['commits_per_week']}|{a['owner']}|{a['bot']}|"
                 f"{a['agent_identity']}|{a['other_human']}|{fmt_pct(p['fix_proxy_share'])}|{fmt_pct(p['rework_share'])}|"
                 f"{p['revert_count']} ({fmt_pct(p['revert_rate'])})|")
    L.append("")
    L.append("## Commits per week (all repos pooled)")
    L.append("")
    L.append("|week|commits|rework|rework share|reverts|busiest repo|its share|")
    L.append("|-|-|-|-|-|-|-|")
    for wk, v in out["weekly_pooled"].items():
        L.append(f"|{wk}|{v['commits']}|{v['rework']}|{fmt_pct(v['rework_share'])}|{v['revert']}|{v['top_repo']}|{fmt_pct(v['top_repo_share'])}|")
    L.append("")
    for title, key in (("Top 10 by rework share", "top_rework_share"), ("Top 10 by revert rate", "top_revert_rate")):
        L.append(f"## {title} (repos with >= {MIN_COMMITS_FOR_RANKING} commits)")
        L.append("")
        L.append("|repo|root|commits|rework|rework share|fix proxy|reverts|revert rate|")
        L.append("|-|-|-|-|-|-|-|-|")
        for r in out["rankings"][key]:
            L.append(f"|{r['repo']}|{r['root']}|{r['commits']}|{r['rework']}|{fmt_pct(r['rework_share'])}|{fmt_pct(r['fix_proxy_share'])}|"
                     f"{r['reverts']}|{fmt_pct(r['revert_rate'])}|")
        L.append("")
    L.append("## Top 10 by absolute reverts")
    L.append("")
    L.append("|repo|root|reverts|commits|")
    L.append("|-|-|-|-|")
    for r in out["rankings"]["top_revert_count"]:
        L.append(f"|{r['repo']}|{r['root']}|{r['reverts']}|{r['commits']}|")
    L.append("")
    w = out["warden_revert_half"]
    L.append("## Warden's half of revert_rate")
    L.append("")
    if "error" in w:
        L.append(w["error"])
    else:
        L.append(f"Items in window (not duplicates): {w['items']}; merged by warden (`merged_sha`): {w['merged_by_warden']}; "
                 f"with `revert_pr` or `reverting_sha`: {w['reverted']}; revert rate {fmt_pct(w['revert_rate'])}. "
                 f"Merge operations in window: {w['merge_operations_in_window']['done']} done of {w['merge_operations_in_window']['total']}.")
    L.append("")
    a = out["agent_share"]
    L.append("## Agent share of commits")
    L.append("")
    L.append(f"Scope: {a['scope']}. Commits: {a['commits']}.")
    L.append("")
    d = a["detected_certain"]
    L.append("|signal|commits|share of 90 d|")
    L.append("|-|-|-|")
    L.append(f"|`Claude-Session` trailer|{d['claude_session_trailer']}|{fmt_pct(d['claude_session_trailer_share_of_90d'])}|")
    L.append(f"|agent identity (Hermes)|{d['agent_identity_author']}|{fmt_pct(ratio(d['agent_identity_author'], a['commits']))}|")
    L.append(f"|warden ledger merge commits|{d['warden_ledger_merge_commits']}|{fmt_pct(ratio(d['warden_ledger_merge_commits'], a['commits']))}|")
    L.append(f"|bot author (automation, not agent)|{d['bot_author_automation_not_agent']}|{fmt_pct(ratio(d['bot_author_automation_not_agent'], a['commits']))}|")
    lb = a["landed_through_a_branch"]
    L.append(f"|landed through a branch (committer date != author date) - lane indicator|{lb['rewritten_committer_date']}|{fmt_pct(lb['share'])}|")
    L.append("")
    if a["trailer_first_to_last_day"]:
        p = a["trailer_first_to_last_day"]
        sw = a["trailer_saturated_weeks"]
        L.append(f"The trailer appears from {p['first_day']} to {p['last_day']} only ({p['with_trailer']} of {p['commits_in_period']} commits in that span, "
                 f"{fmt_pct(p['share'])}) and is absent afterwards. In the saturated weeks {', '.join(sw['weeks']) or 'none'} "
                 f"{sw['with_trailer']} of {sw['commits']} commits carry it ({fmt_pct(sw['share'])}): the lower bound on the share of commits made inside a Claude Code session.")
        L.append("")
    L.append("|week|commits|with trailer|share|")
    L.append("|-|-|-|-|")
    for wk, v in a["trailer_weekly"].items():
        L.append(f"|{wk}|{v['commits']}|{v['trailer']}|{fmt_pct(v['trailer_share'])}|")
    L.append("")
    L.append("## Every repo")
    L.append("")
    L.append("|repo|root|ref|commits|per wk|owner|bot|agent|other|fix proxy|rework|rework share|reverts|trailer|branch-landed|tip|")
    L.append("|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|")
    for r in sorted(recs, key=lambda x: (-x["commits"], x["repo"])):
        a_ = r["authors"]
        s = r["agent_signals"]
        L.append(f"|{r['repo']}|{r['root']}|{r['ref']}|{r['commits']}|{r['commits_per_week']}|{a_['owner']}|{a_['bot']}|"
                 f"{a_['agent_identity']}|{a_['other_human']}|{fmt_pct(r['fix_proxy']['share'])}|{r['rework']['count']}|"
                 f"{fmt_pct(r['rework']['share'])}|{r['revert']['count']}|{s['claude_session_trailer']}|{s['rewritten_committer_date']}|{r['tip_date']}|")
    L.append("")
    L.append("## Repo inventory")
    L.append("")
    inv = out["inventory"]
    L.append(f"Repos analysed: {inv['analysed']} ({inv['SourceRoot']} SourceRoot, {inv['IuRoot']} IuRoot). "
             f"Linked worktrees skipped as duplicates of their parent: {', '.join(f'{w['dir']} (of {w['worktree_of']})' for w in out['skipped_worktrees']) or 'none'}. "
             f"Non-git directories: {', '.join(f'{x['root']}/{x['dir']}' for x in out['non_git_dirs']) or 'none'}. "
             f"Checkouts created after AS_OF (history still counted): {', '.join(inv['checkouts_created_after_as_of']) or 'none'}.")
    L.append("")
    L.append("## Notes")
    L.append("")
    for n in out["notes"]:
        L.append(f"- {n}")
    L.append("")
    path.write_text("\n".join(L), encoding="utf-8")


def main() -> int:
    repos, worktrees, non_git = discover()
    ledger = warden_ledger_shas()
    recs = [analyse_repo(name, root, path, ledger) for root, name, path in repos]
    ok = [r for r in recs if "error" not in r]

    def rank(key, reverse=True, pool=True):
        pool_ = [r for r in ok if r["commits"] >= MIN_COMMITS_FOR_RANKING] if pool else [r for r in ok if r["commits"]]
        return sorted(pool_, key=key, reverse=reverse)

    def row(r):
        return {"repo": r["repo"], "root": r["root"], "commits": r["commits"], "rework": r["rework"]["count"],
                "rework_share": r["rework"]["share"], "fix_proxy_share": r["fix_proxy"]["share"],
                "reverts": r["revert"]["count"], "revert_rate": r["revert"]["rate"]}

    rankings = {
        "min_commits": MIN_COMMITS_FOR_RANKING,
        "top_rework_share": [row(r) for r in rank(lambda r: (r["rework"]["share"] or 0, r["commits"]))[:10]],
        "top_revert_rate": [row(r) for r in rank(lambda r: (r["revert"]["rate"] or 0, r["commits"]))[:10]],
        "top_revert_count": [row(r) for r in rank(lambda r: (r["revert"]["count"], r["commits"]), pool=False)[:10]],
        "top_rework_count": [row(r) for r in rank(lambda r: (r["rework"]["count"], r["commits"]), pool=False)[:10]],
    }
    weeks = sorted({w for r in ok for w in r["weekly"]})
    weekly_pooled = {}
    for w in weeks:
        per = {r["repo"]: r["weekly"][w] for r in ok if w in r["weekly"]}
        tot = sum(v["commits"] for v in per.values())
        top = max(per.items(), key=lambda kv: kv[1]["commits"])
        weekly_pooled[w] = {
            "commits": tot,
            "fix_proxy": sum(v["fix_proxy"] for v in per.values()),
            "rework": sum(v["rework"] for v in per.values()),
            "revert": sum(v["revert"] for v in per.values()),
            "rework_share": ratio(sum(v["rework"] for v in per.values()), tot),
            "top_repo": top[0], "top_repo_share": ratio(top[1]["commits"], tot),
        }
    agent = agent_share(ok)
    for r in ok:
        r.pop("_trailer_days", None)
        r.pop("_plain", None)

    out = {
        "script": "git_delivery.py",
        "definition_keys": ["revert_rate", "rework_share"],
        "as_of": AS_OF_STR,
        "window_days": WINDOW_DAYS,
        "window_start": iso(W0_TS),
        "rework_lookback_days": REWORK_DAYS,
        "history_read_from": iso(int(HIST0.timestamp())),
        "weeks": weeks,
        "weekly_pooled": weekly_pooled,
        "inventory": {"analysed": len(ok), "SourceRoot": sum(1 for r in ok if r["root"] == "SourceRoot"),
                      "IuRoot": sum(1 for r in ok if r["root"] == "IuRoot"),
                      "worktrees_skipped": len(worktrees), "non_git_dirs": len(non_git),
                      "checkouts_created_after_as_of": sorted(r["repo"] for r in ok if r["live"].get("checkout_created_after_as_of"))},
        "skipped_worktrees": worktrees,
        "non_git_dirs": non_git,
        "pooled": {"all": pooled(ok), "SourceRoot": pooled([r for r in ok if r["root"] == "SourceRoot"]),
                   "IuRoot": pooled([r for r in ok if r["root"] == "IuRoot"])},
        "rankings": rankings,
        "warden_revert_half": warden_half(),
        "agent_share": agent,
        "repos": sorted(recs, key=lambda r: (r["root"], r["repo"])),
        "notes": [redact(x) for x in [
            "commits excludes merge commits (reported as merge_commits); the findings' fix-proxy numbers excluded them too.",
            "ref is the remote-tracking default branch when present; live.local_ahead_of_remote / live.local_behind_remote show where the local branch differs "
            "(a local branch behind the remote is why older counts, e.g. shutterflow, are lower). No fetch is run: tip_date (last commit on the ref at or before AS_OF) shows how fresh each ref is. "
            "Everything under `live` is true of the checkout at run time, not at AS_OF, and is the only part of this file that changes between re-runs.",
            "rework_share uses committer dates; history is read from AS_OF - 100 d so a fix in the first week of the window still sees its 7-day past. "
            "share_excl_bot_commits drops bot-authored commits both as the fix and as the 'other commit' (release bumps touch package.json/CHANGELOG).",
            "Agent attribution cannot come from identity: agents commit as the owner by design (agent-gateway dispatch-git.ts: 'there is no bot author here'). "
            "The Claude-Session trailer is the only direct marker and exists only for part of the window; detection methods are listed in agent_share.",
            "A merge-commit's branch name is parsed from the subject; branches deleted after a rebase-merge leave no trace in git, so branch-name detection undercounts.",
            "Not done here: after W39 no marker survives in git. Joining the Claude Code transcripts (a `git commit` tool result per commit, matched on author time and subject) would close the gap "
            "but means streaming ~15 GB of transcripts for the window, which is not a re-runnable stdlib step.",
            "IuRoot repos are reduced to counts: no subjects, paths, branch names, identities or SHAs are written for them.",
            "The set of checkouts is live, not frozen: a repo cloned after AS_OF is still analysed (its history predates AS_OF) and is flagged checkout_created_after_as_of.",
        ]],
    }
    (HERE / "git_delivery.out.json").write_text(json.dumps(out, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    write_md(out, HERE / "git_delivery.out.md")
    print(f"git_delivery: {len(ok)} repos, {out['pooled']['all']['commits']} commits "
          f"(rework {fmt_pct(out['pooled']['all']['rework_share'])}, fix proxy {fmt_pct(out['pooled']['all']['fix_proxy_share'])})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
