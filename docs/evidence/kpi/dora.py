#!/usr/bin/env python3
"""dora — the five DORA metrics, where the data allows.

Question
    How often does delivery reach production, how long does a change take to get there, how often
    does a deploy hurt, how fast is a failed deploy undone, and how many deploys are unplanned rework?

Definition keys (evidence/DEFINITIONS.md)
    dora.*  deployment frequency, lead time for changes (first commit of a change -> deployed),
            change failure rate (deploys followed within 24 h by an item on the same repo or a revert),
            failed-deployment recovery time, deployment rework rate (deploys that ship an unplanned fix /
            all deploys). Each states its data source and coverage.

Deploy records read (every source is listed in `sources` with what it covers and what it cannot see)
    actions      GitHub Actions deploy workflows of the SourceRoot repos (`gh api`, read-only; skipped with
                 a stated reason if `gh` cannot run non-interactively). Authoritative where it exists:
                 head sha, push time, completion time, conclusion.
    rollhook     warden `events` source=slack_update, the RollHook "Deployed <service> Image: <registry>/<svc>:<sha>"
                 and "Deployment failed" notices relayed through Slack (frozen warden.db). Lossy relay.
    warden_op    warden `operations` kind=deploy (the verify lane's `make deploy` / `git pull` runs, from 2026-09-29).
    poller       ~/Library/Logs/research-gateway-deploy.log, the mini deploy poller (CI-gated, timestamped).
    Examined and rejected as deploy records: `github_go` events (GitHub issues/alerts that start warden work,
    not deployments) and free-text `make deploy` mentions in warden-cli.log / agent-gateway.jsonl.

Choices the definition leaves open (stated, not hidden)
    * A deployment is a successful production deploy of a distinct (repo, commit). Two services of one repo
      deployed from one commit are one deployment (service-level counts are reported next to it); a repeat
      of the same commit in the same stream is a redeploy, counted separately.
    * Lead time: for every commit first reaching production in a deployment, deploy time minus author time
      (when the commit was written). The "first commit of a change" reading is the oldest commit in the
      deployment. The first deployment of a repo has no predecessor and is excluded.
    * Change failure: a deployment is flagged when a failure-signal warden item (origin alert, or an
      `[alert]` GitHub issue) on the same repo or a `Revert` commit on its default branch appears within
      24 h after it. Items exist only from the first triage item (2026-08-28), so the denominator starts
      there, and deployments in the last 24 h before AS_OF are excluded (follow-up incomplete). Any-origin
      items and "attribute an item to the latest deploy only" are reported as sensitivities.
    * Failed-deployment recovery: from a failed deployment to the next successful one in the same stream
      (same service/workflow); failures with no later success are censored at AS_OF.
    * Deployment rework: three nested readings, lower to upper (see `deployment_rework_rate`).

Inputs
    frozen ~/.local/share/factory/snapshots/<AS_OF date>/warden.db (SQLite mode=ro); git (read-only) in the
    SourceRoot repos via git_delivery.py; GitHub Actions via `gh`; the research-gateway deploy log.
    IuRoot repos are out of scope: their deploys run through GitLab CI, which is not queried (counts-only rule).

Run
    python3 -I dora.py        (AS_OF=2026-10-22T08:00:00Z overrides; DORA_GH=0 skips GitHub)
    -> dora.out.json, dora.out.md
"""

import bisect
import datetime as dt
import json
import os
import re
import sqlite3
import statistics
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True  # importing git_delivery must not leave a __pycache__ in the evidence tree
sys.path.insert(0, str(HERE.parent / "lib"))
sys.path.insert(0, str(HERE))
from redact import redact  # noqa: E402
import git_delivery as gd  # noqa: E402

UTC = dt.timezone.utc
AS_OF_STR, AS_OF_TS, SNAP = gd.AS_OF_STR, gd.AS_OF_TS, gd.SNAP
WINDOWS = {"90d": 90, "30d": 30, "14d": 14}
W90 = AS_OF_TS - 90 * 86400
DEPLOY_LOOKBACK = AS_OF_TS - 150 * 86400
HORIZON = 24 * 3600
# Sources that record every push-to-production (a workflow per push, a CI-gated poller); the others are partial.
COMPLETE_SOURCES = {"actions", "poller"}
POLLER_LOG = Path.home() / "Library/Logs/research-gateway-deploy.log"
# Services whose name does not start with their repo's name.
SERVICE_REPO = {
    "fpp-server": "free-planning-poker", "fpp-analytics": "free-planning-poker", "fpp-analytics-updater": "free-planning-poker",
    "bun-email-api": "email-gateway", "image-gen-gateway": "image-gateway", "jkrumm-com": "jkrumm.com",
}
WARDEN_REPO_ALIAS = gd.WARDEN_REPO_ALIAS
RH_RX = re.compile(r"^:(white_check_mark|x): (Deployed|Deployment failed:) ([A-Za-z0-9._-]+) Image: <[^|>]*\|[^>]*?:([0-9a-f]{7,40})>")
RH_ANY_RX = re.compile(r"^:(white_check_mark|x): (Deployed|Deployment failed:) ([A-Za-z0-9._-]+) Image:")
POLL_LINE_RX = re.compile(r"^(?:\S+Z )?\[(\d{4}-\d\d-\d\dT[\d:]+[+-]\d{4})\] (.*)$")


def iso(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def epoch(s: str) -> float:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def iso_week(ts: float) -> str:
    y, w, _ = dt.datetime.fromtimestamp(ts, UTC).isocalendar()
    return f"{y}-W{w:02d}"


def ratio(n: float, d: float) -> float | None:
    return round(n / d, 4) if d else None


def stats(vals_s: list[float]) -> dict:
    """Seconds in, hours out."""
    if not vals_s:
        return {"n": 0, "median_h": None, "p90_h": None, "mean_h": None, "p25_h": None, "p75_h": None, "max_h": None}
    v = sorted(vals_s)

    def q(p: float) -> float:
        k = (len(v) - 1) * p
        lo, hi = int(k), min(int(k) + 1, len(v) - 1)
        return v[lo] + (v[hi] - v[lo]) * (k - lo)

    h = lambda x: round(x / 3600, 2)
    return {"n": len(v), "median_h": h(q(.5)), "p90_h": h(q(.9)), "mean_h": h(statistics.fmean(v)),
            "p25_h": h(q(.25)), "p75_h": h(q(.75)), "max_h": h(v[-1])}


# ── repos ────────────────────────────────────────────────────────────────────────────────

def source_repos() -> dict[str, dict]:
    out = {}
    for root, name, path in gd.discover()[0]:
        if root != "SourceRoot":
            continue
        _, url = gd.git(path, "remote", "get-url", "origin")
        m = re.search(r"github\.com[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?\s*$", url.strip())
        ref, how, _ = gd.resolve_ref(path)
        out[name] = {"path": path, "ref": ref, "gh": f"{m.group(1)}/{m.group(2)}" if m else None,
                     "default_branch": ref.split("/", 1)[1] if ref and ref.startswith("origin/") else ref}
    return out


def repo_for_service(svc: str, repos: dict) -> str | None:
    if svc in SERVICE_REPO:
        return SERVICE_REPO[svc]
    cands = [r for r in repos if svc == r or svc.startswith(r + "-")]
    return max(cands, key=len) if cands else None


def load_graph(path: Path, ref: str) -> dict[str, dict]:
    code, out = gd.git(path, "log", ref, "--format=%H%x1f%P%x1f%at%x1f%ct%x1f%s")
    g = {}
    for line in out.split("\n"):
        f = line.split("\x1f")
        if len(f) < 5:
            continue
        g[f[0]] = {"parents": f[1].split(), "at": int(f[2]), "ct": int(f[3]), "type": gd.commit_type(f[4]), "merge": len(f[1].split()) > 1}
    return g


def resolve_sha(sha: str | None, graph: dict, prefix_index: dict[str, list[str]]) -> str | None:
    if not sha:
        return None
    if len(sha) == 40:
        return sha if sha in graph else None
    hits = prefix_index.get(sha[:7], [])
    hits = [h for h in hits if h.startswith(sha)]
    return hits[0] if len(hits) == 1 else None


# ── collectors ───────────────────────────────────────────────────────────────────────────

def collect_rollhook(con: sqlite3.Connection, repos: dict) -> tuple[list[dict], dict]:
    recs, info = [], Counter()
    lo = iso(DEPLOY_LOOKBACK)[:19]
    for ext_id, title, payload, first_seen in con.execute(
            "SELECT external_id, title, payload_json, first_seen FROM events WHERE source='slack_update' AND first_seen >= ? ORDER BY id", (lo,)):
        try:
            p = json.loads(payload or "{}")
        except json.JSONDecodeError:
            continue
        text = p.get("first_text") or title or ""
        if not RH_ANY_RX.match(text):
            info["slack_update_not_a_deploy_notice"] += 1
            continue
        m = RH_RX.match(text)
        mm = RH_ANY_RX.match(text)
        ok = mm.group(2) == "Deployed"
        svc = mm.group(3)
        sha = m.group(4) if m else None
        repo = repo_for_service(svc, repos)
        t1, tl = float(p.get("ts_first", 0) or 0), float(p.get("ts_last", 0) or 0)
        n = int(p.get("batch_count", 1) or 1)
        if not t1 or not repo:
            info["unmapped_service" if not repo else "no_slack_ts"] += 1
            if not repo:
                info[f"unmapped:{svc}"] += 1
            continue
        kind = "ok"
        if not ok:
            low = text.lower()
            kind = ("docker_pull" if "docker pull" in low else "compose" if "compose" in low else
                    "rolling_deploy" if "rolling" in low else "other")
        stamps = [t1] + ([tl] if n >= 2 and tl and tl != t1 else [])
        info["notices_with_unplaced_repeats"] += max(0, n - len(stamps))
        for t in stamps:
            if t < AS_OF_TS:
                recs.append({"source": "rollhook", "repo": repo, "service": svc, "sha": sha, "ts": t, "ok": ok,
                             "stream": ("rollhook", repo, svc), "failure_kind": None if ok else kind})
    return recs, dict(info)


def collect_warden_ops(con: sqlite3.Connection) -> list[dict]:
    recs = []
    for repo, started, outcome, outcome_at, receipt, note in con.execute(
            "SELECT repo, started_at, outcome, outcome_at, receipt_json, note FROM operations WHERE kind='deploy' ORDER BY started_at"):
        repo = WARDEN_REPO_ALIAS.get(repo, repo)
        ts = epoch(outcome_at or started)
        if ts >= AS_OF_TS or outcome not in ("done", "failed"):
            continue
        sha = None
        m = re.match(r"^sha:([0-9a-f]{40})$", note or "")
        if m:
            sha = m.group(1)
        else:  # early weatherorb git-pull deploys: the receipt shows `Updating a..b` or `a..b master -> origin/master`
            try:
                out = json.loads(receipt or "{}").get("output") or ""
            except json.JSONDecodeError:
                out = ""
            m2 = re.search(r"Updating [0-9a-f]+\.\.([0-9a-f]{7,40})", out) or re.search(r"[0-9a-f]+\.\.([0-9a-f]{7,40})\s+\S+\s+->\s+origin/", out)
            sha = m2.group(1) if m2 else None
        recs.append({"source": "warden_op", "repo": repo, "service": "warden deploy", "sha": sha, "ts": ts, "ok": outcome == "done",
                     "stream": ("warden_op", repo, "warden deploy"), "failure_kind": None if outcome == "done" else "exit"})
    return recs


def collect_poller() -> tuple[list[dict], dict]:
    if not POLLER_LOG.exists():
        return [], {"available": False}
    recs, pending, ci_blocked = [], None, 0
    for line in POLLER_LOG.read_text(encoding="utf-8", errors="replace").splitlines():
        m = POLL_LINE_RX.match(line)
        if not m:
            continue
        ts = dt.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S%z").timestamp()
        msg = m.group(2)
        d = re.match(r"deploying \S+ -> ([0-9a-f]{7,40})\b", msg)
        ok = re.match(r"deploy OK — ([0-9a-f]{7,40})\b", msg) or re.match(r"deployed ([0-9a-f]{7,40}) —", msg)
        if d:
            if pending:
                recs.append({**pending, "ok": False, "failure_kind": "no_success_line"})
            pending = {"source": "poller", "repo": "research-gateway", "service": "mini deploy poller", "sha": d.group(1), "ts": ts,
                       "stream": ("poller", "research-gateway", "mini deploy poller")}
        elif ok:
            sha = ok.group(1)
            recs.append({"source": "poller", "repo": "research-gateway", "service": "mini deploy poller", "sha": sha, "ts": ts, "ok": True,
                         "stream": ("poller", "research-gateway", "mini deploy poller"), "failure_kind": None})
            pending = None
        elif msg.startswith("ERROR: CI failed on"):
            ci_blocked += 1
    if pending:
        recs.append({**pending, "ok": False, "failure_kind": "no_success_line"})
    recs = [r for r in recs if r["ts"] < AS_OF_TS]
    return recs, {"available": True, "ci_gate_blocks": ci_blocked}


def gh_json(*args: str, timeout: int = 300) -> tuple[int, str]:
    try:
        r = subprocess.run(["gh", *args], capture_output=True, text=True, errors="replace", timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 124, str(e)
    return r.returncode, r.stdout


def collect_actions(repos: dict) -> tuple[list[dict], dict]:
    if os.environ.get("DORA_GH", "1") == "0":
        return [], {"available": False, "reason": "DORA_GH=0"}
    code, _ = gh_json("auth", "status", timeout=30)
    if code != 0:
        return [], {"available": False, "reason": "gh is not authenticated non-interactively"}
    recs, per_repo, errors = [], {}, []
    created = f"{dt.datetime.fromtimestamp(DEPLOY_LOOKBACK, UTC):%Y-%m-%d}..{dt.datetime.fromtimestamp(AS_OF_TS, UTC):%Y-%m-%d}"
    for name, r in sorted(repos.items()):
        if not r["gh"]:
            continue
        code, out = gh_json("api", "--paginate", f"repos/{r['gh']}/actions/workflows", "--jq", '.workflows[] | [.id, .name, .path] | @tsv')
        if code != 0:
            errors.append(f"{name}: workflows listing failed")
            continue
        wfs = [l.split("\t") for l in out.splitlines() if l.strip()]
        deploy_wfs = [w for w in wfs if re.search(r"deploy", w[2], re.I)]
        if not deploy_wfs:
            continue
        counts = Counter()
        for wid, wname, wpath in deploy_wfs:
            code, out = gh_json("api", "--paginate", "-X", "GET", f"repos/{r['gh']}/actions/workflows/{wid}/runs", "-f", "per_page=100",
                                "-f", f"created={created}", "--jq",
                                '.workflow_runs[] | [.head_branch,.head_sha,.event,.status,.conclusion,.created_at,.updated_at] | @tsv')
            if code != 0:
                errors.append(f"{name}/{wname}: runs listing failed")
                continue
            for line in out.splitlines():
                f = line.split("\t")
                if len(f) < 7:
                    continue
                branch, sha, event, status, concl, created_at, updated_at = f[:7]
                counts[concl or status] += 1
                if branch != r["default_branch"] or status != "completed" or concl not in ("success", "failure"):
                    continue
                ts = epoch(updated_at)
                if ts >= AS_OF_TS:
                    continue
                recs.append({"source": "actions", "repo": name, "service": redact(wname), "sha": sha, "ts": ts, "ok": concl == "success",
                             "stream": ("actions", name, wname), "failure_kind": None if concl == "success" else "workflow_failure",
                             "pushed_at": epoch(created_at)})
        per_repo[name] = {"workflows": [redact(w[1]) for w in deploy_wfs], "run_conclusions_since_lookback": dict(sorted(counts.items()))}
    return recs, {"available": True, "repos_with_deploy_workflows": len(per_repo), "per_repo": per_repo, "errors": errors,
                  "note": "skipped and cancelled runs are not deployments; only default-branch runs count"}


# ── assembly ─────────────────────────────────────────────────────────────────────────────

def assemble(records: list[dict], repos: dict, graphs: dict, prefixes: dict) -> tuple[list[dict], list[dict], dict]:
    """Resolve shas, split into success deployments (repo, sha) and failures, count redeploys."""
    unresolved = Counter()
    for r in records:
        g = graphs.get(r["repo"])
        full = resolve_sha(r["sha"], g, prefixes[r["repo"]]) if g is not None else None
        r["full_sha"] = full
        if r["sha"] and not full:
            unresolved[r["source"]] += 1
    ok = sorted([r for r in records if r["ok"]], key=lambda r: r["ts"])
    by: dict[tuple, dict] = {}
    seen_stream: Counter = Counter()
    redeploys = Counter()
    no_sha = Counter()
    service_records = 0
    for r in ok:
        service_records += 1
        if not r["full_sha"]:
            no_sha[r["source"]] += 1
            continue
        k = (r["repo"], r["full_sha"])
        sk = (r["stream"], r["full_sha"])
        if seen_stream[sk]:
            redeploys[r["repo"]] += 1
        seen_stream[sk] += 1
        e = by.setdefault(k, {"repo": r["repo"], "sha": r["full_sha"], "ts": r["ts"], "services": set(), "sources": set(), "pushed_at": None})
        e["ts"] = min(e["ts"], r["ts"])
        e["services"].add(r["service"])
        e["sources"].add(r["source"])
        if r.get("pushed_at"):
            e["pushed_at"] = min(e["pushed_at"] or r["pushed_at"], r["pushed_at"])
    deployments = sorted(by.values(), key=lambda e: (e["ts"], e["repo"]))
    fails: dict[tuple, dict] = {}
    for r in sorted([r for r in records if not r["ok"]], key=lambda r: r["ts"]):
        k = (r["repo"], r["full_sha"] or f"unresolved:{r['source']}:{int(r['ts'] // 600)}")
        if k not in fails:
            fails[k] = r
        elif r["source"] == "rollhook" and fails[k]["source"] != "rollhook":
            fails[k] = {**r, "ts": min(r["ts"], fails[k]["ts"])}
    failures = sorted(fails.values(), key=lambda r: r["ts"])
    meta = {"service_level_success_records": service_records, "success_records_without_resolvable_sha": dict(no_sha),
            "unresolved_shas_by_source": dict(unresolved), "redeploys_same_commit_same_stream_150d_lookback": dict(redeploys)}
    return deployments, failures, meta


def lead_times(deployments: list[dict], graphs: dict) -> tuple[dict, dict, list[dict]]:
    """Per-deployment changesets via DFS over parents; returns commit-level samples and per-deploy rows."""
    per_repo_samples: dict[str, list[tuple[float, float, bool]]] = defaultdict(list)
    by_repo: dict[str, list[dict]] = defaultdict(list)
    for d in deployments:
        by_repo[d["repo"]].append(d)
    skipped = Counter()
    for repo, ds in by_repo.items():
        g = graphs[repo]
        seen: set[str] = set()
        first = True
        for d in sorted(ds, key=lambda x: x["ts"]):
            new, stack = [], [d["sha"]]
            while stack:
                c = stack.pop()
                if c in seen or c not in g:
                    continue
                seen.add(c)
                new.append(c)
                stack.extend(g[c]["parents"])
            if first:
                first = False
                d["changeset"] = None
                skipped["first_deployment_of_repo"] += 1
                continue
            plain = [c for c in new if not g[c]["merge"]]
            d["changeset"] = plain
            if not plain:
                skipped["empty_changeset"] += 1
                continue
            at = [d["ts"] - g[c]["at"] for c in plain]
            ct = [d["ts"] - g[c]["ct"] for c in plain]
            d["lead_oldest_author_s"] = max(at)
            d["lead_median_author_s"] = statistics.median(at)
            d["complete"] = bool(d["sources"] & COMPLETE_SOURCES)
            if d["ts"] >= W90:
                for c, a_, c_ in zip(plain, at, ct):
                    per_repo_samples[repo].append((a_, c_, d["complete"]))
    return per_repo_samples, dict(skipped), deployments


def main() -> int:
    repos = source_repos()
    db = SNAP / "warden.db"
    if not db.exists():
        print(f"dora: missing snapshot {db}", file=sys.stderr)
        return 1
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)

    graphs, prefixes = {}, {}
    for name, r in repos.items():
        if not r["ref"]:
            continue
        graphs[name] = load_graph(r["path"], r["ref"])
        idx = defaultdict(list)
        for sha in graphs[name]:
            idx[sha[:7]].append(sha)
        prefixes[name] = idx

    rh, rh_info = collect_rollhook(con, repos)
    ops = collect_warden_ops(con)
    poll, poll_info = collect_poller()
    act, act_info = collect_actions(repos)
    all_recs = [r for r in rh + ops + poll + act if r["repo"] in graphs]
    deployments, failures, meta = assemble(all_recs, repos, graphs, prefixes)
    samples, lt_skipped, deployments = lead_times(deployments, graphs)

    in_win = lambda ts, days: AS_OF_TS - days * 86400 <= ts < AS_OF_TS
    dep90 = [d for d in deployments if in_win(d["ts"], 90)]
    fail90 = [f for f in failures if in_win(f["ts"], 90)]

    # ── deployment frequency ──
    df = {}
    for w, days in WINDOWS.items():
        ds = [d for d in deployments if in_win(d["ts"], days)]
        per_repo = Counter(d["repo"] for d in ds)
        lo_d = dt.datetime.fromtimestamp(AS_OF_TS - days * 86400, UTC).date()
        hi_d = dt.datetime.fromtimestamp(AS_OF_TS - 1, UTC).date()
        df[w] = {
            "deployments": len(ds), "per_week": round(len(ds) / (days / 7), 1), "repos_with_deployments": len(per_repo),
            "days_with_a_deployment": len({dt.datetime.fromtimestamp(d["ts"], UTC).date() for d in ds}),
            "calendar_days_in_window": (hi_d - lo_d).days + 1, "window_days": days,
            "per_repo": {r: {"deployments": n, "per_week": round(n / (days / 7), 2)} for r, n in sorted(per_repo.items(), key=lambda kv: (-kv[1], kv[0]))},
        }
    weekly = defaultdict(Counter)
    for d in dep90:
        weekly[iso_week(d["ts"])][d["repo"]] += 1
    df["weekly_90d"] = {w: {"deployments": sum(c.values()), "repos": len(c)} for w, c in sorted(weekly.items())}
    df["service_level_success_records_90d"] = sum(1 for r in all_recs if r["ok"] and in_win(r["ts"], 90))

    # ── lead time ──
    def pooled(idx: int, only_complete: bool) -> list[float]:
        return [x[idx] for ss in samples.values() for x in ss if x[idx] >= 0 and (x[2] or not only_complete)]

    neg = sum(1 for ss in samples.values() for x in ss if x[0] < 0)
    lt_repo = {}
    for repo, ss in sorted(samples.items()):
        ds = [d for d in dep90 if d["repo"] == repo and d.get("lead_oldest_author_s") is not None and d["lead_oldest_author_s"] >= 0]
        lt_repo[repo] = {"commits": len(ss), "deployments_measured": len(ds), "source_class": "complete" if any(x[2] for x in ss) else "partial",
                         "author_time": stats([x[0] for x in ss if x[0] >= 0]), "commit_time": stats([x[1] for x in ss if x[1] >= 0]),
                         "first_commit_per_deployment": stats([d["lead_oldest_author_s"] for d in ds])}
    meas = [d for d in dep90 if d.get("lead_oldest_author_s") is not None and d["lead_oldest_author_s"] >= 0]
    meas_c = [d for d in meas if d["complete"]]
    lead = {
        "headline_scope": "deployments recorded by a complete source (an Actions workflow per push, or the CI-gated poller)",
        "per_commit_author_time": stats(pooled(0, True)), "per_commit_commit_time": stats(pooled(1, True)),
        "per_deployment_first_commit_author_time": stats([d["lead_oldest_author_s"] for d in meas_c]),
        "per_deployment_median_commit_author_time": stats([d["lead_median_author_s"] for d in meas_c]),
        "deployments_measured": len(meas_c), "deployments_measured_all_sources": len(meas), "deployments_90d": len(dep90),
        "sensitivity_all_sources": {"per_commit_author_time": stats(pooled(0, False)),
                                    "per_deployment_first_commit_author_time": stats([d["lead_oldest_author_s"] for d in meas])},
        "skipped": lt_skipped, "samples_with_negative_lead_dropped": neg, "per_repo": lt_repo,
        "definition": "per_commit: deploy time - author time, over every commit first shipped by a deployment in the window; "
                      "per_deployment_first_commit: the oldest commit in each deployment (the 'first commit of a change' reading). "
                      "Partial sources (warden operations, Slack notices) miss deploys, so commits look older than they were: they are excluded from the headline.",
    }

    # ── failed deployments and recovery ──
    streams = defaultdict(list)
    for r in all_recs:
        if r["ok"]:
            streams[r["stream"]].append((r["ts"], r.get("full_sha")))
    for v in streams.values():
        v.sort(key=lambda x: x[0])
    stream_times = {k: [t for t, _ in v] for k, v in streams.items()}
    rec_times, censored, by_src = [], 0, defaultdict(list)
    kinds = Counter()
    for f in fail90:
        kinds[f"{f['source']}:{f.get('failure_kind')}"] += 1
        nxt = stream_times.get(f["stream"], [])
        j = bisect.bisect_right(nxt, f["ts"])
        if j < len(nxt):
            rec_times.append(nxt[j] - f["ts"])
            by_src[f["source"]].append(nxt[j] - f["ts"])
        else:
            censored += 1
    fd = {
        "failed_deployments_90d": len(fail90), "failed_per_source": dict(Counter(f["source"] for f in fail90)),
        "failure_kinds": dict(sorted(kinds.items())), "recovered": len(rec_times), "unrecovered_censored": censored,
        "recovery": stats(rec_times), "recovery_by_source": {s: stats(v) for s, v in sorted(by_src.items())},
        "recovered_within_1h": sum(1 for x in rec_times if x <= 3600), "recovered_within_24h": sum(1 for x in rec_times if x <= 86400),
        "definition": "failed deployment -> next successful deployment in the same stream (service / workflow); a failure with no later success is censored. "
                      "A failed pipeline leaves production on the previous version, so this is the time until the pipeline is green again, not user-facing downtime",
    }

    # ── change failure rate ──
    rows = con.execute(
        "SELECT e.title, t.origin, COALESCE(t.first_seen, t.created_at), COALESCE(NULLIF(t.repo,''),'') "
        "FROM triage_items t JOIN events e ON e.id = t.event_id WHERE t.duplicate_of IS NULL AND COALESCE(t.close_reason,'') != 'duplicate'").fetchall()
    item_first = None
    items_alert, items_any, no_repo = defaultdict(list), defaultdict(list), 0
    for title, origin, seen, repo in rows:
        t = epoch(seen)
        if t >= AS_OF_TS:
            continue
        item_first = t if item_first is None else min(item_first, t)
        repo = WARDEN_REPO_ALIAS.get(repo, repo)
        if not repo:
            no_repo += 1
            continue
        items_any[repo].append(t)
        if origin == "alert" or (origin == "github_issue" and (title or "").startswith("[alert]")):
            items_alert[repo].append(t)
    for d in (items_alert, items_any):
        for v in d.values():
            v.sort()
    reverts = {r: sorted(c["ct"] for c in g.values() if c["type"] == "revert" and not c["merge"]) for r, g in graphs.items()}
    watched = {r for r, v in items_alert.items() if any(t >= AS_OF_TS - 180 * 86400 for t in v)}
    start = max(W90, item_first or W90)
    cfr_deploys = [d for d in deployments if start <= d["ts"] <= AS_OF_TS - HORIZON]

    def follows(times: list[float], t: float) -> bool:
        i = bisect.bisect_right(times, t)
        return i < len(times) and times[i] <= t + HORIZON

    def cfr_variant(item_map, with_reverts=True, restrict=None):
        flagged = 0
        pool = [d for d in cfr_deploys if restrict is None or d["repo"] in restrict]
        for d in pool:
            hit = follows(item_map.get(d["repo"], []), d["ts"]) or (with_reverts and follows(reverts.get(d["repo"], []), d["ts"]))
            flagged += bool(hit)
        return {"deployments": len(pool), "flagged": flagged, "rate": ratio(flagged, len(pool))}

    # attribution variant: each item / revert is charged to the latest preceding deployment of its repo (within 24 h)
    by_repo_dep = defaultdict(list)
    for d in deployments:
        by_repo_dep[d["repo"]].append(d)
    charged = set()
    for repo, times in list(items_alert.items()) + list(reverts.items()):
        ds = by_repo_dep.get(repo, [])
        tl = [d["ts"] for d in ds]
        for t in times:
            i = bisect.bisect_left(tl, t) - 1
            if i >= 0 and t - tl[i] <= HORIZON:
                charged.add((repo, ds[i]["sha"]))
    cfr_attr_flagged = sum(1 for d in cfr_deploys if (d["repo"], d["sha"]) in charged)
    cfr = {
        "window_start": iso(start), "window_end": iso(AS_OF_TS - HORIZON),
        "headline_alert_items_or_revert_within_24h": cfr_variant(items_alert),
        "watched_repos_only": {**cfr_variant(items_alert, restrict=watched), "watched_repos": sorted(watched)},
        "sensitivity_any_origin_item_or_revert": cfr_variant(items_any),
        "sensitivity_reverts_only": cfr_variant({}, with_reverts=True),
        "sensitivity_alert_items_only": cfr_variant(items_alert, with_reverts=False),
        "sensitivity_item_charged_to_latest_deploy_only": {"deployments": len(cfr_deploys), "flagged": cfr_attr_flagged, "rate": ratio(cfr_attr_flagged, len(cfr_deploys))},
        "items_without_repo_dropped": no_repo, "first_triage_item": iso(item_first) if item_first else None,
        "definition": "deployment flagged when a failure-signal warden item (origin alert, or [alert] GitHub issue) or a Revert commit on the same repo "
                      "appears within 24 h after it; alert items are mostly infrastructure signals, so this is an upper bound on deploy-caused failures",
        "reading": "The literal rule flags EVERY deploy of the repo in the 24 h before an item or revert, so at the observed rate (median_deployments_per_day_in_window, "
                   "pooled over repos) one signal flags a whole day of deploys. sensitivity_item_charged_to_latest_deploy_only charges each item/revert to the deploy before it "
                   "and is the better estimate of deploy-caused failures; the definition in DEFINITIONS.md should say which one is meant.",
        "median_deployments_per_day_in_window": statistics.median(Counter(dt.datetime.fromtimestamp(d["ts"], UTC).date() for d in cfr_deploys).values()) if cfr_deploys else None,
    }

    # ── deployment rework rate ──
    ledger_alert = set()
    for r, receipt in con.execute("SELECT o.repo, o.receipt_json FROM operations o JOIN triage_items t ON t.event_id = o.event_id "
                                  "JOIN events e ON e.id = t.event_id WHERE o.kind='merge' AND o.outcome='done' "
                                  "AND (t.origin='alert' OR (t.origin='github_issue' AND e.title LIKE '[alert]%'))"):
        try:
            sha = json.loads(receipt or "{}").get("mergeCommit")
        except json.JSONDecodeError:
            sha = None
        if sha:
            ledger_alert.add(sha)
    for (sha,) in con.execute("SELECT t.merged_sha FROM triage_items t JOIN events e ON e.id = t.event_id WHERE t.merged_sha IS NOT NULL "
                              "AND (t.origin='alert' OR (t.origin='github_issue' AND e.title LIKE '[alert]%'))"):
        ledger_alert.add(sha)
    hist_flags = {}
    for repo in {d["repo"] for d in dep90}:
        hist = gd.read_history(repos[repo]["path"], repos[repo]["ref"])
        gd.annotate(hist)
        hist_flags[repo] = {c["sha"]: c["rework"] for c in hist if c["parents"] <= 1}
    after_fail = set()  # (repo, sha) of the first success within 24 h after a failure in the same stream
    for f in failures:
        nxt = stream_times.get(f["stream"], [])
        j = bisect.bisect_right(nxt, f["ts"])
        if j < len(nxt) and nxt[j] - f["ts"] <= HORIZON and streams[f["stream"]][j][1]:
            after_fail.add((f["repo"], streams[f["stream"]][j][1]))
    confirmed = fix_only = any_rework = measured = 0
    for d in dep90:
        cs = d.get("changeset")
        if not cs:
            continue
        measured += 1
        g = graphs[d["repo"]]
        c_alert = any(c in ledger_alert for c in cs)
        c_after = (d["repo"], d["sha"]) in after_fail
        fx = all(g[c]["type"] in ("fix", "revert") for c in cs)
        rw = any(hist_flags.get(d["repo"], {}).get(c) for c in cs)
        confirmed += bool(c_alert or c_after)
        fix_only += bool(c_alert or c_after or fx)
        any_rework += bool(c_alert or c_after or fx or rw)
    rework = {
        "deployments_measured": measured,
        "lower_bound_confirmed": {"deployments": confirmed, "rate": ratio(confirmed, measured),
                                  "reading": "ships a warden merge that came from an alert item (origin alert or an [alert] issue), or is the first success within 24 h after a failed deployment of its stream"},
        "best_estimate_plus_fix_only": {"deployments": fix_only, "rate": ratio(fix_only, measured),
                                        "reading": "adds deployments whose whole changeset is fix/revert commits"},
        "upper_bound_plus_any_rework_commit": {"deployments": any_rework, "rate": ratio(any_rework, measured),
                                               "reading": "adds deployments containing any fix/revert commit that touched a file changed in the preceding 7 days (rework_share's commit flag)"},
        "alert_item_merge_commits_in_ledger": len(ledger_alert),
        "definition": "deploys that ship an unplanned fix / all deploys; 'unplanned' is not recorded anywhere, so three nested readings bracket it",
    }

    # ── sources and coverage ──
    by_src = Counter()
    repo_src: dict[str, Counter] = defaultdict(Counter)
    for d in dep90:
        for s in d["sources"]:
            by_src[s] += 1
            repo_src[d["repo"]][s] += 1
    commits90 = {}
    for name, r in repos.items():
        if not r["ref"]:
            continue
        c, o = gd.git(r["path"], "rev-list", "--no-merges", "--count", r["ref"], f"--before={AS_OF_STR}", f"--after={gd.iso(W90)}")
        commits90[name] = int(o.strip()) if c == 0 and o.strip().isdigit() else 0
    covered = [r for r in repo_src]
    uncovered = sorted((r for r in commits90 if r not in repo_src and commits90[r] >= 25), key=lambda r: (-commits90[r], r))
    actions_shas = defaultdict(set)
    rh_shas = defaultdict(set)
    for r in all_recs:
        if r["ok"] and r.get("full_sha") and in_win(r["ts"], 90):
            (actions_shas if r["source"] == "actions" else rh_shas if r["source"] == "rollhook" else defaultdict(set))[r["repo"]].add(r["full_sha"])
    relay = {repo: {"actions_deployments": len(actions_shas[repo]), "rollhook_notice_deployments": len(rh_shas[repo]),
                    "rollhook_captured_of_actions": ratio(len(actions_shas[repo] & rh_shas[repo]), len(actions_shas[repo]))}
             for repo in sorted(set(actions_shas) & set(rh_shas))}
    wk_act, wk_rh = Counter(), Counter()
    for r in all_recs:
        if r["ok"] and in_win(r["ts"], 90) and r["repo"] in (set(actions_shas) & set(rh_shas)):
            if r["source"] == "actions":
                wk_act[iso_week(r["ts"])] += 1
            elif r["source"] == "rollhook":
                wk_rh[iso_week(r["ts"])] += 1
    weekly_capture = {w: {"actions_success_runs": wk_act[w], "rollhook_success_notices": wk_rh[w], "notices_per_run": ratio(wk_rh[w], wk_act[w])}
                      for w in sorted(set(wk_act) | set(wk_rh))}
    busy = [(w, v) for w, v in weekly_capture.items() if v["actions_success_runs"] >= 20 and v["notices_per_run"] is not None]
    collapse = next(((w, v["notices_per_run"]) for w, v in busy if v["notices_per_run"] < 0.25), None)
    healthy = [v["notices_per_run"] for w, v in busy if collapse is None or w < collapse[0]]
    notice_collapse = ({"first_week_below_0_25_notices_per_run": collapse[0], "ratio_that_week": collapse[1],
                        "median_ratio_in_earlier_weeks": round(statistics.median(healthy), 2) if healthy else None,
                        "weeks_considered": "weeks with >= 20 Actions success runs in repos that have both sources"} if collapse else None)
    rh_ok = sum(1 for r in rh if r["ok"] and in_win(r["ts"], 90))
    rh_weeks = Counter(iso_week(r["ts"]) for r in rh if r["ok"] and in_win(r["ts"], 90))
    sources = {
        "actions": {**act_info, "deployments_90d": by_src.get("actions", 0), "covers": "repos with a deploy workflow; push + completion time, sha, conclusion",
                    "cannot_see": "deploys not run by a workflow (make deploy on the mini, launchd), RollHook-side failures after a green workflow"},
        "rollhook": {**rh_info, "notice_stream_collapse": notice_collapse, "success_notices_90d": rh_ok, "deployments_90d": by_src.get("rollhook", 0), "weekly_success_notices_90d": dict(sorted(rh_weeks.items())),
                     "covers": "VPS services behind RollHook", "cannot_see": "anything warden's Slack relay dropped or folded; capture ratio vs Actions in relay_capture"},
        "warden_op": {"deployments_90d": by_src.get("warden_op", 0), "ops_total": sum(1 for r in ops), "covers": "deploys run by warden's verify lane since 2026-09-29",
                      "cannot_see": "every deploy the owner or a wave ran by hand"},
        "poller": {**poll_info, "deployments_90d": by_src.get("poller", 0), "covers": "research-gateway on the mini since 2026-09-23 (CI-gated)",
                   "cannot_see": "research-gateway deploys before the poller (RollHook notices cover them until 2026-09-26)"},
        "rejected": {"github_go_events": "GitHub issues/alerts that start warden work, not deployments",
                     "make_deploy_text_mentions": "free text in warden-cli.log (1 hit), agent-gateway.jsonl (2) and sideclaw.jsonl (1): a close note and review prose, not records"},
    }
    cov = {
        "repos_with_deploy_records_90d": sorted(repo_src),
        "repos_without_records_with_25_plus_commits_90d": [{"repo": r, "commits_90d": commits90[r]} for r in uncovered],
        "commit_share_in_repos_with_deploy_records": ratio(sum(commits90[r] for r in covered), sum(commits90.values())),
        "iuroot": "out of scope: deploys run through GitLab CI, which is not queried (counts-only rule)",
        "sources_per_repo_90d": {r: dict(sorted(c.items())) for r, c in sorted(repo_src.items())},
        "service_to_repo_unmapped": {redact(k.split(":", 1)[1]): v for k, v in rh_info.items() if k.startswith("unmapped:")},
    }
    metrics = {
        "deployment_frequency": {"value_90d": {"deployments": df["90d"]["deployments"], "per_week": df["90d"]["per_week"], "repos": df["90d"]["repos_with_deployments"]},
                                 "source": "actions + rollhook + warden_op + poller, de-duplicated by (repo, commit)",
                                 "coverage": f"{len(covered)} repos with records; {pc(cov['commit_share_in_repos_with_deploy_records'])} of 90 d commits live in them",
                                 "confidence": "high for repos with an Actions deploy workflow, medium for relay-only repos, absent for the rest"},
        "lead_time_for_changes": {"value_90d": {"per_commit_median_h": lead["per_commit_author_time"]["median_h"], "per_commit_p90_h": lead["per_commit_author_time"]["p90_h"],
                                                "first_commit_per_deployment_median_h": lead["per_deployment_first_commit_author_time"]["median_h"],
                                                "commits": lead["per_commit_author_time"]["n"], "deployments": lead["deployments_measured"]},
                                  "source": "git author times joined to deployment shas", "coverage": "deployments whose sha resolves in the local default branch",
                                  "confidence": "medium: author time is when a commit was written, not pushed; batches of commits wait for one deploy"},
        "change_failure_rate": {"value": {"literal_definition": cfr["headline_alert_items_or_revert_within_24h"],
                                          "attributed_to_latest_deploy": cfr["sensitivity_item_charged_to_latest_deploy_only"]},
                                "source": "warden triage items + git reverts vs deployments",
                                "coverage": f"deployments from {cfr['window_start']} (first triage item) to {cfr['window_end']}", "confidence": "low: alert items are mostly infrastructure noise, so this is an upper bound"},
        "failed_deployment_recovery_time": {"value": fd["recovery"], "failed": fd["failed_deployments_90d"], "source": "failure records of every source",
                                            "coverage": "failures any source recorded", "confidence": "low-medium: small n, recovery = next success of the same stream"},
        "deployment_rework_rate": {"value": {"lower": rework["lower_bound_confirmed"]["rate"], "best": rework["best_estimate_plus_fix_only"]["rate"], "upper": rework["upper_bound_plus_any_rework_commit"]["rate"]},
                                   "source": "warden ledger + failure/redeploy sequence + commit types", "coverage": "deployments with a measured changeset",
                                   "confidence": "low: 'unplanned' is not recorded; bracketed, not measured"},
    }
    m_ = metrics
    m_["deployment_frequency"]["headline"] = (f"{df['90d']['deployments']} deployments in 90 d ({df['90d']['per_week']}/week) across {df['90d']['repos_with_deployments']} repos; "
                                              f"{df['90d']['days_with_a_deployment']} of {df['90d']['calendar_days_in_window']} calendar days had one")
    L_ = lead["per_commit_author_time"]
    m_["lead_time_for_changes"]["headline"] = (f"median {L_['median_h']} h, p90 {L_['p90_h']} h per commit ({L_['n']} commits, {lead['deployments_measured']} deployments from complete sources); "
                                               f"oldest commit per deployment median {lead['per_deployment_first_commit_author_time']['median_h']} h")
    m_["change_failure_rate"]["headline"] = (f"literal rule {pc(cfr['headline_alert_items_or_revert_within_24h']['rate'])} ({cfr['headline_alert_items_or_revert_within_24h']['flagged']}/{cfr['headline_alert_items_or_revert_within_24h']['deployments']}); "
                                             f"item charged to the latest deploy only {pc(cfr['sensitivity_item_charged_to_latest_deploy_only']['rate'])}")
    m_["failed_deployment_recovery_time"]["headline"] = (f"{fd['failed_deployments_90d']} failed deployments, {fd['recovered']} recovered (median {fd['recovery']['median_h']} h, p90 {fd['recovery']['p90_h']} h), "
                                                         f"{fd['unrecovered_censored']} unrecovered; recovery = pipeline green again, not user-facing downtime")
    m_["deployment_rework_rate"]["headline"] = (f"between {pc(rework['lower_bound_confirmed']['rate'])} (confirmed) and {pc(rework['upper_bound_plus_any_rework_commit']['rate'])} (any rework commit); "
                                                f"best estimate {pc(rework['best_estimate_plus_fix_only']['rate'])}")
    out = {
        "script": "dora.py", "definition_keys": ["dora.deployment_frequency", "dora.lead_time", "dora.change_failure_rate", "dora.failed_deployment_recovery", "dora.deployment_rework_rate"],
        "as_of": AS_OF_STR, "window_days": 90, "window_start": iso(W90),
        "metrics": metrics,
        "deployment_frequency": df, "lead_time_for_changes": lead, "change_failure_rate": cfr,
        "failed_deployment_recovery": fd, "deployment_rework_rate": rework,
        "sources": sources, "coverage": cov, "relay_capture": relay, "relay_capture_weekly": weekly_capture, "assembly": meta,
        "notes": [redact(x) for x in [
            "Deployment frequency counts distinct (repo, commit) successes; service_level_success_records_90d counts every service/workflow record before de-duplication.",
            "The warden Slack relay captures only part of what GitHub Actions ran: compare relay_capture before reading rollhook-only numbers.",
            "Repos deployed by hand or by launchd on the mini (dotfiles, warden, agent-gateway, hermes-agent, usage-tracker, ...) appear only through warden operations since 2026-09-29: their frequency is a floor, not a measurement.",
            "dotfiles has no deployment event by design: a merged commit is live once symlinked, so its lead time is its commit time.",
            "Lead time is computed on the default branch graph as fetched; commits of deployments newer than the last fetch are unresolved and counted in assembly.unresolved_shas_by_source.",
        ]],
    }
    (HERE / "dora.out.json").write_text(json.dumps(out, indent=2, sort_keys=True, ensure_ascii=False, default=sorted) + "\n", encoding="utf-8")
    write_md(out, HERE / "dora.out.md")
    print("dora: " + " | ".join(f"{k}: {v['headline']}" for k, v in metrics.items()))
    return 0


def pc(x: float | None) -> str:
    return "-" if x is None else f"{x * 100:.1f}%"


def write_md(o: dict, path: Path) -> None:
    L = ["# dora — the five metrics, where the data allows", "", f"AS_OF `{o['as_of']}`, window 90 d. Definition keys `dora.*`. Script `dora.py`. SourceRoot repos only (IuRoot deploys run through GitLab CI, not queried).", "",
         "## Summary", "", "|metric|value|source|coverage|confidence|", "|-|-|-|-|-|"]
    for k, v in o["metrics"].items():
        L.append(f"|{k}|{v['headline']}|{v['source']}|{v['coverage']}|{v['confidence']}|")
    df = o["deployment_frequency"]
    L += ["", "## Deployment frequency", "", "|window|deployments|per week|repos|calendar days with a deploy|", "|-|-|-|-|-|"]
    for w in ("90d", "30d", "14d"):
        L.append(f"|{w}|{df[w]['deployments']}|{df[w]['per_week']}|{df[w]['repos_with_deployments']}|{df[w]['days_with_a_deployment']}/{df[w]['calendar_days_in_window']}|")
    L += ["", f"Service-level success records before de-duplication (90 d): {df['service_level_success_records_90d']}.", "",
          "|repo|deployments 90d|per week|sources|source class|lead median h (commit)|lead p90 h|first-commit median h|", "|-|-|-|-|-|-|-|-|"]
    lt = o["lead_time_for_changes"]["per_repo"]
    for r, v in df["90d"]["per_repo"].items():
        srcs = ", ".join(f"{s} {n}" for s, n in o["coverage"]["sources_per_repo_90d"].get(r, {}).items())
        a = lt.get(r, {}).get("author_time", {})
        fc = lt.get(r, {}).get("first_commit_per_deployment", {})
        L.append(f"|{r}|{v['deployments']}|{v['per_week']}|{srcs}|{lt.get(r, {}).get('source_class', '-')}|{a.get('median_h', '-')}|{a.get('p90_h', '-')}|{fc.get('median_h', '-')}|")
    L += ["", "Weekly deployments (90 d): " + ", ".join(f"{w} {v['deployments']}" for w, v in df["weekly_90d"].items()) + ".", ""]
    lead = o["lead_time_for_changes"]
    L += ["## Lead time for changes", "", "|reading|n|median h|p25 h|p75 h|p90 h|mean h|", "|-|-|-|-|-|-|-|"]
    for key, label in (("per_commit_author_time", "per commit, author time"), ("per_commit_commit_time", "per commit, commit time (landed)"),
                       ("per_deployment_first_commit_author_time", "per deployment, oldest commit"), ("per_deployment_median_commit_author_time", "per deployment, its median commit")):
        s = lead[key]
        L.append(f"|{label}|{s['n']}|{s['median_h']}|{s['p25_h']}|{s['p75_h']}|{s['p90_h']}|{s['mean_h']}|")
    sa = lead["sensitivity_all_sources"]
    L += ["", f"Scope: {lead['headline_scope']}. Deployments measured {lead['deployments_measured']} (all sources {lead['deployments_measured_all_sources']}) of {lead['deployments_90d']}; "
          f"skipped {lead['skipped']}; negative-lead samples dropped {lead['samples_with_negative_lead_dropped']}. "
          f"Sensitivity, all sources: per commit median {sa['per_commit_author_time']['median_h']} h, p90 {sa['per_commit_author_time']['p90_h']} h. {lead['definition']}.", ""]
    c = o["change_failure_rate"]
    L += ["## Change failure rate", "", f"Window {c['window_start']} to {c['window_end']}. {c['definition']}.", "", "|variant|deployments|flagged|rate|", "|-|-|-|-|"]
    for key in ("headline_alert_items_or_revert_within_24h", "watched_repos_only", "sensitivity_any_origin_item_or_revert", "sensitivity_alert_items_only", "sensitivity_reverts_only", "sensitivity_item_charged_to_latest_deploy_only"):
        v = c[key]
        L.append(f"|{key}|{v['deployments']}|{v['flagged']}|{pc(v['rate'])}|")
    f = o["failed_deployment_recovery"]
    L += [f"", f"{c['reading']} Median deployments per day in the window: {c['median_deployments_per_day_in_window']}.", "", "## Failed deployments and recovery", "", f"Failed deployments in 90 d: {f['failed_deployments_90d']} {f['failed_per_source']}; recovered {f['recovered']}, unrecovered (censored) {f['unrecovered_censored']}. "
          f"Median {f['recovery']['median_h']} h, p90 {f['recovery']['p90_h']} h; within 1 h {f['recovered_within_1h']}, within 24 h {f['recovered_within_24h']}. Failure kinds: {f['failure_kinds']}.", ""]
    r = o["deployment_rework_rate"]
    L += ["## Deployment rework rate", "", "|reading|deployments|rate|", "|-|-|-|"]
    for key in ("lower_bound_confirmed", "best_estimate_plus_fix_only", "upper_bound_plus_any_rework_commit"):
        L.append(f"|{key}: {r[key]['reading']}|{r[key]['deployments']} of {r['deployments_measured']}|{pc(r[key]['rate'])}|")
    L += ["", f"{r['definition']}.", ""]
    s = o["sources"]
    L += ["## Sources and coverage", "", "|source|deployments 90d|covers|cannot see|", "|-|-|-|-|"]
    for k in ("actions", "rollhook", "warden_op", "poller"):
        L.append(f"|{k}|{s[k].get('deployments_90d')}|{s[k]['covers']}|{s[k]['cannot_see']}|")
    cov = o["coverage"]
    L += ["", f"Repos with deploy records: {', '.join(cov['repos_with_deploy_records_90d'])}. Commit share in those repos: {pc(cov['commit_share_in_repos_with_deploy_records'])}.", "",
          "Repos with 25+ commits in 90 d and no deploy record: " + ", ".join(f"{x['repo']} ({x['commits_90d']})" for x in cov["repos_without_records_with_25_plus_commits_90d"]) + ".", ""]
    if o["relay_capture"]:
        L += ["Relay capture (Actions deployments also seen as RollHook notices in warden's Slack ingest):", "", "|repo|Actions|notices|captured|", "|-|-|-|-|"]
        for k, v in o["relay_capture"].items():
            L.append(f"|{k}|{v['actions_deployments']}|{v['rollhook_notice_deployments']}|{pc(v['rollhook_captured_of_actions'])}|")
        L += ["", "Per week (repos with both): " + ", ".join(f"{w} {v['rollhook_success_notices']}/{v['actions_success_runs']}" for w, v in o["relay_capture_weekly"].items()) + " (notices/runs).", ""]
    L += ["## Notes", ""] + [f"- {n}" for n in o["notes"]] + [""]
    path.write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
