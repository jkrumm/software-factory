# Model price catalog for usage v2 (research, 2026-10-30)

agw research run `01a18c1b-0a3a-722d-86f9-5b12c13c7d95` (standard).

## Bottom line

- **Primary: LiteLLM `model_prices_and_context_window.json`.** It is the only one of the three that carries all five token kinds you bill — input, output, cache read, 5-minute cache write and 1-hour cache write — plus batch, long-context and priority/flex rates, keyed per provider at list prices, in one MIT-licensed JSON file.
- **Fallback: the OpenRouter models API** (`/api/v1/models`, and `/api/v1/models/{author}/{slug}/endpoints` for per-endpoint detail). It does expose `input_cache_write_1h` and long-context overrides, but its prices are the router's routed/serving prices, not provider list prices, and it has no batch rates.
- **models.dev is not a viable primary for this tracker.** Its public `api.json` flattens cost to a single `cache_write` (the 5-minute rate) and has no batch field; the 1-hour write price exists only in the v2 TOML source files in git. Use it as a third, independent list-price sanity check, not as the billing source.
- **None of the three publishes an effective-dated price history in its feed.** Effective dating has to be built on your side: snapshot daily, stamp `valid_from`, keep the previous snapshot, and use each catalog's git history for backfill.

## Format, URL, licence

| | models.dev | OpenRouter | LiteLLM |
|---|---|---|---|
| Endpoint | `https://models.dev/api.json` (plus `models.json`, `catalog.json`, `model-schema.json`) | `https://openrouter.ai/api/v1/models`; per-model `.../models/{author}/{slug}/endpoints` | `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` |
| Unit | USD **per 1M tokens** (TOML source and API) | USD **per token**, decimal strings | USD **per token**, floats (`1e-05` = $10/MTok) |
| Shape | provider → model → flat `cost{input,output,cache_read,cache_write,reasoning,tiers[]}` | `data[]` of models, each with aggregate `pricing`, plus an `endpoints[]` array carrying per-provider pricing | flat map of `provider/model` → rate keys |
| Licence | MIT | No data licence published (API terms apply) | MIT for everything outside `enterprise/` |
| Size / scale | full catalogue, one document | router catalogue | 1,476 models, 109 providers as of 2026-10-30 |

LiteLLM's licence file is explicit: content outside `enterprise/` is MIT (the GitHub licence API reports "Other"/NOASSERTION only because of that split). models.dev's licence file is a plain MIT text.

## Anthropic: the Claude 5 family is where the three diverge

Anthropic's published list, USD per MTok (input / 5m write / 1h write / cache read / output): Fable 5.1 `10 / 12.50 / 20 / 0.25 / 50`; Opus 5.5 `4 / 5 / 8 / 0.20 / 20`; Sonnet 5.5 `2 / 2.50 / 4 / 0.10 / 10`; Sonnet 5 `2 / 2.50 / 4 / 0.20 / 10`; Haiku 5.5 `0.10 / 0.125 / 0.20 / 0.01 / 0.50` for prompts up to 100,000 tokens, then `0.50 / 0.625 / 1 / 0.05 / 2.50` above it. The 1-hour write is 2x base input, the 5-minute write 1.25x.

- **models.dev source (TOML): correct and complete.** `providers/anthropic/models/claude-sonnet-5.toml` has `[cost.text.input] price = 2` with `cache = { read = 0.2, write = { "5m" = 2.5, "1h" = 4 } }` and `[cost.text.output] price = 10` — an exact match to Anthropic's table, including the 1h rate. The Anthropic directory also contains `claude-fable-5`, `claude-fable-5-1`, `claude-haiku-5-5`, `claude-opus-5*` and `claude-sonnet-5*` files.
- **models.dev API (`api.json`): loses the 1h rate.** The v1 cost schema is `.strict()` with exactly `input`, `output`, `reasoning`, `cache_read`, `cache_write`, `input_audio`, `output_audio` (plus context `tiers`). The generator comments that "v1 can't carry … cache TTLs, service tiers", so `api.json` emits one `cache_write` (the 5m price). Any tracker that needs `cache_write_1h` cannot get it from `api.json`.
- **OpenRouter: correct, including 1h.** The Sonnet 5 endpoint record shows `input_cache_write":"0.0000025"`, `input_cache_write_1h":"0.000004"`, `input_cache_read":"0.0000002"`, `prompt":"0.000002"`, `completion":"0.00001"` — i.e. $2.50 / $4 / $0.20 / $2 / $10 per MTok. The SDK schema documents `inputCacheWrite1h` as "only present for providers that price an extended (1-hour) cache TTL separately, such as Anthropic".
- **LiteLLM: correct by construction.** `cache_creation_input_token_cost` is the write rate and `cache_creation_input_token_cost_above_1hr` is documented as "the 1-hour prompt cache write rate (Anthropic)", alongside `cache_read_input_token_cost`.

## OpenAI, DeepSeek, Google

Coverage is not the differentiator — all three carry the four labs. The difference is shape and fidelity:

- **LiteLLM**: 102 OpenAI models, 17 Anthropic models, 71 Google AI Studio models, and DeepSeek V4.1 Flash rows in the same map (per its public browser as of 2026-10-30). It also carries `cache_creation_input_token_cost_above_12hr` for "OpenAI GPT-5.6 and newer on /responses", which no other catalog here models.
- **OpenRouter**: verified samples include `openai/gpt-6.1-terra-pro`, `anthropic/claude-sonnet-5` and `deepseek/deepseek-v4.1-flash`. Its DeepSeek record makes the router problem concrete: the same model is priced at `completion: 0.00000104` by OpenInference and `0.000000383` by Morph, with different `prompt` and cache-read values per endpoint. Those are serving prices, not DeepSeek's list.
- **models.dev**: has per-lab provider directories (`providers/anthropic`, `providers/openai`, `providers/deepseek`, `providers/google`) and also gateway providers (OpenRouter, Vercel, 302.ai, …), so the same model appears many times with different prices. Pick by provider ID, not by model name.

## Field fidelity

| Field | models.dev `api.json` | OpenRouter | LiteLLM |
|---|---|---|---|
| input / output | yes | yes | yes |
| cache read | yes | `input_cache_read` | `cache_read_input_token_cost` |
| cache write 5m | yes (`cache_write`) | `input_cache_write` | `cache_creation_input_token_cost` |
| cache write 1h | **no** (TOML only) | `input_cache_write_1h` | `cache_creation_input_token_cost_above_1hr` |
| cache write 12h | no | no | `..._above_12hr` |
| batch | no | no | `input_cost_per_token_batches`, `output_cost_per_token_batches`, `cache_creation_input_token_cost_batches` |
| long-context tiers | `cost.tiers[]` on context size | `pricing.overrides[]` with `min_prompt_tokens` | `_above_200k_tokens`, `_above_272k_tokens` |
| service tiers (priority/flex) | v2 TOML conditions only | no | `_priority`, `_flex` |
| time-of-day / date conditions | v2 TOML (`utc_hours`, `utc_days`, `holiday`, `date`) | `utc_start`/`utc_end` override windows | no |

Two consequences for you:

1. **Haiku 5.5's 100k threshold** is the kind of tier that a fixed-threshold scheme may miss; LiteLLM documents 200k and 272k suffixes, so confirm a 100k-tier key exists for that SKU before trusting it, or fall back to OpenRouter's `overrides`/models.dev `tiers` for that model.
2. **DeepSeek off-peak pricing** (if it is in force) is only expressible as a time condition. models.dev v2 and OpenRouter have a vocabulary for it; LiteLLM does not. Verify per SKU rather than assuming.

## Update latency

- **LiteLLM** is effectively continuous: four commits touching the cost map landed on 2026-10-30 alone (02:46, 03:08, 03:30, 04:04 UTC), including "add batch prices" fixes and a regional service-tier backfill. Bot-assisted PRs mean same-day or next-day coverage is normal.
- **OpenRouter** lists at launch speed because listing is its product: the Claude Sonnet 5 record carries `created: 1782843083` (2026-06-30, ~18:11 UTC), one day after the model's 2026-06-29 release date recorded by models.dev.
- **models.dev** is community PR-driven. Its Anthropic directory's most recent commit is 2026-10-26; the Sonnet 5 file's `last_updated` is 2026-06-30, but that is a data field, not proof of ingest time. Treat its latency as unmeasured.

## Historical / effective dates

None of the feeds carries a price-version table with `valid_from`/`valid_to`:

- models.dev has `release_date` / `last_updated` for the model, and its v2 TOML can attach a `date` condition to a price, but `api.json` drops it.
- OpenRouter has per-model `created` and time-window `overrides`; no price history.
- LiteLLM has neither dates nor versions in the JSON.

So the tracker must own effective dating: fetch once a day, write the snapshot with `valid_from = fetch date`, keep prior snapshots, and reconcile via git history. models.dev is the easiest to audit after the fact (per-model TOML diffs read cleanly); LiteLLM's JSON diffs are larger but keys are stable and greppable.

## Stability

- **models.dev**: one static document on a CDN, no auth, no SLA, community-run. The git repo is the real source of truth if the site is down.
- **OpenRouter**: live production API, but pricing detail needs one call per model/endpoint; aggregate `pricing` on the list endpoint can hide per-endpoint differences.
- **LiteLLM**: raw GitHub is rate-limited for unauthenticated clients, but the same JSON ships inside the `litellm` package, so a pinned local copy always exists; the proxy itself fetches the map from GitHub at startup.

## Recommendation

**Primary — LiteLLM.** Sync daily from the raw GitHub URL (pin by commit SHA for reproducibility), keep the previous snapshot, and validate that every `(provider, model)` key your agw routes use is present. LiteLLM prices missing models at $0 and only emits a metric warning, so a vanished key silently under-bills. Store per-token rates as fetched and normalise to per-MTok at the boundary. Its provider-keyed rows (`anthropic/…`, `openai/…`, `deepseek/…`, `gemini/…`) are list prices; ignore the gateway rows (`openrouter/…`, `vercel_ai_gateway/…`) for agw costing.

**Fallback — OpenRouter.** On a LiteLLM outage or a missing SKU, fetch `/api/v1/models/{author}/{slug}/endpoints`, prefer the endpoint whose provider matches the actual upstream, and read `input_cache_write_1h`, `input_cache_read`, `input_cache_write`, and `pricing.overrides` for long context. Accept that this is routed pricing: for DeepSeek the spread between endpoints is large, so a fallback-derived cost is an estimate, not a list-price equivalent. There is also no batch rate and no published data licence.

**models.dev — third source only.** Use `api.json` to sanity-check list prices across providers and to catch a LiteLLM row that looks stale. If you need its 1h cache-write price, parse `providers/anthropic/models/*.toml` from the repo (v2 schema), not the API.

**Known gap.** With LiteLLM as primary, the only material fidelity gaps are time-of-day discounts (DeepSeek-style) and 100k-class context thresholds; both should be a small, explicit exception list fed by a manual override in your U3 chain, not a reason to switch catalogs.

## Unverified
- OpenRouter data licence: no licence file or explicit data-reuse terms were found; the catalogue is served under OpenRouter's general API terms: No licence statement is attached to the API or its documentation pages I read; usage terms would need review of OpenRouter's Terms of Service, which was not fetched.
- Whether LiteLLM carries a 100k-token long-context tier (needed for Claude Haiku 5.5): The docs name 200k and 272k threshold suffixes only; whether a _above_100k_tokens key exists for that SKU was not confirmed.
- Whether DeepSeek off-peak/time-of-day pricing is currently encoded in any of the three feeds: models.dev and OpenRouter have a vocabulary for time conditions, but no DeepSeek SKU was checked for an actual off-peak override.
- models.dev ingestion latency for new launches: Commit dates show activity but not launch-to-ingest delay; release_date/last_updated are data fields, not proof of when the PR landed.
- OpenRouter catalogue rate limits and availability SLA: No SLA or catalogue-specific rate-limit statement was read; only general API docs were consulted.

## Citations
- [high] models.dev serves its catalogue at https://models.dev/api.json, costs are USD per million tokens, and data is authored as TOML with a v2 schema — https://raw.githubusercontent.com/anomalyco/models.dev/dev/README.md
- [high] models.dev api.json returns a flat cost object with input/output/cache_read/cache_write and releases dated 2026, confirming the API output shape — https://models.dev/api.json
- [high] models.dev's v1 (API) cost schema is strict and contains only input, output, reasoning, cache_read, cache_write, input_audio, output_audio plus context tiers — no 1h field — https://raw.githubusercontent.com/anomalyco/models.dev/dev/packages/core/src/schema.ts
- [high] models.dev states v1 cannot carry cache TTLs or service tiers, so the API drops the 1h write price present in TOML — https://raw.githubusercontent.com/anomalyco/models.dev/dev/packages/core/src/generate-v2.ts
- [high] models.dev Claude Sonnet 5 TOML: input $2, output $10, cache read $0.20, 5m write $2.50, 1h write $4 per MTok — https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers/anthropic/models/claude-sonnet-5.toml
- [high] models.dev v2 cost schema supports cache write as a per-duration map, service tiers, and date/utc_hours conditions — https://raw.githubusercontent.com/anomalyco/models.dev/dev/packages/core/src/schema-v2.ts
- [high] models.dev is MIT licensed — https://api.github.com/repos/anomalyco/models.dev/license
- [high] The models.dev Anthropic provider directory contains claude-fable-5, claude-fable-5-1, claude-haiku-5-5 and claude-opus-4-5-20251101 model files — https://api.github.com/repos/sst/models.dev/contents/providers/anthropic/models
- [high] Anthropic list prices per MTok: Fable 5.1 10/12.5/20/0.25/50; Opus 5.5 4/5/8/0.20/20; Sonnet 5.5 2/2.5/4/0.10/10; Sonnet 5 2/2.5/4/0.20/10; Haiku 5.5 0.10/0.125/0.20/0.01/0.50 up to 100k and 0.50/0.625/1/0.05/2.50 above — https://platform.claude.com/docs/en/about-claude/pricing.md
- [high] 1-hour cache writes cost 2x base input while 5-minute writes cost 1.25x — https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence
- [high] OpenRouter's model list endpoint returns pricing per token as decimal strings — https://openrouter.ai/api/v1/models
- [high] OpenRouter's Claude Sonnet 5 endpoint record includes input_cache_write_1h 0.000004, input_cache_write 0.0000025, input_cache_read 0.0000002, prompt 0.000002, completion 0.00001 — https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5/endpoints
- [high] OpenRouter documents inputCacheWrite1h as the 1-hour cache-write rate only present for providers such as Anthropic, and overrides as conditional long-context/time pricing — https://openrouter.ai/docs/client-sdks/typescript/models/publicpricing
- [high] OpenRouter prices the same DeepSeek V4.1 Flash model differently per serving endpoint (completion 0.00000104 at OpenInference vs 0.000000383 at Morph) — https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints
- [high] LiteLLM prices everything from model_prices_and_context_window.json in USD per token, and documents _batches, _priority, _flex, _above_200k_tokens, _above_272k_tokens, cache_creation_input_token_cost_above_1hr and _above_12hr — https://docs.litellm.ai/docs/proxy/model_cost_map
- [high] LiteLLM's cost map is MIT licensed outside the enterprise directory — https://api.github.com/repos/BerriAI/litellm/license
- [high] LiteLLM's cost map received four commits on 2026-10-30 (02:46, 03:08, 03:30, 04:04 UTC), including batch-price and regional service-tier fixes — https://github.com/BerriAI/litellm/commits/main/model_prices_and_context_window.json.atom
- [high] LiteLLM's public model browser lists 1,476 models across 109 providers as of October 30, 2026, including 102 OpenAI, 17 Anthropic and 71 Google AI Studio models — https://models.litellm.ai/
- [medium] models.dev's Anthropic directory last changed on 2026-10-26 — https://api.github.com/repos/anomalyco/models.dev/commits?path=providers/anthropic/models&per_page=5
- [high] models.dev has per-provider directories for deepseek and google — https://api.github.com/repos/anomalyco/models.dev/contents/providers/deepseek/models
