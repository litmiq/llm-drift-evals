# llm-drift-evals

A small, fixed, versioned eval set for checking whether a hosted LLM got worse, plus the deterministic grader, a command-line
runner and the Cloudflare Worker that runs it every day.

- **Live tracker:** https://litmiq.com/model-drift (chart, method, JSON and CSV)
- **Head-to-head comparisons:** https://litmiq.com/evals
- **Set:** `litmiq-drift-evals` v1.0.0: 40 tasks, 10 each in `json`, `extraction`, `classification`, `instruction`
- **Licence:** code MIT, task set and data CC BY 4.0 (see `LICENSE`, `LICENSE-DATA.md`)

Independent measurement. Not affiliated with OpenAI, Google, Meta, Mistral AI or Cloudflare; model names identify the models
measured and nothing else.

## How a task is scored

By code, never by an AI judge (`src/core.mjs`):

| Category | Check |
| --- | --- |
| json | Output must be strict JSON (`JSON.parse` of the trimmed text, so code fences or prose fail) and deep-equal the expected value |
| extraction, classification | Normalised exact match (trim, strip quotes and one trailing full stop, lowercase) against the accepted answers |
| instruction | Programmatic constraints: line, word and sentence counts, case, prefixes and suffixes, banned letters, sorting |

`<think>…</think>` blocks are removed; Unicode thin and no-break spaces are normalised. A task without a final answer inside
the token budget counts as failed and is reported as truncated. `npm test` (`node --test test/*.test.mjs`) checks that every task's gold
answer passes, every bad answer fails, and empty output fails.

## Run it

```bash
# Workers AI
export CF_ACCOUNT_ID=... CF_API_TOKEN=...
node cli/run.mjs @cf/meta/llama-3.1-8b-instruct-fp8-fast --runs 3 --out results.json

# any OpenAI-compatible endpoint
OPENAI_BASE_URL=https://api.example.com/v1 OPENAI_API_KEY=... node cli/run.mjs your-model
```

Decoding is fixed in the task file: temperature 0, `max_tokens` 1024. The task-set fingerprint is the SHA-256 of the minified
JSON of `tasks/v1.0.0.json` (printed in `results.json`).

## Daily tracker (Cloudflare Free plan)

`worker/worker.src.mjs` + `src/core.mjs` are bundled by `node scripts/build-worker.mjs` into one Worker file. A cron trigger
(every 10 minutes) runs one model per tick that has no valid result for the current UTC day and stores the pass count, per
category counts, the per-task pass/fail bit string and the served model id in D1. A run with more than 20% errored calls is not
published. Models are listed in `worker/models.json`.

`scripts/make-comparison.mjs <slug> <modelA> <modelB>` runs two models 3 times each and writes `comparisons/<slug>.json`,
which the litmiq.com build turns into an `/evals/<slug>` page.

`data/` holds raw per-model results with sample outputs (first day: 2026-11-27). The running daily series is at
https://litmiq.com/model-drift/data.json and https://litmiq.com/model-drift/data.csv.

## Reading a change

One task is 2.5 points. Hosted models are not perfectly repeatable even at temperature 0, so treat single-day moves under
5 points as noise unless they repeat or the served model id changes. This set is small and mostly easy: it finds regressions in
basic behaviour, it does not rank models.

## Citation

Litmiq (2026). Model drift tracker, task set v1.0.0. https://litmiq.com/model-drift. CC BY 4.0.
