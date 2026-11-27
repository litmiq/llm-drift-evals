// Litmiq drift tracker: Cloudflare Worker (Free plan). Cron every 10 minutes; each tick runs ONE model that has no
// valid result for today (UTC) yet, then stores the score in D1. Needs bindings: AI (Workers AI), EVENTS_DB (D1), RUN_TOKEN (secret).
import { runModel } from "../src/core.mjs";
// The set, its fingerprint and the model list are inlined by scripts/build-worker.mjs
const SET = __SET__;
const SET_SHA = __SET_SHA__;
const MODELS = __MODELS__;

const DDL = "CREATE TABLE IF NOT EXISTS drift_runs (day TEXT NOT NULL, model TEXT NOT NULL, set_version TEXT NOT NULL, set_sha TEXT NOT NULL, ts INTEGER NOT NULL, served_model TEXT, n INTEGER NOT NULL, passed INTEGER NOT NULL, errors INTEGER NOT NULL, truncated INTEGER, neurons REAL, by_cat TEXT NOT NULL, bits TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL, PRIMARY KEY (day, model, set_version))";

function chat(env) {
  return async (model, messages, dec) => {
    let r;
    try {
      r = await env.AI.run(model, { messages, temperature: dec.temperature, max_tokens: dec.max_tokens });
    } catch (e) {
      const m = String(e && e.message || e);
      if (/quota|limit|neurons|3036|4006/i.test(m)) { const q = new Error("quota"); q.quota = true; throw q; }
      throw new Error(m.slice(0, 120));
    }
    const ch = r && r.choices && r.choices[0];
    return { content: ch && ch.message ? ch.message.content : (r && r.response), served_model: r && r.model, finish_reason: ch && ch.finish_reason,
      neurons: r && r.usage && r.usage.neurons };
  };
}

async function store(env, day, res, attempt) {
  const status = res.n > 0 && res.errors <= Math.floor(SET.tasks.length * 0.2) ? "ok" : "incomplete";
  await env.EVENTS_DB.prepare("INSERT OR REPLACE INTO drift_runs (day, model, set_version, set_sha, ts, served_model, n, passed, errors, truncated, neurons, by_cat, bits, status, attempt) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)")
    .bind(day, res.model, SET.version, SET_SHA, Date.now(), res.served_model || null, res.n, res.passed, res.errors, res.truncated, res.neurons, JSON.stringify(res.by_cat), res.bits, status, attempt).run();
  return status;
}

async function tick(env) {
  await env.EVENTS_DB.prepare(DDL).run();
  const day = new Date().toISOString().slice(0, 10);
  const { results } = await env.EVENTS_DB.prepare("SELECT model, status, attempt FROM drift_runs WHERE day = ?1 AND set_version = ?2").bind(day, SET.version).all();
  const todo = MODELS.find((m) => { const r = results.find((x) => x.model === m); return !r || (r.status !== "ok" && r.attempt < 3); });
  if (!todo) return;
  const prev = results.find((x) => x.model === todo);
  const res = await runModel(chat(env), todo, SET, { concurrency: 4 });
  await store(env, day, res, (prev ? prev.attempt : 0) + 1);
}

function eq(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(tick(env).catch(() => {})); },
  // Manual run (owner only): POST /run?model=<id>[&store=1]  with  Authorization: Bearer <RUN_TOKEN>
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname !== "/run" || req.method !== "POST") return new Response("litmiq drift tracker. Data: https://litmiq.com/model-drift\n", { status: u.pathname === "/" ? 200 : 404 });
    const tok = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
    if (!env.RUN_TOKEN || !eq(tok, env.RUN_TOKEN)) return new Response("forbidden", { status: 403 });
    const model = u.searchParams.get("model");
    if (!MODELS.includes(model) && u.searchParams.get("any") !== "1") return new Response("unknown model", { status: 400 });
    const res = await runModel(chat(env), model, SET, { concurrency: 4 });
    if (u.searchParams.get("store") === "1") {
      await env.EVENTS_DB.prepare(DDL).run();
      const day = new Date().toISOString().slice(0, 10);
      const p = await env.EVENTS_DB.prepare("SELECT attempt FROM drift_runs WHERE day=?1 AND model=?2 AND set_version=?3").bind(day, model, SET.version).first();
      res.stored = await store(env, day, res, (p ? p.attempt : 0) + 1);
    }
    return Response.json(Object.assign(res, { set_sha: SET_SHA, set_version: SET.version, ts: new Date().toISOString() }));
  },
};
