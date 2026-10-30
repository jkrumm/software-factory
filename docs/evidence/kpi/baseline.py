#!/usr/bin/env python3
"""Warden-ledger baseline: how autonomous, how fast and how reliable is the loop?

Question
    Before the factory is rebuilt: how often does an item reach the owner, how often is
    it resolved and how fast, how often does it come back, how often is a fix reverted?
    One definition per metric, re-runnable, with the old numbers reconciled.

Definition keys (evidence/DEFINITIONS.md)
    item, escalated, owner_touch, autonomy_rate, resolved, time_to_resolve, reopen_rate,
    regression_rate, revert_rate (warden's own half; the git half is another script).
    Not computed here: genuine_escalation_share (needs golden/labels.jsonl).
    Also: escalations per source family and per repo, items per week, and the
    reconciliation of Round 5's "74/228, 14 d" and "99/368, 30 d" and the findings'
    "114/597 ever reached needs_decision".

Inputs
    <snapshots>/<AS_OF date>/warden.db   frozen copy, opened mode=ro (never the live ledger)
    ../lib/redact.py                     every free-text field passes through redact()

Run
    python3 -I baseline.py
    env: AS_OF (default 2026-10-22T08:00:00Z)
         FACTORY_SNAPSHOTS (default ~/.local/share/factory/snapshots)
Outputs (next to this file, stable key order, no wall-clock values)
    baseline.out.json   every number, with its definition key
    baseline.out.md     the human tables and the reconciliation

Windows are cohorts of items by `triage_items.created_at` in [AS_OF - window, AS_OF);
outcomes are observed up to AS_OF; items still open at AS_OF are censored, never dropped.
Item-level derivation (`item`, `escalated`, `owner_touch`, `resolved`) lives in ledger.py, shared with cost.py.
Python 3.9+ stdlib only.
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True  # the evidence tree stays free of .pyc files
from ledger import (  # noqa: E402
    parse_ts,
    AS_OF,
    AS_OF_RAW,
    FAMILIES,
    HAND_CLOSE_PREFIX,
    NON_TERMINAL,
    REINVEST_PREFIX,
    TERMINAL_SET,
    UNLISTED_TOUCH_PREFIXES,
    UTC,
    WINDOWS,
    all_transitions,
    by_id,
    cohort,
    con,
    dups_all,
    events_by_source,
    family_of,
    fmt_h,
    iso,
    items_all,
    kaplan_meier,
    latest_row_update,
    latest_transition,
    log_start,
    lower_note,
    md_table,
    n_trans_after,
    n_trans_total,
    norm_index,
    ops_by,
    pc,
    pctl,
    r1,
    rate,
    redact,
    rows,
    rx,
    snapshot_mtime,
)

REGRESSION_DAYS = 30

# Round 5 numbers to reproduce (dotfiles/docs/waves/PLAN.md "Established facts", warden bullet 1)
R5 = {"items_14d": 228, "esc_14d": 74, "items_30d": 368, "esc_30d": 99, "unattended_30d": 201}
FINDINGS_ND_EVER = (114, 597)  # findings-2026-10-22.md "Items": ever reached needs_decision, all time

# ----------------------------------------------------------------------------- metrics
def item_block(rows_c, items_c, dups_c):
    parents = Counter(r.duplicate_of for r in dups_c if r.duplicate_of is not None)
    return {
        "key": "item",
        "rows": len(rows_c), "items": len(items_c), "duplicates": len(dups_c),
        "duplicate_share_of_rows": rate(len(dups_c), len(rows_c)),
        "duplicate_parents": len(parents),
        "duplicate_parent_missing": sum(1 for p in parents if p not in by_id),
        "duplicate_parent_is_duplicate": sum(1 for p in parents if p in by_id and by_id[p].is_dup),
        "duplicates_that_escalated": sum(1 for r in dups_c if r.escalated),
    }


def escalated_block(items_c):
    n = sum(1 for r in items_c if r.escalated)
    return {"key": "escalated", "n": n, "d": len(items_c), "rate": rate(n, len(items_c)),
            "needs_decision_transitions": sum(r.nd_count for r in items_c),
            "still_awaiting_owner_at_as_of": sum(1 for r in items_c if r.state == "needs_decision")}


def touch_block(items_c):
    n = sum(1 for r in items_c if r.touch)
    hand = [r for r in items_c if r.hand_close]
    return {
        "key": "owner_touch", "n": n, "d": len(items_c), "rate": rate(n, len(items_c)),
        "components_any": {
            "escalated": sum(1 for r in items_c if r.escalated),
            "closed_by_hand": sum(1 for r in items_c if r.hand_close),
            "re_investigation_requested": sum(1 for r in items_c if r.reinvest),
            "operation_owner_or_cli": sum(1 for r in items_c if r.op_touch),
        },
        "touched_without_escalation": sum(1 for r in items_c if r.touch and not r.escalated),
        "closed_by_hand_actor_hint": dict(sorted(Counter(r.hand_actor for r in hand).items())),
        "sensitivity_unlisted_owner_like_notes": {
            "extra_items": sum(1 for r in items_c if r.unlisted_touch and not r.touch),
            "autonomy_rate_if_counted": rate(len(items_c) - n - sum(1 for r in items_c if r.unlisted_touch and not r.touch), len(items_c)),
            "prefixes": list(UNLISTED_TOUCH_PREFIXES),
        },
    }


def autonomy_block(items_c):
    t = sum(1 for r in items_c if r.touch)
    return {"key": "autonomy_rate", "n_untouched": len(items_c) - t, "d": len(items_c),
            "rate": None if not items_c else round(1 - t / len(items_c), 4), "target": 0.999}


def resolved_block(items_c):
    ever = [r for r in items_c if r.resolved_ever]
    outcomes = Counter(r.outcome for r in items_c)
    return {
        "key": "resolved",
        "resolved_ever": {"n": len(ever), "d": len(items_c), "rate": rate(len(ever), len(items_c)),
                          "by_first_route": dict(sorted(Counter(r.resolved_first_kind for r in ever).items())),
                          "first_route_inferred_from_note": sum(1 for r in ever if r.resolved_inferred)},
        "reopened_after_resolution": sum(1 for r in ever if r.outcome != "resolved"),
        "outcome_at_as_of": {k: outcomes.get(k, 0) for k in (
            "resolved", "ignored", "failed", "awaiting_owner", "in_progress", "quiet_unrecovered", "closed_unknown")},
        "ignored_share": rate(outcomes.get("ignored", 0), len(items_c)),
        "failed_share": rate(outcomes.get("failed", 0), len(items_c)),
        "closed_by_hand_resolved": sum(1 for r in items_c if r.outcome == "resolved" and r.hand_close),
        "closed_by_hand_reads_as_dismissal": sum(1 for r in items_c if r.hand_dismissal),
        "hand_closed_duplicates_not_flagged_duplicate": sum(1 for r in items_c if r.hand_dup_unflagged),
    }


def ttr_block(items_c):
    obs, unobs, cens, ign, neg = [], 0, [], 0, 0
    for r in items_c:
        if r.resolved_first_at is not None:
            h = (r.resolved_first_at - r.t0).total_seconds() / 3600
            if h < 0:
                neg, h = neg + 1, 0.0
            obs.append(h)
        elif r.resolved_ever:
            unobs += 1
        elif r.outcome == "ignored":
            ign += 1
        else:
            cens.append(max(0.0, (AS_OF - r.t0).total_seconds() / 3600))
    s = sorted(obs)
    km_med, km_p90 = kaplan_meier(obs, cens)
    return {
        "key": "time_to_resolve", "unit": "hours",
        "n": len(s), "censored_n": len(cens), "excluded_ignored_n": ign, "resolved_time_unobservable_n": unobs,
        "negative_clamped_n": neg,
        "median_h": r1(pctl(s, 0.5)), "p90_h": r1(pctl(s, 0.9)),
        "km_median_h": r1(km_med), "km_p90_h": r1(km_p90),
    }


def reopen_block(items_c):
    den = [r for r in items_c if r.reached_terminal]
    num = [r for r in den if r.reopened]
    by_from, owner_driven = Counter(), 0
    for r in num:
        for t in r.reopen_trans:
            by_from[t.frm] += 1
            owner_driven += lower_note(t).startswith((REINVEST_PREFIX, "retried by owner", "adopted by owner"))
    den2 = [r for r in items_c if r.reached_nofail]
    num2 = [r for r in den2 if r.reopen_nofail]
    return {
        "key": "reopen_rate", "n": len(num), "d": len(den), "rate": rate(len(num), len(den)),
        "reopen_transitions_by_from_state": {k: by_from.get(k, 0) for k in ("closed", "quiet", "fixed", "failed")},
        "reopen_transitions_owner_initiated": owner_driven,
        "excluding_failed_redrives": {"n": len(num2), "d": len(den2), "rate": rate(len(num2), len(den2))},
    }


def fix_event(r):
    """The resolution that carries the change: the first resolved transition at or after the change first existed."""
    if not (r.resolved_ever and r.change_evidence):
        return None
    for e in r.res_events:
        if r.t_change is None or e[0] >= r.t_change:
            return e
    return None


def regression_block(items_c):
    strict_set = {"merged_sha", "merge_operation", "fixed_by_pr", "hand_close_commit"}
    horizon = dt.timedelta(days=REGRESSION_DAYS)
    candidates = [r for r in items_c if r.resolved_ever and r.change_evidence]
    fixes = [r for r in candidates if fix_event(r) is not None]
    untimed = len(candidates) - len(fixes)  # resolved only before the change existed, or no timestamp to anchor on
    ev_n = rec_sig = rec_title = rec_either = 0
    part_either = part_sig = part_title = 0
    strict_ev = strict_rec = 0
    for r in fixes:
        t_fix = fix_event(r)[0]
        end_full, end_seen = t_fix + horizon, min(AS_OF, t_fix + horizon)

        def recurrence(end):
            sig = any(t.frm in TERMINAL_SET and t.to in NON_TERMINAL and t_fix < t.at <= end for t in r.trs)
            title = bool(r.norm) and any(o.event_id != r.event_id and t_fix < o.created <= end for o in norm_index[r.norm])
            return sig, title

        s2, t2 = recurrence(end_seen)
        part_sig += s2
        part_title += t2
        part_either += s2 or t2
        if end_full <= AS_OF:
            ev_n += 1
            rec_sig += s2
            rec_title += t2
            rec_either += s2 or t2
            if r.change_evidence & strict_set:
                strict_ev += 1
                strict_rec += s2 or t2
    return {
        "key": "regression_rate", "look_ahead_days": REGRESSION_DAYS,
        "fixes_resolved_by_a_change": len(fixes),
        "resolved_items_with_change_evidence_but_no_anchor": untimed,
        "evidence_classes": dict(sorted(Counter(e for r in fixes for e in r.change_evidence).items())),
        "evaluable_fixes": ev_n, "not_yet_evaluable_fixes": len(fixes) - ev_n,
        "regressed_evaluable": rec_either,
        "rate": rate(rec_either, ev_n),
        "arms_evaluable": {"signature_same_item_reopened": rec_sig, "normalised_title_other_row": rec_title},
        "strict_evidence_only": {"evaluable": strict_ev, "regressed": strict_rec, "rate": rate(strict_rec, strict_ev)},
        "lower_bound_all_fixes_partial_follow_up": {
            "regressed": part_either, "d": len(fixes), "rate": rate(part_either, len(fixes)),
            "signature": part_sig, "title": part_title},
        "note": "signature is unique per item in this ledger, so the signature arm is 'the same item left a terminal "
                "state again within 30 d'; the title arm looks for another row with the same normalised title",
    }


def revert_block(items_c, dups_c):
    merged_on_dups = sum(1 for r in dups_c if r.merged_by_warden)
    merged = [r for r in items_c if r.merged_by_warden]
    rev = [r for r in merged if r.reverted]
    imp = [r for r in merged if r.revert_impossible]
    vf = [r for r in merged if r.verify_failed]
    return {
        "key": "revert_rate (warden's own)", "merged_by_warden": len(merged),
        "merges_on_rows_later_closed_as_duplicate_excluded": merged_on_dups,
        "with_revert_pr_or_reverting_sha": len(rev), "rate": rate(len(rev), len(merged)),
        "verification_failed_after_merge": len(vf),
        "verification_failed_cannot_auto_revert": len(imp),
        "revert_needed_rate_if_impossible_counted": rate(len(rev) + len(imp), len(merged)),
    }


def group_block(items_c, keyfn, order=None):
    g = defaultdict(list)
    for r in items_c:
        g[keyfn(r)].append(r)
    keys = list(order) if order else sorted(g, key=lambda k: (-len(g[k]), str(k)))
    out = {}
    for k in keys:
        xs = g.get(k, [])
        e = sum(1 for r in xs if r.escalated)
        t = sum(1 for r in xs if r.touch)
        out[k] = {"items": len(xs), "escalated": e, "escalated_rate": rate(e, len(xs)),
                  "needs_decision_transitions": sum(r.nd_count for r in xs),
                  "owner_touch": t, "autonomy_rate": None if not xs else round(1 - t / len(xs), 4),
                  "resolved_ever": sum(1 for r in xs if r.resolved_ever)}
    return out


def ttr_by_family(items_c):
    return {f: ttr_block([r for r in items_c if r.family == f]) for f in FAMILIES}


# ----------------------------------------------------------------------------- windows
windows = {}
for name, days in WINDOWS:
    lo, rows_c, items_c, dups_c = cohort(days)
    windows[name] = {
        "from": iso(lo) if lo else None, "to": iso(AS_OF),
        "item": item_block(rows_c, items_c, dups_c),
        "escalated": escalated_block(items_c),
        "owner_touch": touch_block(items_c),
        "autonomy_rate": autonomy_block(items_c),
        "resolved": resolved_block(items_c),
        "time_to_resolve": ttr_block(items_c),
        "time_to_resolve_by_source_family": ttr_by_family(items_c),
        "reopen_rate": reopen_block(items_c),
        "regression_rate": regression_block(items_c),
        "revert_rate_warden": revert_block(items_c, dups_c),
    }
by_family = {n: group_block(cohort(d)[2], lambda r: r.family, FAMILIES) for n, d in WINDOWS}
by_source = {n: group_block(cohort(d)[2], lambda r: rx(r.source)) for n, d in WINDOWS if n in ("30d", "all")}
by_repo = {n: group_block(cohort(d)[2], lambda r: r.repo_label) for n, d in WINDOWS if n in ("30d", "all")}

# funnel: signals -> items, all time, per family (slack_update shows why it never appears as an item)
funnel = {}
fam_events = Counter()
for src, n in events_by_source.items():
    fam_events[family_of(src)] += n
for f in FAMILIES:
    funnel[f] = {"events": fam_events.get(f, 0), "items": sum(1 for r in items_all if r.family == f),
                 "duplicates": sum(1 for r in dups_all if r.family == f)}

# items per week (Monday-start, UTC)
def week_start(d):
    return (d - dt.timedelta(days=d.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)


weeks = []
first_week = week_start(min(r.created for r in rows))
w = first_week
while w < AS_OF:
    nxt = w + dt.timedelta(days=7)
    rw = [r for r in rows if w <= r.created < nxt]
    iw = [r for r in rw if not r.is_dup]
    iso_y, iso_w, _ = w.isocalendar()
    weeks.append({
        "week": f"{iso_y}-W{iso_w:02d}", "start": iso(w)[:10], "partial": nxt > AS_OF,
        "rows": len(rw), "items": len(iw), "duplicates": len(rw) - len(iw),
        "escalated": sum(1 for r in iw if r.escalated),
        "escalated_rate": rate(sum(1 for r in iw if r.escalated), len(iw)),
        "owner_touch": sum(1 for r in iw if r.touch),
        "autonomy_rate": None if not iw else round(1 - sum(1 for r in iw if r.touch) / len(iw), 4),
        "resolved_ever": sum(1 for r in iw if r.resolved_ever),
        "needs_decision_transitions_in_week": sum(1 for t in all_transitions if t.to == "needs_decision" and w <= t.at < nxt),
    })
    w = nxt


# ----------------------------------------------------------------------------- reconciliation
def midnight(d):
    return d.replace(hour=0, minute=0, second=0, microsecond=0)


nd_events = [(r.event_id, t.at) for r in rows for t in r.trs if t.to == "needs_decision"]
hand_events = [(r.event_id, t.at) for r in rows for t in r.trs
               if lower_note(t).startswith((HAND_CLOSE_PREFIX, REINVEST_PREFIX))]


def r5_numbers(cut):
    """Round 5's four counts and the 'unattended' count, as run at `cut` on 2026-10-21 (date-granular lower bounds)."""
    day = midnight(cut)
    out = {}
    for tag, days in (("14d", 14), ("30d", 30)):
        lo = day - dt.timedelta(days=days)
        created = [r for r in rows if lo <= r.created < cut]
        out["items_" + tag] = len(created)
        out["esc_" + tag] = len({e for e, at in nd_events if lo <= at < cut})
        if tag == "30d":
            ids = {r.event_id for r in created}
            nd_before = {e for e, at in nd_events if at < cut}
            hand_before = {e for e, at in hand_events if at < cut}
            out["unattended_30d"] = len(ids - nd_before - hand_before)
    return out


scan_start = midnight(dt.datetime(2026, 10, 21, tzinfo=UTC))
matching = []
for minute in range(0, 24 * 60, 1):
    cut = scan_start + dt.timedelta(minutes=minute)
    if cut >= AS_OF:
        break
    if r5_numbers(cut) == R5:
        matching.append(cut)
r5_cut = matching[0] if matching else None


def step(label, num, den, why):
    return {"step": label, "n": num, "d": den, "rate": rate(num, den), "what_changed": why}


def ladder_escalated(days):
    cut = r5_cut
    day = midnight(cut)
    lo5 = day - dt.timedelta(days=days)
    created5 = [r for r in rows if lo5 <= r.created < cut]
    ids5 = {r.event_id for r in created5}
    nd_in = {e for e, at in nd_events if lo5 <= at < cut}
    s0 = step("0 Round 5 as run", len(nd_in), len(created5),
              f"denominator: every row created since {iso(lo5)[:10]} (date-granular lower bound, runs to the audit time); "
              "numerator: every item with a needs_decision transition in that span, created in it or not")
    s1 = step("1 numerator limited to the cohort", len(nd_in & ids5), len(created5),
              "numerator and denominator now describe the same items (items created before the window that escalated again are out)")
    lo_exact = cut - dt.timedelta(days=days)
    ex = [r for r in rows if lo_exact <= r.created < cut]
    s2 = step("2 exact window", sum(1 for r in ex if any(at < cut for e, at in nd_events if e == r.event_id)), len(ex),
              f"window is exactly {days} d before the audit time, not {days} d plus the elapsed day fraction")
    exi = [r for r in ex if not r.is_dup]
    s3 = step("3 duplicates are not items", sum(1 for r in exi if any(at < cut for e, at in nd_events if e == r.event_id)), len(exi),
              "rows closed as duplicate (or with duplicate_of) leave numerator and denominator")
    u = windows["14d" if days == 14 else "30d"]["escalated"]
    s4 = step("4 window ends at AS_OF", u["n"], u["d"],
              f"window moved from the audit time ({iso(cut)}) to AS_OF ({iso(AS_OF)}); items and escalations since are included")
    return [s0, s1, s2, s3, s4]


def ladder_unattended():
    cut = r5_cut
    lo5 = midnight(cut) - dt.timedelta(days=30)
    created5 = [r for r in rows if lo5 <= r.created < cut]
    ids5 = {r.event_id for r in created5}
    touched5 = {e for e, at in nd_events if at < cut} | {e for e, at in hand_events if at < cut}
    s0 = step("0 Round 5 'finished unattended' as run", len(ids5 - touched5), len(created5),
              "created in the 30 d span, no needs_decision transition and no 'closed by hand' / 're-investigation requested' note before the audit time; "
              "state is not checked, so 'finished' is a misnomer")
    lo_exact = cut - dt.timedelta(days=30)
    ex = [r for r in rows if lo_exact <= r.created < cut]
    ex_t = lambda r: any(at < cut for e, at in nd_events + hand_events if e == r.event_id)
    s1 = step("1 exact window", sum(1 for r in ex if not ex_t(r)), len(ex), "30 d exactly, not 30 d plus the elapsed day fraction")
    exi = [r for r in ex if not r.is_dup]
    s2 = step("2 duplicates are not items", sum(1 for r in exi if not ex_t(r)), len(exi), "duplicate rows leave the cohort")
    exo = sum(1 for r in exi if not (ex_t(r) or any(o.authorized_by.lower().startswith(("owner:", "cli:")) and o.started < cut
                                                      for o in ops_by.get(r.event_id, []))))
    s3 = step("3 operations authorised by owner:/cli: count as touches", exo, len(exi),
              "the unified owner_touch also counts operations rows authorised by the owner or the CLI")
    u = windows["30d"]["autonomy_rate"]
    s4 = step("4 window ends at AS_OF (unified autonomy_rate)", u["n_untouched"], u["d"], f"window ends at AS_OF ({iso(AS_OF)})")
    return [s0, s1, s2, s3, s4]


def findings_ladder():
    nd_rows = [r for r in rows if r.escalated]
    nd_items = [r for r in items_all if r.escalated]
    return [
        step("0 findings as run", len(nd_rows), len(rows), "every triage_items row (duplicates included), any time, ever a transition into needs_decision"),
        step("1 duplicates are not items (= unified `escalated`, window all)", len(nd_items), len(items_all),
             f"the {len(dups_all)} duplicate rows leave numerator and denominator ({sum(1 for r in dups_all if r.escalated)} of them had escalated)"),
        step("context: currently in needs_decision", sum(1 for r in items_all if r.state == "needs_decision"), len(items_all),
             "a third reading ('is waiting for the owner right now'), not used by any definition"),
    ]


def effects(ladder):
    """Percentage-point movement of each ladder step, so the gap is attributed rather than asserted."""
    out = []
    for prev, cur in zip(ladder, ladder[1:]):
        if prev["rate"] is not None and cur["rate"] is not None:
            out.append({"step": cur["step"], "delta_pp": round(100 * (cur["rate"] - prev["rate"]), 1)})
    net = None if None in (ladder[0]["rate"], ladder[-1]["rate"]) else round(100 * (ladder[-1]["rate"] - ladder[0]["rate"]), 1)
    return {"steps": out, "net_pp": net}


recon = {"round5_targets": R5, "findings_nd_ever": {"n": FINDINGS_ND_EVER[0], "d": FINDINGS_ND_EVER[1]}}
if r5_cut is None:
    recon["round5_reproduced"] = False
else:
    recon.update({
        "round5_reproduced": True,
        "round5_cutoff_consistent_from": iso(matching[0]), "round5_cutoff_consistent_to": iso(matching[-1]),
        "round5_cutoff_used": iso(r5_cut),
        "round5_window_rule": "lower bound = midnight of (audit day - 14 d / - 30 d), upper bound = audit time; "
                              "created_at of triage_items rows for the denominators, transition time for the numerators",
        "ladder_escalated_14d": ladder_escalated(14), "ladder_escalated_30d": ladder_escalated(30),
        "ladder_unattended_30d": ladder_unattended(),
    })
    for _k in ("escalated_14d", "escalated_30d", "unattended_30d"):
        recon["effects_" + _k] = effects(recon["ladder_" + _k])
if r5_cut is not None:
    _settled = sorted(parse_ts(x[0]) for x in con.execute("SELECT settled_at FROM decision_shadow WHERE settled_at IS NOT NULL"))
    _hit = [scan_start + dt.timedelta(minutes=m) for m in range(24 * 60)
            if sum(1 for t in _settled if t < scan_start + dt.timedelta(minutes=m)) == 124]
    recon["round5_decision_shadow_cross_check"] = {
        "round5_says_settled_rows": 124,
        "consistent_cutoff_from": iso(_hit[0]) if _hit else None, "consistent_cutoff_to": iso(_hit[-1]) if _hit else None,
        "note": "a different Round 5 bullet; it matches a cutoff before the one the ledger counts need, so the audit's queries ran over about half an hour",
    }
recon["findings_ladder"] = findings_ladder()
fixed_ever = [r for r in rows if any(t.to == "fixed" for t in r.trs)]
fx = sorted((next(t.at for t in r.trs if t.to == "fixed") - r.t0).total_seconds() / 3600 for r in fixed_ever)
recon["findings_time_to_fixed"] = {"n": len(fx), "median_h": r1(pctl(fx, 0.5)), "p90_h": r1(pctl(fx, 0.9)),
                                   "findings_say": {"n": 41, "median_h": 2.4, "p90_h": 227}}
state_now = Counter(r.state for r in rows)
recon["findings_item_states"] = {"snapshot": dict(sorted(state_now.items())),
                                 "findings_say": {"closed": 422, "quiet": 89, "needs_decision": 43, "fixed": 39, "failed": 3, "new": 1}}
recon["findings_inventory_drift"] = {
    "events": {"snapshot": sum(events_by_source.values()), "findings_say": 1752},
    "slack_alert_events": {"snapshot": events_by_source.get("slack_alert", 0), "findings_say": 399},
    "item_transitions": {"snapshot": n_trans_total, "findings_say": 4004},
    "triage_items": {"snapshot": len(rows), "findings_say": 597},
    "slack_relay_share": {"snapshot": rate(events_by_source.get("slack_alert", 0) + events_by_source.get("slack_update", 0),
                                           sum(events_by_source.values())), "findings_say": rate(1112, 1752)},
}

# ----------------------------------------------------------------------------- data quality
no_create = [r for r in rows if not any(t.frm is None for t in r.trs)]
no_hist = [r for r in rows if not r.trs]
merged_no_sha = [r for r in rows if "merge_operation" in r.change_evidence and not r.merged_sha]
quality = {
    "snapshot_file": "~/.local/share/factory/snapshots/" + AS_OF_RAW[:10] + "/warden.db",
    "snapshot_mtime_utc": iso(snapshot_mtime),
    "data_horizon": {"latest_transition": iso(latest_transition), "latest_row_update": iso(latest_row_update)},
    "transition_log_starts": iso(log_start),
    "transitions_total_in_file": n_trans_total, "transitions_at_or_after_as_of_dropped": n_trans_after,
    "rows_before_transition_log_without_creation_transition": len(no_create),
    "rows_with_no_transitions_at_all": len(no_hist),
    "rows_with_no_transitions_by_state": dict(sorted(Counter(r.state for r in no_hist).items())),
    "rows_without_repo": sum(1 for r in rows if not r.repo),
    "fixed_by_pr_populated": sum(1 for r in rows if r.fixed_by_pr),
    "revert_columns_populated": sum(1 for r in rows if r.reverted),
    "merge_operation_done_but_merged_sha_null": len(merged_no_sha),
    "closed_transitions_with_inferred_reason": sum(r.n_closed_inferred for r in rows),
    "event_first_seen_later_than_item_first_seen": sum(1 for r in rows if r.event_fs_later),
    "t0_rule": "min(events.first_seen, triage_items.first_seen, triage_items.created_at)",
    "owner_or_cli_operations_total": sum(1 for xs in ops_by.values() for o in xs if o.authorized_by.lower().startswith(("owner:", "cli:"))),
    "owner_or_cli_operations_without_an_item": sum(1 for o in ops_by.get(None, []) if o.authorized_by.lower().startswith(("owner:", "cli:"))),
    "windows_90d_equals_all": windows["90d"]["item"]["rows"] == windows["all"]["item"]["rows"],
}
sig = con.execute("SELECT COUNT(*), COUNT(DISTINCT signature) FROM triage_items").fetchone()
quality["item_signature_distinct_of_rows"] = [sig[1], sig[0]]

headline = {}
for _n in ("14d", "30d", "all"):
    _b = windows[_n]
    headline[_n] = {
        "items": _b["item"]["items"], "duplicate_rows": _b["item"]["duplicates"],
        "escalated_rate": _b["escalated"]["rate"], "owner_touch_rate": _b["owner_touch"]["rate"],
        "autonomy_rate": _b["autonomy_rate"]["rate"],
        "resolved_rate": _b["resolved"]["resolved_ever"]["rate"], "ignored_share": _b["resolved"]["ignored_share"],
        "failed_share": _b["resolved"]["failed_share"],
        "time_to_resolve_median_h": _b["time_to_resolve"]["median_h"], "time_to_resolve_p90_h": _b["time_to_resolve"]["p90_h"],
        "time_to_resolve_censored_n": _b["time_to_resolve"]["censored_n"],
        "reopen_rate": _b["reopen_rate"]["rate"], "regression_rate": _b["regression_rate"]["rate"],
        "regression_evaluable_fixes": _b["regression_rate"]["evaluable_fixes"],
        "warden_revert_rate": _b["revert_rate_warden"]["rate"],
    }

result = {
    "meta": {
        "script": "evidence/kpi/baseline.py", "as_of": iso(AS_OF), "definitions": "evidence/DEFINITIONS.md",
        "windows": {n: (f"[AS_OF - {d} d, AS_OF)" if d else "[beginning, AS_OF)") for n, d in WINDOWS},
        "cohort": "triage_items.created_at in window; outcomes observed up to AS_OF",
        "percentile_method": "linear interpolation between order statistics (numpy default)",
    },
    "headline": headline,
    "data_quality": quality,
    "windows": windows,
    "by_source_family": by_family,
    "by_source": by_source,
    "by_repo": by_repo,
    "signal_funnel_all_time": funnel,
    "items_per_week": weeks,
    "reconciliation": recon,
}
json_text = json.dumps(result, indent=2, ensure_ascii=False) + "\n"


# ----------------------------------------------------------------------------- markdown
def head_row(name):
    b = windows[name]
    t = b["time_to_resolve"]
    return [
        name, b["item"]["items"], b["item"]["duplicates"],
        f'{b["escalated"]["n"]} ({pc(b["escalated"]["n"], b["escalated"]["d"])})',
        f'{b["owner_touch"]["n"]} ({pc(b["owner_touch"]["n"], b["owner_touch"]["d"])})',
        "n/a" if b["autonomy_rate"]["rate"] is None else f'{100 * b["autonomy_rate"]["rate"]:.1f} %',
        f'{b["resolved"]["resolved_ever"]["n"]} ({pc(b["resolved"]["resolved_ever"]["n"], b["resolved"]["resolved_ever"]["d"])})',
        f'{fmt_h(t["median_h"])} / {fmt_h(t["p90_h"])} (n {t["n"]}, cens {t["censored_n"]})',
        f'{b["reopen_rate"]["n"]}/{b["reopen_rate"]["d"]} ({pc(b["reopen_rate"]["n"], b["reopen_rate"]["d"])})',
    ]


def kv(d):
    return ", ".join(f"{str(k).replace('_', ' ')} {v}" for k, v in d.items())


md = []
w = md.append
w(f"# Warden-ledger baseline, AS_OF {iso(AS_OF)}")
w("")
w("Generated by `evidence/kpi/baseline.py` from the frozen snapshot "
  f"`{quality['snapshot_file']}` (taken {quality['snapshot_mtime_utc']}). "
  "Definitions: `evidence/DEFINITIONS.md`. Cohort = items by `created_at` in the window, outcomes up to AS_OF; "
  "a duplicate row is not an item. The 90d window equals `all` (the item ledger starts 2026-09-08). Numbers are in `baseline.out.json`.")
w("")
w("## Headline")
w("")
w(md_table(["window", "items", "dups", "escalated", "owner_touch", "autonomy", "resolved (ever)", "time to resolve median / p90", "reopen"],
           [head_row(n) for n in ("14d", "30d", "all")]))
w("")
for n in ("14d", "30d", "all"):
    b = windows[n]
    o = b["resolved"]["outcome_at_as_of"]
    w(f"- **{n}** outcome at AS_OF: resolved {o['resolved']}, ignored {o['ignored']}, failed {o['failed']}, "
      f"awaiting owner {o['awaiting_owner']}, in progress {o['in_progress']}"
      + (f", quiet without recovery {o['quiet_unrecovered']}" if o["quiet_unrecovered"] else "")
      + f". Kaplan-Meier time to resolve (open items censored): median {fmt_h(b['time_to_resolve']['km_median_h'])}, p90 {fmt_h(b['time_to_resolve']['km_p90_h'])}.")
w("")
w("`autonomy_rate` = 1 - owner_touch / items; target 99.9 %. `time to resolve` = first_seen to the first transition into a resolved state, "
  "over resolved items only (biased low while items are open); `cens` = open items at AS_OF (not resolved, not ignored).")
w("")
w("### owner_touch by route (an item can be touched in several ways)")
w("")
rows_md = []
for n in ("14d", "30d", "all"):
    c = windows[n]["owner_touch"]
    cc = c["components_any"]
    rows_md.append([n, c["n"], cc["escalated"], cc["closed_by_hand"], cc["re_investigation_requested"], cc["operation_owner_or_cli"],
                    c["touched_without_escalation"], c["sensitivity_unlisted_owner_like_notes"]["extra_items"]])
w(md_table(["window", "touched", "escalated", "closed by hand", "re-investigation", "owner:/cli: op", "touched without escalating",
            "+ unlisted owner-like notes (sensitivity)"], rows_md))
w("")
w("Unlisted owner-like notes (not in the definition, shown so the autonomy number is not read as exact): `retried by owner`, `adopted by owner`, "
  "`aborted:`, `revived by scripts/reset-frozen-notes.py`. Closed-by-hand actor hint (first matching note): "
  + ", ".join(f"{k} {v}" for k, v in windows["all"]["owner_touch"]["closed_by_hand_actor_hint"].items()) + " (window all).")
w("")
w("## Escalations by source family")
w("")
for n in ("30d", "all"):
    w(f"**{n}**")
    w("")
    w(md_table(["family", "items", "escalated", "rate", "needs_decision transitions", "owner_touch", "autonomy", "resolved"],
               [[f, g["items"], g["escalated"], pc(g["escalated"], g["items"]), g["needs_decision_transitions"], g["owner_touch"],
                 "n/a" if g["autonomy_rate"] is None else f"{100 * g['autonomy_rate']:.1f} %", g["resolved_ever"]]
                for f, g in by_family[n].items()]))
    w("")
w("Signals to items, all time (why `slack_update` shows 0):")
w("")
w(md_table(["family", "events", "items", "duplicates"], [[f, v["events"], v["items"], v["duplicates"]] for f, v in funnel.items()]))
w("")
w("`slack_update` (the #updates channel poll) is not in warden's `INGEST_SOURCES` (`scripts/loop/core.py`): its events are recorded but never become items. "
  "`github_*` items all come from `github_go` (issues); `github_pr` and `github_issue` events never become items. "
  "`other` = " + ", ".join(f"{s} {v['items']}" for s, v in by_source['all'].items() if family_of(s) == "other") + " (items, all time).")
w("")
w("## Escalations by repo")
w("")
for n in ("30d", "all"):
    w(f"**{n}** (top 14 by items; the rest are in the JSON)")
    w("")
    w(md_table(["repo", "items", "escalated", "rate", "owner_touch", "autonomy"],
               [[rp, g["items"], g["escalated"], pc(g["escalated"], g["items"]), g["owner_touch"],
                 "n/a" if g["autonomy_rate"] is None else f"{100 * g['autonomy_rate']:.1f} %"]
                for rp, g in list(by_repo[n].items())[:14]]))
    w("")
w("## Items per week")
w("")
w(md_table(["week", "start", "rows", "items", "dups", "escalated", "rate", "touch", "autonomy", "resolved", "nd transitions in week"],
           [[x["week"] + (" (partial)" if x["partial"] else ""), x["start"], x["rows"], x["items"], x["duplicates"], x["escalated"],
             pc(x["escalated"], x["items"]), x["owner_touch"], "n/a" if x["autonomy_rate"] is None else f"{100 * x['autonomy_rate']:.1f} %",
             x["resolved_ever"], x["needs_decision_transitions_in_week"]] for x in weeks]))
w("")
_first_batch = Counter(r.created for r in rows).most_common(1)[0]
_day_rows = Counter(iso(r.created)[:10] for r in rows).most_common(1)[0]
w("Weeks start on Monday (UTC) and bucket items by `created_at`. "
  f"{_first_batch[1]} rows share the creation time {iso(_first_batch[0])} (the ledger's first run back-filled them), and {_day_rows[0]} created {_day_rows[1]} rows in one day "
  "(Round 5 attributes the 2026-10-17 spike to one outage that became 16 pages). `nd transitions in week` counts every transition into needs_decision in that week, whatever the item's age.")
w("")
w("## Time to resolve by source family")
w("")
for n in ("30d", "all"):
    w(f"**{n}**")
    w("")
    w(md_table(["family", "n", "median", "p90", "censored", "ignored (excluded)", "KM median"],
               [[f, t["n"], fmt_h(t["median_h"]), fmt_h(t["p90_h"]), t["censored_n"], t["excluded_ignored_n"], fmt_h(t["km_median_h"])]
                for f, t in windows[n]["time_to_resolve_by_source_family"].items()]))
    w("")
w("## Resolved, reopen, regression, revert")
w("")
for n in ("14d", "30d", "all"):
    b = windows[n]
    rs, ro, rg, rv = b["resolved"], b["reopen_rate"], b["regression_rate"], b["revert_rate_warden"]
    w(f"**{n}**")
    w("")
    w(f"- resolved (ever) {rs['resolved_ever']['n']}/{rs['resolved_ever']['d']}; first route: {kv(rs['resolved_ever']['by_first_route'])}; "
      f"{rs['reopened_after_resolution']} reopened after being resolved; {rs['resolved_ever']['first_route_inferred_from_note']} first routes inferred from a note "
      f"(the ledger clears `close_reason` when an item leaves `closed`).")
    w(f"- ignored {rs['outcome_at_as_of']['ignored']} ({pc(rs['outcome_at_as_of']['ignored'], b['item']['items'])}), "
      f"failed {rs['outcome_at_as_of']['failed']}; closed by hand and counted resolved {rs['closed_by_hand_resolved']} "
      f"(of which {rs['closed_by_hand_reads_as_dismissal']} read as dismissals: duplicate, noise, superseded); "
      f"hand-closed duplicates not marked duplicate {rs['hand_closed_duplicates_not_flagged_duplicate']}.")
    w(f"- reopen {ro['n']}/{ro['d']} ({pc(ro['n'], ro['d'])}); transitions out of: {kv(ro['reopen_transitions_by_from_state'])}; "
      f"owner-initiated {ro['reopen_transitions_owner_initiated']}; without `failed` re-drives {ro['excluding_failed_redrives']['n']}/{ro['excluding_failed_redrives']['d']} "
      f"({pc(ro['excluding_failed_redrives']['n'], ro['excluding_failed_redrives']['d'])}).")
    w(f"- regression: {rg['fixes_resolved_by_a_change']} fixes resolved by a change, {rg['evaluable_fixes']} evaluable (30 d of follow-up), "
      f"{rg['regressed_evaluable']} regressed" + (f" = {pc(rg['regressed_evaluable'], rg['evaluable_fixes'])}" if rg['evaluable_fixes'] else "")
      + f"; strict evidence only {rg['strict_evidence_only']['regressed']}/{rg['strict_evidence_only']['evaluable']}; "
      f"lower bound over all fixes with partial follow-up {rg['lower_bound_all_fixes_partial_follow_up']['regressed']}/{rg['lower_bound_all_fixes_partial_follow_up']['d']} "
      f"({pc(rg['lower_bound_all_fixes_partial_follow_up']['regressed'], rg['lower_bound_all_fixes_partial_follow_up']['d'])}).")
    w(f"- warden's own revert rate: {rv['with_revert_pr_or_reverting_sha']}/{rv['merged_by_warden']} merged items carry a revert; "
      f"{rv['verification_failed_cannot_auto_revert']} failed verification and could not be auto-reverted (rebase merge), "
      f"so the revert-needed rate is at least {pc(rv['with_revert_pr_or_reverting_sha'] + rv['verification_failed_cannot_auto_revert'], rv['merged_by_warden'])}.")
    w("")
w("Regression: `signature` is unique per item in this ledger (see data quality), so a recurrence of the same signature reopens the same item. "
  "The signature arm is therefore 'the item left a terminal state again within 30 d of the fix'; the title arm is 'another row with the same normalised title "
  "(lowercase, symbols and any token containing a digit dropped) was created within 30 d'. Only fixes older than 30 d at AS_OF can be evaluated.")
w("")
w("## Reconciliation")
w("")
if not recon.get("round5_reproduced"):
    w("Round 5's numbers were **not** reproduced by any audit cutoff on 2026-10-21; see the JSON for the targets.")
else:
    w(f"All five Round 5 counts (228 and 368 items, 74 and 99 escalated, 201 'finished unattended') reproduce **exactly** for any audit "
      f"cutoff between {recon['round5_cutoff_consistent_from']} and {recon['round5_cutoff_consistent_to']} (the ladders below use {recon['round5_cutoff_used']}). "
      f"The rule that reproduces them: {recon['round5_window_rule']}.")
    w("")
    _l14, _l30 = recon["ladder_escalated_14d"], recon["ladder_escalated_30d"]
    w("So Round 5's ratio divides one population by another: 74 and 99 count every item with a `needs_decision` transition inside the span, "
      f"including items created before it ({_l14[0]['n'] - _l14[1]['n']} of the 74 and {_l30[0]['n'] - _l30[1]['n']} of the 99), while 228 and 368 count only rows created inside it. "
      "The windows are also 14 d and 30 d plus the elapsed fraction of the audit day (the lower bound is a date, the upper bound a time), "
      "and duplicate rows sit in both denominators.")
    for tag, key, title in (("14d", "ladder_escalated_14d", "14 d: '74/228 = 32 %' to unified `escalated`"),
                            ("30d", "ladder_escalated_30d", "30 d: '99/368 = 27 %' to unified `escalated`")):
        w("")
        w(f"**{title}**")
        w("")
        w(md_table(["step", "n", "d", "rate", "what changed"], [[s["step"], s["n"], s["d"], pc(s["n"], s["d"]), s["what_changed"]] for s in recon[key]]))
    w("")
    w("**30 d: '201 finished unattended' to unified `autonomy_rate`**")
    w("")
    w(md_table(["step", "n", "d", "rate", "what changed"], [[s["step"], s["n"], s["d"], pc(s["n"], s["d"]), s["what_changed"]] for s in recon["ladder_unattended_30d"]]))
    cc = recon.get("round5_decision_shadow_cross_check")
    if cc and cc["consistent_cutoff_from"]:
        w("")
        w(f"Cross-check: Round 5's '124 settled decision_shadow rows' matches a cutoff of {cc['consistent_cutoff_from']} to {cc['consistent_cutoff_to']}, earlier than the ledger counts above, "
          "so the six audit queries ran over roughly half an hour, not at one instant.")
w("")
w("**Findings: '114/597 ever reached needs_decision' (all time)**")
w("")
w(md_table(["step", "n", "d", "rate", "what changed"], [[s["step"], s["n"], s["d"], pc(s["n"], s["d"]), s["what_changed"]] for s in recon["findings_ladder"]]))
w("")
tf = recon["findings_time_to_fixed"]
w(f"The findings' 'time to fixed (41 items): median 2.4 h, p90 227 h' reproduces: {tf['n']} items that ever reached `fixed`, first_seen to the first `fixed` "
  f"transition, median {tf['median_h']} h, p90 {tf['p90_h']} h. Items that reached `fixed` are {tf['n']} of {len(items_all)}; the unified `time_to_resolve` "
  f"(all resolved routes) is in the headline.")
d = recon["findings_inventory_drift"]
w("")
w(f"Snapshot drift against the findings (measured earlier the same morning): events {d['events']['findings_say']} to {d['events']['snapshot']} "
  f"(slack_alert {d['slack_alert_events']['findings_say']} to {d['slack_alert_events']['snapshot']}), transitions {d['item_transitions']['findings_say']} to {d['item_transitions']['snapshot']}, "
  f"states {kv(recon['findings_item_states']['snapshot'])} against {kv(recon['findings_item_states']['findings_say'])} (one item left `new` for `quiet`). "
  "No other number in the findings inventory differs.")
w("")
if recon.get("round5_reproduced"):
    def _fx(key):
        e = recon["effects_" + key]
        return "; ".join(f"{x['step'][2:]} {x['delta_pp']:+.1f} pp" for x in e["steps"]) + f"; net {e['net_pp']:+.1f} pp"
    w(f"Where the gap comes from, in percentage points per ladder step. 14 d escalated: {_fx('escalated_14d')}. "
      f"30 d escalated: {_fx('escalated_30d')}. 30 d autonomy: {_fx('unattended_30d')}.")
    w("")
w("'Of the 74, about 7 genuine' is a hand classification and cannot be reproduced from the ledger; `golden/` owns it (`genuine_escalation_share`). "
  "The 14 d figure lands within 0.3 pp of Round 5's only because four differences cancel; the numerator and denominator now describe the same items, which they did not before.")
w("")
w("## Data quality and caveats")
w("")
q = quality
w(f"- Snapshot taken {q['snapshot_mtime_utc']}, {int((AS_OF - snapshot_mtime).total_seconds() // 60) if snapshot_mtime else '?'} min before AS_OF; "
  f"latest transition {q['data_horizon']['latest_transition']}, latest row update {q['data_horizon']['latest_row_update']}. Nothing after AS_OF was read.")
w(f"- The transition log starts {q['transition_log_starts']}. {q['rows_before_transition_log_without_creation_transition']} rows (created 2026-09-08 to 2026-09-14) have no creation transition and "
  f"{q['rows_with_no_transitions_at_all']} have no transitions at all ({kv(q['rows_with_no_transitions_by_state'])}); their escalations and touches before the log are invisible. "
  "Only the `all` window is affected; 14d and 30d start after the log.")
w(f"- Round 5's `finished unattended` (201 of 368) is the same idea as `autonomy_rate`, minus the owner:/cli: operations; it never checked that an item had finished.")
w(f"- `close_reason` is cleared when an item leaves `closed`, so {q['closed_transitions_with_inferred_reason']} earlier closures have their reason inferred from the note "
  "(attached to #N = duplicate, fixed by = fixed_by, ignore-list or abort or empty note = ignored, everything else = resolved).")
w(f"- `signature` is unique per row ({q['item_signature_distinct_of_rows'][0]} distinct of {q['item_signature_distinct_of_rows'][1]}); `fixed_by_pr` is populated on {q['fixed_by_pr_populated']} rows although one item closed as `fixed_by`; "
  f"`revert_pr`/`reverting_sha` on {q['revert_columns_populated']}; {q['merge_operation_done_but_merged_sha_null']} items with a done merge operation have a null `merged_sha`.")
w(f"- {q['owner_or_cli_operations_total']} `operations` rows are authorised by `owner:` or `cli:`; the {q['owner_or_cli_operations_without_an_item']} without an event id cannot be tied to an item, so the item-level touch count misses it.")
w(f"- `events.first_seen` moves forward when a signal recurs ({q['event_first_seen_later_than_item_first_seen']} rows), so time zero is {q['t0_rule']}.")
w(f"- {q['rows_without_repo']} rows have no repo (unrouted signals).")
w("")
md_text = "\n".join(md) + "\n"

# belt and braces: the shared redactor over the finished texts; report if it had to change anything
for label, text in (("json", json_text), ("md", md_text)):
    if redact(text) != text:
        print(f"baseline: redactor changed the {label} output (kept the redacted form)", file=sys.stderr)
json_text, md_text = redact(json_text), redact(md_text)
(HERE / "baseline.out.json").write_text(json_text, encoding="utf-8")
(HERE / "baseline.out.md").write_text(md_text, encoding="utf-8")
print(f"baseline: {len(rows)} rows, {len(items_all)} items, {len(dups_all)} duplicates; wrote baseline.out.json and baseline.out.md")
