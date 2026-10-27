# Promtic prompts

The live prompts are managed in Promtic (`papi.cyber.pish.run`). The backend
never chooses a model — each prompt's **current version** does. To change a
prompt or its model, publish a new version and make it current:

```
POST /prompts/:id/versions        { version, messages, model_name, params }
PUT  /prompts/:id                 { name, description, tags, status, output_type, current_version_id }
```

(`PATCH` is not supported; send all prompt fields with `PUT` so nothing is cleared.)
Rolling back = `PUT` the previous version id as `current_version_id`.

## Current models (2026-10-27)

| Prompt | Current version (id) | Model | Previous (rollback id) | Why |
|---|---|---|---|---|
| `batch_sentiment` | v1.2 (636) | google/gemini-2.5-flash-lite | v1.1 (634) | Cheapest model that kept quality in an A/B on a real 19-post batch. Haiku 5.5 tokenizes Persian ~2× → ~2× cost; gpt-6-luna +30% and slower; qwen3.7-flash agreed on only 11/19; gpt-5-nano dropped most items. v1.2 redefines the political spectrum (see `batch_sentiment.v1.2.system.md`). |
| `dashboard_ai_summary` | v1.1 (637) | openai/gpt-6-luna | v1.0 (626, gpt-4o-mini) | Same cost as gpt-4o-mini, more specific output, 1M context (gpt-4o-mini hit its 128k limit on large profiles). |
| `smart_recommendations` | v1.1 (638) | openai/gpt-6-luna | v1.0 (628) | Noticeably more concrete recommendations at the same cost. Haiku 5.5 returned an object instead of an array. |
| `narrative_gap_analysis` | v1.1 (639) | openai/gpt-6-luna | v1.0 (629) | As above. |
| `macro_context_analysis` | v1.1 (640) | openai/gpt-6-luna | v1.0 (627) | As above. |
| `macro_politics` | v1.1 (641) | perplexity/sonar | v1.0 (632, sonar-pro-search) | ~77% cheaper per run (twice a day), same JSON shape; picks slightly less prominent events. |
| `scenario_simulator` | v1.0 | openai/gpt-4o-mini | — | Feature hidden in the UI until the next phase (endpoint super_admin-only). |
| `batch_sentiment_ds` | v1.1 | deepseek/deepseek-v4-flash | — | Not used by the code. |

Real spend over the 60 days before the switch was about $0.45 — but 148 of 177
calls failed with `Key limit exceeded (total limit)` on the OpenRouter key
(3 Sep – 25 Oct 2026). Keep an eye on that key's limit: when it is hit, no AI
analysis runs at all.
