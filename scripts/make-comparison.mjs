#!/usr/bin/env node
// Launch-day comparison: run two models on the same fixed set, N times each, and write comparisons/<slug>.json.
// usage: node scripts/make-comparison.mjs <slug> <modelA-id> <modelB-id> [--runs 3]
// It calls a drift Worker built from worker/ (same harness code as the daily tracker): set RUN_URL to its URL and RUN_TOKEN to
// its RUN_TOKEN secret. For a quick one-off without a Worker, use cli/run.mjs with your own Workers AI or OpenAI-compatible credentials.
import { writeFileSync, mkdirSync } from "node:fs";
const a = process.argv.slice(2);
const i = a.indexOf("--runs"); const runs = i >= 0 ? Number(a.splice(i, 2)[1]) : 3;
const [slug, A, B] = a;
if (!slug || !A || !B) { console.error("usage: make-comparison.mjs <slug> <modelA> <modelB> [--runs 3]"); process.exit(2); }
const base = process.env.RUN_URL, token = process.env.RUN_TOKEN;
if (!base || !token) { console.error("set RUN_URL and RUN_TOKEN (your drift Worker)"); process.exit(2); }
const out = { slug, models: [A, B], runs, started: new Date().toISOString(), results: {} };
for (const m of [A, B]) {
  out.results[m] = [];
  for (let k = 1; k <= runs; k++) {
    const res = await fetch(`${base}/run?model=${encodeURIComponent(m)}&any=1`, { method: "POST", headers: { Authorization: "Bearer " + token } });
    if (!res.ok) throw new Error(`${m} run ${k}: HTTP ${res.status}`);
    const r = await res.json();
    if (k > 1) r.outputs = undefined;               // keep the sample outputs of run 1 only
    out.results[m].push(r);
    console.log(m, "run", k, `${r.passed}/${r.n}`, "errors", r.errors, "truncated", r.truncated, "neurons", r.neurons);
  }
}
out.finished = new Date().toISOString();
mkdirSync(new URL("../comparisons/", import.meta.url), { recursive: true });
writeFileSync(new URL(`../comparisons/${slug}.json`, import.meta.url), JSON.stringify(out, null, 1));
