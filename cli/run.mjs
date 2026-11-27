#!/usr/bin/env node
// Run the drift set against Workers AI (CF_ACCOUNT_ID + CF_API_TOKEN) or any OpenAI-compatible endpoint
// (OPENAI_BASE_URL + OPENAI_API_KEY). Usage: node cli/run.mjs <model> [<model> ...] [--runs N] [--out file.json]
import { readFileSync, writeFileSync } from "node:fs";
import { runModel, setSha } from "../src/core.mjs";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const runs = Number(flag("--runs", 1)), outFile = flag("--out", null), tasksFile = flag("--tasks", new URL("../tasks/v1.0.0.json", import.meta.url).pathname);
const models = args;
if (!models.length) { console.error("usage: node cli/run.mjs <model> [<model>...] [--runs N] [--out file]"); process.exit(2); }
const set = JSON.parse(readFileSync(tasksFile, "utf8"));
const sha = await setSha(set);

async function runChat(model, messages, dec) {
  const base = process.env.OPENAI_BASE_URL;
  const url = base ? base.replace(/\/$/, "") + "/chat/completions"
    : `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${model}`;
  const key = base ? process.env.OPENAI_API_KEY : process.env.CF_API_TOKEN;
  const res = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ model: base ? model : undefined, messages, temperature: dec.temperature, max_tokens: dec.max_tokens }) });
  const j = await res.json().catch(() => ({}));
  if (res.status === 429 || /quota|limit|neurons/i.test(JSON.stringify(j.errors || j.error || ""))) { const e = new Error("quota"); e.quota = true; throw e; }
  if (!res.ok) throw new Error("HTTP " + res.status);
  const r = j.result || j;
  const ch = r.choices && r.choices[0];
  return { content: ch && ch.message ? ch.message.content : r.response, served_model: r.model, finish_reason: ch && ch.finish_reason,
    neurons: r.usage && r.usage.neurons };
}

const results = [];
for (const m of models) for (let k = 1; k <= runs; k++) {
  const r = await runModel(runChat, m, set);
  results.push({ run: k, ...r, ts: new Date().toISOString() });
  console.log(`${m} run ${k}: ${r.passed}/${r.n} (errors ${r.errors}) ${JSON.stringify(r.by_cat)}`);
}
if (outFile) writeFileSync(outFile, JSON.stringify({ set: { id: set.id, version: set.version, sha256: sha }, results }, null, 1));
