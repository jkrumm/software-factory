# dora — the five metrics, where the data allows

AS_OF `2026-10-22T08:00:00Z`, window 90 d. Definition keys `dora.*`. Script `dora.py`. SourceRoot repos only (IuRoot deploys run through GitLab CI, not queried).

## Summary

|metric|value|source|coverage|confidence|
|-|-|-|-|-|
|deployment_frequency|1418 deployments in 90 d (110.3/week) across 18 repos; 63 of 91 calendar days had one|actions + rollhook + warden_op + poller, de-duplicated by (repo, commit)|18 repos with records; 84.4% of 90 d commits live in them|high for repos with an Actions deploy workflow, medium for relay-only repos, absent for the rest|
|lead_time_for_changes|median 0.53 h, p90 16.02 h per commit (4915 commits, 1277 deployments from complete sources); oldest commit per deployment median 0.26 h|git author times joined to deployment shas|deployments whose sha resolves in the local default branch|medium: author time is when a commit was written, not pushed; batches of commits wait for one deploy|
|change_failure_rate|literal rule 18.4% (219/1190); item charged to the latest deploy only 2.0%|warden triage items + git reverts vs deployments|deployments from 2026-08-28T06:00:56Z (first triage item) to 2026-10-21T08:00:00Z|low: alert items are mostly infrastructure noise, so this is an upper bound|
|failed_deployment_recovery_time|44 failed deployments, 44 recovered (median 0.27 h, p90 51.63 h), 0 unrecovered; recovery = pipeline green again, not user-facing downtime|failure records of every source|failures any source recorded|low-medium: small n, recovery = next success of the same stream|
|deployment_rework_rate|between 1.5% (confirmed) and 47.5% (any rework commit); best estimate 18.6%|warden ledger + failure/redeploy sequence + commit types|deployments with a measured changeset|low: 'unplanned' is not recorded; bracketed, not measured|

## Deployment frequency

|window|deployments|per week|repos|calendar days with a deploy|
|-|-|-|-|-|
|90d|1418|110.3|18|63/91|
|30d|1170|273.0|18|30/31|
|14d|960|480.0|18|15/15|

Service-level success records before de-duplication (90 d): 2030.

|repo|deployments 90d|per week|sources|source class|lead median h (commit)|lead p90 h|first-commit median h|
|-|-|-|-|-|-|-|-|
|basalt-ui|451|35.08|actions 451, rollhook 64|complete|0.62|3.76|0.65|
|argo|378|29.4|actions 376, rollhook 83|complete|0.24|2.29|0.08|
|weatherorb|174|13.53|actions 166, rollhook 34, warden_op 20|complete|1.05|12.76|0.29|
|research-gateway|137|10.66|poller 59, rollhook 92, warden_op 1|complete|0.05|2.74|0.04|
|email-gateway|82|6.38|actions 82, rollhook 37|complete|0.03|0.52|0.03|
|audio-gateway|65|5.06|actions 65, rollhook 59|complete|0.02|1.62|0.02|
|shutterflow|60|4.67|actions 60, rollhook 21|complete|3.56|122.14|3.36|
|rollhook|13|1.01|actions 11, rollhook 9|complete|0.89|833.53|0.51|
|image-gateway|12|0.93|actions 12, rollhook 9|complete|186.86|395.86|0.71|
|jkrumm.com|12|0.93|actions 12, rollhook 6|complete|0.02|12.53|0.02|
|warden|12|0.93|warden_op 12|partial|6.3|67.91|9.4|
|free-planning-poker|7|0.54|actions 7, rollhook 5|complete|0.13|33.17|0.11|
|agent-gateway|4|0.31|warden_op 4|partial|117.54|165.9|175.46|
|sy-serendipity|4|0.31|actions 4|complete|0.02|0.02|0.02|
|dotfiles|3|0.23|warden_op 3|partial|21.81|71.28|211.92|
|rb|2|0.16|warden_op 2|partial|146.37|146.97|168.31|
|hermes-agent|1|0.08|warden_op 1|-|-|-|-|
|usage-tracker|1|0.08|warden_op 1|-|-|-|-|

Weekly deployments (90 d): 2026-W30 7, 2026-W31 57, 2026-W32 27, 2026-W33 4, 2026-W34 33, 2026-W35 21, 2026-W36 45, 2026-W37 41, 2026-W38 13, 2026-W39 83, 2026-W40 100, 2026-W41 80, 2026-W42 727, 2026-W43 180.

## Lead time for changes

|reading|n|median h|p25 h|p75 h|p90 h|mean h|
|-|-|-|-|-|-|-|
|per commit, author time|4915|0.53|0.16|1.77|16.02|12.65|
|per commit, commit time (landed)|4914|0.02|0.02|0.47|6.91|8.2|
|per deployment, oldest commit|1277|0.26|0.03|0.97|2.66|7.31|
|per deployment, its median commit|1277|0.19|0.03|0.57|1.51|3.48|

Scope: deployments recorded by a complete source (an Actions workflow per push, or the CI-gated poller). Deployments measured 1277 (all sources 1383) of 1418; skipped {'first_deployment_of_repo': 18, 'empty_changeset': 22}; negative-lead samples dropped 29. Sensitivity, all sources: per commit median 0.65 h, p90 33.07 h. per_commit: deploy time - author time, over every commit first shipped by a deployment in the window; per_deployment_first_commit: the oldest commit in each deployment (the 'first commit of a change' reading). Partial sources (warden operations, Slack notices) miss deploys, so commits look older than they were: they are excluded from the headline..

## Change failure rate

Window 2026-08-28T06:00:56Z to 2026-10-21T08:00:00Z. deployment flagged when a failure-signal warden item (origin alert, or [alert] GitHub issue) or a Revert commit on the same repo appears within 24 h after it; alert items are mostly infrastructure signals, so this is an upper bound on deploy-caused failures.

|variant|deployments|flagged|rate|
|-|-|-|-|
|headline_alert_items_or_revert_within_24h|1190|219|18.4%|
|watched_repos_only|721|219|30.4%|
|sensitivity_any_origin_item_or_revert|1190|316|26.6%|
|sensitivity_alert_items_only|1190|96|8.1%|
|sensitivity_reverts_only|1190|165|13.9%|
|sensitivity_item_charged_to_latest_deploy_only|1190|24|2.0%|

The literal rule flags EVERY deploy of the repo in the 24 h before an item or revert, so at the observed rate (median_deployments_per_day_in_window, pooled over repos) one signal flags a whole day of deploys. sensitivity_item_charged_to_latest_deploy_only charges each item/revert to the deploy before it and is the better estimate of deploy-caused failures; the definition in DEFINITIONS.md should say which one is meant. Median deployments per day in the window: 12.

## Failed deployments and recovery

Failed deployments in 90 d: 44 {'actions': 28, 'rollhook': 9, 'warden_op': 7}; recovered 44, unrecovered (censored) 0. Median 0.27 h, p90 51.63 h; within 1 h 27, within 24 h 35. Failure kinds: {'actions:workflow_failure': 28, 'rollhook:compose': 2, 'rollhook:docker_pull': 1, 'rollhook:other': 4, 'rollhook:rolling_deploy': 2, 'warden_op:exit': 7}.

## Deployment rework rate

|reading|deployments|rate|
|-|-|-|
|lower_bound_confirmed: ships a warden merge that came from an alert item (origin alert or an [alert] issue), or is the first success within 24 h after a failed deployment of its stream|21 of 1385|1.5%|
|best_estimate_plus_fix_only: adds deployments whose whole changeset is fix/revert commits|258 of 1385|18.6%|
|upper_bound_plus_any_rework_commit: adds deployments containing any fix/revert commit that touched a file changed in the preceding 7 days (rework_share's commit flag)|658 of 1385|47.5%|

deploys that ship an unplanned fix / all deploys; 'unplanned' is not recorded anywhere, so three nested readings bracket it.

## Sources and coverage

|source|deployments 90d|covers|cannot see|
|-|-|-|-|
|actions|1246|repos with a deploy workflow; push + completion time, sha, conclusion|deploys not run by a workflow (make deploy on the mini, launchd), RollHook-side failures after a green workflow|
|rollhook|419|VPS services behind RollHook|anything warden's Slack relay dropped or folded; capture ratio vs Actions in relay_capture|
|warden_op|44|deploys run by warden's verify lane since 2026-09-29|every deploy the owner or a wave ran by hand|
|poller|59|research-gateway on the mini since 2026-09-23 (CI-gated)|research-gateway deploys before the poller (RollHook notices cover them until 2026-09-26)|

Repos with deploy records: agent-gateway, argo, audio-gateway, basalt-ui, dotfiles, email-gateway, free-planning-poker, hermes-agent, image-gateway, jkrumm.com, rb, research-gateway, rollhook, shutterflow, sy-serendipity, usage-tracker, warden, weatherorb. Commit share in those repos: 84.4%.

Repos with 25+ commits in 90 d and no deploy record: brain (493), vps (179), linewatch (141), modelpick (113), homelab-private (107), homelab (94), dotfiles-private (88), basalt-ui-obsidian (64), tinycast-extensions (25).

Relay capture (Actions deployments also seen as RollHook notices in warden's Slack ingest):

|repo|Actions|notices|captured|
|-|-|-|-|
|argo|376|83|21.5%|
|audio-gateway|65|59|90.8%|
|basalt-ui|451|64|14.2%|
|email-gateway|82|37|45.1%|
|free-planning-poker|7|5|71.4%|
|image-gateway|12|9|75.0%|
|jkrumm.com|12|6|50.0%|
|rollhook|11|9|63.6%|
|shutterflow|60|21|35.0%|
|weatherorb|166|34|20.5%|

Per week (repos with both): 2026-W30 9/8, 2026-W31 43/28, 2026-W32 22/12, 2026-W33 7/4, 2026-W34 44/29, 2026-W35 26/24, 2026-W36 53/45, 2026-W37 49/34, 2026-W38 19/14, 2026-W39 45/46, 2026-W40 101/103, 2026-W41 7/45, 2026-W42 9/754, 2026-W43 8/238 (notices/runs).

## Notes

- Deployment frequency counts distinct (repo, commit) successes; service_level_success_records_90d counts every service/workflow record before de-duplication.
- The warden Slack relay captures only part of what GitHub Actions ran: compare relay_capture before reading rollhook-only numbers.
- Repos deployed by hand or by launchd on the mini (dotfiles, warden, agent-gateway, hermes-agent, usage-tracker, ...) appear only through warden operations since 2026-09-29: their frequency is a floor, not a measurement.
- dotfiles has no deployment event by design: a merged commit is live once symlinked, so its lead time is its commit time.
- Lead time is computed on the default branch graph as fetched; commits of deployments newer than the last fetch are unresolved and counted in assembly.unresolved_shas_by_source.
