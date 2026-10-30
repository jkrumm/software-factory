# git_delivery — delivery, rework and reverts

AS_OF `2026-10-22T08:00:00Z`, window 90 d (committer date in [2026-07-24T08:00:00Z, AS_OF)), default branch only. Definition keys: `revert_rate`, `rework_share`. Script: `git_delivery.py`.

## Pooled

|scope|repos|commits|per week|owner|bot|agent identity|other human|fix proxy|rework share|reverts|
|-|-|-|-|-|-|-|-|-|-|-|
|all|46/53|9273|721.2|8836|101|5|331|27.7%|25.6%|14 (0.1%)|
|SourceRoot|33/33|8624|670.8|8519|100|5|0|27.7%|26.3%|12 (0.1%)|
|IuRoot|13/20|649|50.5|317|1|0|331|26.5%|16.5%|2 (0.3%)|

## Commits per week (all repos pooled)

|week|commits|rework|rework share|reverts|busiest repo|its share|
|-|-|-|-|-|-|-|
|2026-W30|67|17|25.4%|0|dotfiles|38.8%|
|2026-W31|475|91|19.2%|1|basalt-ui|17.9%|
|2026-W32|246|48|19.5%|1|brain|12.6%|
|2026-W33|150|16|10.7%|0|epos_fe.booking|24.0%|
|2026-W34|383|73|19.1%|1|basalt-ui|27.2%|
|2026-W35|295|62|21.0%|0|weatherorb|26.8%|
|2026-W36|343|51|14.9%|3|basalt-ui|30.0%|
|2026-W37|676|117|17.3%|0|dotfiles|12.7%|
|2026-W38|241|36|14.9%|0|hermes-agent|19.9%|
|2026-W39|680|115|16.9%|1|shutterflow|30.3%|
|2026-W40|789|181|22.9%|1|basalt-ui|27.3%|
|2026-W41|813|165|20.3%|0|warden|23.1%|
|2026-W42|3521|1194|33.9%|6|basalt-ui|31.8%|
|2026-W43|594|208|35.0%|0|basalt-ui|29.0%|

## Top 10 by rework share (repos with >= 25 commits)

|repo|root|commits|rework|rework share|fix proxy|reverts|revert rate|
|-|-|-|-|-|-|-|-|
|argo|SourceRoot|1140|591|51.8%|52.5%|2|0.2%|
|research-gateway|SourceRoot|269|106|39.4%|42.4%|3|1.1%|
|audio-gateway|SourceRoot|82|30|36.6%|39.0%|0|0.0%|
|agent-gateway|SourceRoot|258|90|34.9%|37.2%|1|0.4%|
|homelab-private|SourceRoot|107|37|34.6%|39.2%|0|0.0%|
|basalt-ui|SourceRoot|1884|571|30.3%|30.7%|0|0.0%|
|rb|SourceRoot|125|37|29.6%|39.2%|0|0.0%|
|warden|SourceRoot|528|151|28.6%|28.6%|0|0.0%|
|tinycast-extensions|SourceRoot|25|7|28.0%|28.0%|0|0.0%|
|epos.student-enrolment|IuRoot|140|39|27.9%|46.4%|0|0.0%|

## Top 10 by revert rate (repos with >= 25 commits)

|repo|root|commits|rework|rework share|fix proxy|reverts|revert rate|
|-|-|-|-|-|-|-|-|
|rollhook|SourceRoot|54|8|14.8%|16.7%|1|1.8%|
|epos_fe.booking|IuRoot|56|8|14.3%|28.6%|1|1.8%|
|research-gateway|SourceRoot|269|106|39.4%|42.4%|3|1.1%|
|vps|SourceRoot|179|46|25.7%|29.0%|2|1.1%|
|homelab|SourceRoot|94|26|27.7%|35.1%|1|1.1%|
|agent-gateway|SourceRoot|258|90|34.9%|37.2%|1|0.4%|
|weatherorb|SourceRoot|984|232|23.6%|24.1%|2|0.2%|
|argo|SourceRoot|1140|591|51.8%|52.5%|2|0.2%|
|basalt-ui|SourceRoot|1884|571|30.3%|30.7%|0|0.0%|
|shutterflow|SourceRoot|818|80|9.8%|10.0%|0|0.0%|

## Top 10 by absolute reverts

|repo|root|reverts|commits|
|-|-|-|-|
|research-gateway|SourceRoot|3|269|
|argo|SourceRoot|2|1140|
|weatherorb|SourceRoot|2|984|
|vps|SourceRoot|2|179|
|agent-gateway|SourceRoot|1|258|
|homelab|SourceRoot|1|94|
|epos_fe.booking|IuRoot|1|56|
|rollhook|SourceRoot|1|54|
|epos.finance-bridge|IuRoot|1|20|
|basalt-ui|SourceRoot|0|1884|

## Warden's half of revert_rate

Items in window (not duplicates): 556; merged by warden (`merged_sha`): 39; with `revert_pr` or `reverting_sha`: 0; revert rate 0.0%. Merge operations in window: 49 done of 50.

## Agent share of commits

Scope: SourceRoot repos pooled (IuRoot trailer counts stay per repo in repos[].agent_signals). Commits: 8624.

|signal|commits|share of 90 d|
|-|-|-|
|`Claude-Session` trailer|874|10.1%|
|agent identity (Hermes)|5|0.1%|
|warden ledger merge commits|49|0.6%|
|bot author (automation, not agent)|100|1.2%|
|landed through a branch (committer date != author date) - lane indicator|3534|41.0%|

The trailer appears from 2026-08-01 to 2026-09-23 only (874 of 2585 commits in that span, 33.8%) and is absent afterwards. In the saturated weeks 2026-W36, 2026-W37 789 of 896 commits carry it (88.1%): the lower bound on the share of commits made inside a Claude Code session.

|week|commits|with trailer|share|
|-|-|-|-|
|2026-W30|64|0|0.0%|
|2026-W31|432|8|1.8%|
|2026-W32|192|0|0.0%|
|2026-W33|68|0|0.0%|
|2026-W34|351|0|0.0%|
|2026-W35|254|21|8.3%|
|2026-W36|309|271|87.7%|
|2026-W37|587|518|88.2%|
|2026-W38|200|55|27.5%|
|2026-W39|671|1|0.1%|
|2026-W40|766|0|0.0%|
|2026-W41|764|0|0.0%|
|2026-W42|3412|0|0.0%|
|2026-W43|554|0|0.0%|

## Every repo

|repo|root|ref|commits|per wk|owner|bot|agent|other|fix proxy|rework|rework share|reverts|trailer|branch-landed|tip|
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
|basalt-ui|SourceRoot|origin/master|1884|146.53|1784|100|0|0|30.7%|571|30.3%|0|108|1730|2026-10-22|
|argo|SourceRoot|origin/master|1140|88.67|1140|0|0|0|52.5%|591|51.8%|2|41|751|2026-10-21|
|weatherorb|SourceRoot|origin/master|984|76.53|984|0|0|0|24.1%|232|23.6%|2|48|241|2026-10-22|
|shutterflow|SourceRoot|origin/master|818|63.62|818|0|0|0|10.0%|80|9.8%|0|0|282|2026-10-18|
|dotfiles|SourceRoot|origin/master|558|43.4|558|0|0|0|23.8%|119|21.3%|0|117|65|2026-10-22|
|warden|SourceRoot|origin/master|528|41.07|528|0|0|0|28.6%|151|28.6%|0|88|66|2026-10-22|
|brain|SourceRoot|origin/master|493|38.34|493|0|0|0|1.6%|8|1.6%|0|74|1|2026-10-22|
|hermes-agent|SourceRoot|origin/master|306|23.8|302|0|4|0|19.3%|49|16.0%|0|79|13|2026-10-21|
|research-gateway|SourceRoot|origin/master|269|20.92|269|0|0|0|42.4%|106|39.4%|3|20|64|2026-10-16|
|agent-gateway|SourceRoot|origin/master|258|20.07|257|0|1|0|37.2%|90|34.9%|1|40|53|2026-10-22|
|vps|SourceRoot|origin/master|179|13.92|179|0|0|0|29.0%|46|25.7%|2|37|12|2026-10-18|
|linewatch|SourceRoot|origin/master|141|10.97|141|0|0|0|24.1%|32|22.7%|0|14|37|2026-10-15|
|epos.student-enrolment|IuRoot|origin/main|140|10.89|86|0|0|54|46.4%|39|27.9%|0|13|51|2026-10-21|
|rb|SourceRoot|origin/master|125|9.72|125|0|0|0|39.2%|37|29.6%|0|6|38|2026-10-22|
|modelpick|SourceRoot|origin/master|113|8.79|113|0|0|0|14.2%|8|7.1%|0|18|12|2026-10-21|
|homelab-private|SourceRoot|origin/master|107|8.32|107|0|0|0|39.2%|37|34.6%|0|53|9|2026-10-19|
|email-gateway|SourceRoot|origin/master|102|7.93|102|0|0|0|16.7%|16|15.7%|0|1|5|2026-10-14|
|homelab|SourceRoot|origin/master|94|7.31|94|0|0|0|35.1%|26|27.7%|1|14|19|2026-10-22|
|prometheus-epx|IuRoot|origin/main|92|7.16|89|0|0|3|18.5%|15|16.3%|0|10|5|2026-10-20|
|prometheus-scripts|IuRoot|origin/main|92|7.16|89|0|0|3|18.5%|15|16.3%|0|10|5|2026-10-20|
|dotfiles-private|SourceRoot|origin/master|88|6.84|88|0|0|0|4.5%|2|2.3%|0|23|12|2026-10-20|
|audio-gateway|SourceRoot|origin/master|82|6.38|82|0|0|0|39.0%|30|36.6%|0|39|14|2026-10-19|
|epos-orchestrator-frontend|IuRoot|origin/main|67|5.21|0|0|0|67|13.4%|4|6.0%|0|0|47|2026-10-13|
|basalt-ui-obsidian|SourceRoot|origin/master|64|4.98|64|0|0|0|10.9%|5|7.8%|0|5|3|2026-10-15|
|epos_fe.booking|IuRoot|origin/main|56|4.36|4|0|0|52|28.6%|8|14.3%|1|3|33|2026-09-21|
|rollhook|SourceRoot|origin/master|54|4.2|54|0|0|0|16.7%|8|14.8%|1|3|48|2026-10-15|
|prometheus-stack|IuRoot|origin/main|52|4.04|49|0|0|3|15.4%|7|13.5%|0|10|5|2026-10-15|
|usage-tracker|SourceRoot|origin/master|48|3.73|48|0|0|0|39.6%|6|12.5%|0|14|10|2026-10-19|
|image-gateway|SourceRoot|origin/master|45|3.5|45|0|0|0|15.6%|5|11.1%|0|9|12|2026-10-13|
|sy-serendipity|SourceRoot|origin/master|42|3.27|42|0|0|0|7.1%|3|7.1%|0|18|7|2026-10-14|
|epos.study-progress|IuRoot|origin/main|39|3.03|0|0|0|39|30.8%|6|15.4%|0|0|3|2026-09-08|
|epos.exam|IuRoot|origin/master|36|2.8|0|0|0|36|33.3%|4|11.1%|0|0|1|2026-08-26|
|epos_fe.academic-profile|IuRoot|origin/main|31|2.41|0|1|0|30|25.8%|3|9.7%|0|0|3|2026-10-06|
|tinycast-extensions|SourceRoot|origin/master|25|1.94|25|0|0|0|28.0%|7|28.0%|0|0|6|2026-10-16|
|jkrumm.com|SourceRoot|origin/master|23|1.79|23|0|0|0|8.7%|2|8.7%|0|0|0|2026-10-15|
|epos.finance-bridge|IuRoot|origin/main|20|1.56|0|0|0|20|40.0%|6|30.0%|1|0|0|2026-10-14|
|epos-customers-frontend|IuRoot|origin/main|19|1.48|0|0|0|19|0.0%|0|0.0%|0|0|7|2026-10-09|
|free-planning-poker|SourceRoot|origin/master|16|1.24|16|0|0|0|6.2%|0|0.0%|0|3|16|2026-10-11|
|rollhook-action|SourceRoot|origin/main|12|0.93|12|0|0|0|0.0%|0|0.0%|0|0|8|2026-10-13|
|dispatch-scratch|SourceRoot|origin/master|9|0.7|9|0|0|0|0.0%|0|0.0%|0|0|0|2026-08-03|
|king-smith-walkingpad-mac|SourceRoot|origin/master|9|0.7|9|0|0|0|11.1%|0|0.0%|0|2|0|2026-10-10|
|basalt-expr-trial-v1|SourceRoot|master|4|0.31|4|0|0|0|0.0%|0|0.0%|0|0|0|2026-10-18|
|epos_fe.customer-navigation|IuRoot|origin/main|4|0.31|0|0|0|4|0.0%|0|0.0%|0|0|3|2026-09-09|
|basalt-expr-trial|SourceRoot|master|2|0.16|2|0|0|0|0.0%|0|0.0%|0|0|0|2026-10-18|
|kobo-mods|SourceRoot|origin/master|2|0.16|2|0|0|0|0.0%|0|0.0%|0|0|0|2026-10-10|
|epos-data-analytics|IuRoot|origin/main|1|0.08|0|0|0|1|0.0%|0|0.0%|0|0|0|2026-10-13|
|cfn-kafka|IuRoot|origin/master|0|0.0|0|0|0|0|-|0|-|0|0|0|2026-05-18|
|epos.crm-bridge|IuRoot|origin/main|0|0.0|0|0|0|0|-|0|-|0|0|0|2026-07-06|
|epos.dam|IuRoot|origin/main|0|0.0|0|0|0|0|-|0|-|0|0|0|2026-05-19|
|epos.iam|IuRoot|origin/main|0|0.0|0|0|0|0|-|0|-|0|0|0|2026-03-12|
|epos_fe.spa-orchestrator|IuRoot|origin/main|0|0.0|0|0|0|0|-|0|-|0|0|0|2026-07-20|
|prometheus-feuer-agent|IuRoot|origin/main|0|0.0|0|0|0|0|-|0|-|0|0|0|2026-06-10|
|terraform-monitoring|IuRoot|origin/main|0|0.0|0|0|0|0|-|0|-|0|0|0|2025-12-03|

## Repo inventory

Repos analysed: 53 (33 SourceRoot, 20 IuRoot). Linked worktrees skipped as duplicates of their parent: homelab-w7 (of homelab), warden-w8 (of warden). Non-git directories: SourceRoot/_ext, SourceRoot/brain-sources, SourceRoot/sy-serendipity-compare, IuRoot/crm-bridge-retry-tool, IuRoot/epos.student-enrolment.struct-cache, IuRoot/worktrees. Checkouts created after AS_OF (history still counted): prometheus-epx.

## Notes

- commits excludes merge commits (reported as merge_commits); the findings' fix-proxy numbers excluded them too.
- ref is the remote-tracking default branch when present; live.local_ahead_of_remote / live.local_behind_remote show where the local branch differs (a local branch behind the remote is why older counts, e.g. shutterflow, are lower). No fetch is run: tip_date (last commit on the ref at or before AS_OF) shows how fresh each ref is. Everything under `live` is true of the checkout at run time, not at AS_OF, and is the only part of this file that changes between re-runs.
- rework_share uses committer dates; history is read from AS_OF - 100 d so a fix in the first week of the window still sees its 7-day past. share_excl_bot_commits drops bot-authored commits both as the fix and as the 'other commit' (release bumps touch package.json/CHANGELOG).
- Agent attribution cannot come from identity: agents commit as the owner by design (agent-gateway dispatch-git.ts: 'there is no bot author here'). The Claude-Session trailer is the only direct marker and exists only for part of the window; detection methods are listed in agent_share.
- A merge-commit's branch name is parsed from the subject; branches deleted after a rebase-merge leave no trace in git, so branch-name detection undercounts.
- Not done here: after W39 no marker survives in git. Joining the Claude Code transcripts (a `git commit` tool result per commit, matched on author time and subject) would close the gap but means streaming ~15 GB of transcripts for the window, which is not a re-runnable stdlib step.
- IuRoot repos are reduced to counts: no subjects, paths, branch names, identities or SHAs are written for them.
- The set of checkouts is live, not frozen: a repo cloned after AS_OF is still analysed (its history predates AS_OF) and is flagged checkout_created_after_as_of.
