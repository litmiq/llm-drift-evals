// Litmiq LLM drift evals: deterministic grader + runner. No dependencies. No LLM judge.
// Same file runs in Node (cli/run.mjs) and in a Cloudflare Worker (worker/worker.js is built from it).
const GRADER_VERSION = "1.0.0";

const UNI = /[\u00a0\u2009\u202f]/g;

function clean(out) {
  let s = typeof out === "string" ? out : out == null ? "" : JSON.stringify(out);
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(UNI, " ");
  return s;
}

function normMatch(s) {
  let t = clean(s).trim();
  t = t.replace(/^[`"'*_\s]+|[`"'*_\s]+$/g, "");
  t = t.replace(/\.$/, "");
  return t.replace(/\s*;\s*/g, "; ").replace(/\s+/g, " ").toLowerCase();
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

const lines = (s) => s.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const words = (s) => s.trim().split(/\s+/).filter(Boolean);

function check(c, raw) {
  const o = clean(raw), t = o.trim(), [k, v] = c;
  switch (k) {
    case "lines": return lines(o).length === v;
    case "eachStartsWith": return lines(o).length > 0 && lines(o).every((l) => l.startsWith(v));
    case "lowercase": return t.length > 0 && t === t.toLowerCase();
    case "uppercase": return t.length > 0 && t === t.toUpperCase();
    case "minWords": return words(o).length >= v;
    case "maxWords": return words(o).length <= v;
    case "words": return words(o).length === v;
    case "equals": return t === v;
    case "equalsLines": return deepEqual(lines(o), v);
    case "csvSorted": {
      if (lines(o).length !== 1) return false;
      const p = t.split(",").map((x) => x.trim().toLowerCase());
      return p.length === v && p.every(Boolean) && new Set(p).size === p.length && deepEqual(p, [...p].sort());
    }
    case "startsWith": return t.startsWith(v);
    case "endsWith": return t.endsWith(v);
    case "contains": return t.includes(v);
    case "notContains": return !t.toLowerCase().includes(String(v).toLowerCase());
    case "sentences": return t.split(/(?<=[.!?])\s+/).filter((x) => x.trim()).length === v;
    default: throw new Error("unknown check " + k);
  }
}

// grade(task, output) -> { pass: boolean, why: string }
function grade(task, output) {
  const g = task.grader;
  if (g.type === "json") {
    let obj;
    try { obj = JSON.parse(clean(output).trim()); } catch { return { pass: false, why: "not strict JSON" }; }
    return deepEqual(obj, g.expect) ? { pass: true, why: "ok" } : { pass: false, why: "wrong values" };
  }
  if (g.type === "match") {
    const n = normMatch(output);
    return g.expect.some((e) => normMatch(e) === n) ? { pass: true, why: "ok" } : { pass: false, why: "no match" };
  }
  if (g.type === "constraints") {
    for (const c of g.checks) if (!check(c, output)) return { pass: false, why: "failed " + c[0] };
    return { pass: true, why: "ok" };
  }
  throw new Error("unknown grader " + g.type);
}

function messages(task) {
  const m = [];
  if (task.system) m.push({ role: "system", content: task.system });
  m.push({ role: "user", content: task.prompt });
  return m;
}

function contentOf(resp) {
  const r = resp && resp.result ? resp.result : resp;
  const c = r && r.choices && r.choices[0] && r.choices[0].message ? r.choices[0].message.content : undefined;
  if (c != null) return c;
  if (r && r.response != null) return r.response;
  return "";
}

async function sha256Hex(text) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// The task-set fingerprint: sha256 of the minified JSON of the tasks file.
const setSha = (set) => sha256Hex(JSON.stringify(set));

// runChat(model, messages, {temperature, max_tokens}) -> { content, served_model, neurons, finish_reason }
// throws an Error with .quota = true when the provider says the free allowance is used up.
async function runModel(runChat, model, set, opts = {}) {
  const conc = opts.concurrency || 4, cats = set.categories;
  const bits = new Array(set.tasks.length).fill("e");
  const out = new Array(set.tasks.length).fill(null);
  const state = { next: 0, stop: false, neurons: 0, served: null, truncated: 0, errors: [] };
  async function one(i) {
    const task = set.tasks[i];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await runChat(model, messages(task), set.decoding);
        state.neurons += r.neurons || 0;
        if (r.served_model) state.served = state.served || r.served_model;
        if (r.finish_reason === "length") state.truncated++;
        const g = grade(task, r.content);
        bits[i] = g.pass ? "1" : "0";
        out[i] = { id: task.id, pass: g.pass, why: g.why, output: String(clean(r.content)).slice(0, 400) };
        return;
      } catch (e) {
        if (e && e.quota) { state.stop = true; state.errors.push("quota"); return; }
        if (attempt === 1) state.errors.push(String(e && e.message || e).slice(0, 120));
      }
    }
  }
  async function worker() {
    while (!state.stop) { const i = state.next++; if (i >= set.tasks.length) return; await one(i); }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  const by_cat = {};
  for (const c of cats) by_cat[c] = [0, 0];
  set.tasks.forEach((t, i) => { if (bits[i] !== "e") { by_cat[t.category][1]++; if (bits[i] === "1") by_cat[t.category][0]++; } });
  const n = bits.filter((b) => b !== "e").length;
  const passed = bits.filter((b) => b === "1").length;
  return { model, served_model: state.served, bits: bits.join(""), n, passed, errors: set.tasks.length - n,
    by_cat, neurons: Math.round(state.neurons * 100) / 100, truncated: state.truncated, error_samples: state.errors.slice(0, 3), outputs: out };
}

// Litmiq drift tracker: Cloudflare Worker (Free plan). Cron every 10 minutes; each tick runs ONE model that has no
// valid result for today (UTC) yet, then stores the score in D1. Needs bindings: AI (Workers AI), EVENTS_DB (D1), RUN_TOKEN (secret).
// The set, its fingerprint and the model list are inlined by scripts/build-worker.mjs
const SET = {"id":"litmiq-drift-evals","version":"1.0.0","released":"2026-11-27","grader_version":"1.0.0","decoding":{"temperature":0,"max_tokens":1024},"categories":["json","extraction","classification","instruction"],"tasks":[{"id":"json-01","category":"json","prompt":"Return a JSON object with the keys name (string) and age (integer) for this sentence: Maria is 34 years old. Output only the JSON, with no code fences and no other text.","grader":{"type":"json","expect":{"name":"Maria","age":34}}},{"id":"json-02","category":"json","prompt":"Return a JSON array containing the first five prime numbers as integers. Output only the JSON, with no code fences and no other text.","grader":{"type":"json","expect":[2,3,5,7,11]}},{"id":"json-03","category":"json","prompt":"Return a JSON object with the key \"fruits\" (array of strings, in the order mentioned, lowercase) and the key \"count\" (integer) for: I bought an apple and a banana. Output only the JSON, with no code fences and no other text.","grader":{"type":"json","expect":{"fruits":["apple","banana"],"count":2}}},{"id":"json-04","category":"json","prompt":"Convert this order to JSON: \"Order #1182: 2 x pen at 1.50 each, 1 x notebook at 4.00\". Use the shape {\"order_id\": integer, \"items\": [{\"name\": string, \"qty\": integer, \"price\": number}]}. Output only the JSON, with no code fences and no other text.","grader":{"type":"json","expect":{"order_id":1182,"items":[{"name":"pen","qty":2,"price":1.5},{"name":"notebook","qty":1,"price":4}]}}},{"id":"json-05","category":"json","prompt":"Return a JSON object with three keys: active set to the boolean true, nickname set to null, and score set to the integer 0. Output only the JSON, with no code fences and no other text.","grader":{"type":"json","expect":{"active":true,"nickname":null,"score":0}}},{"id":"json-06","category":"json","prompt":"Return a JSON object with one key, \"quote\", whose string value is He said \"hi\" - copied exactly, with its two quotation marks and nothing else added. Output only the JSON, with no code fences and no other text.","grader":{"type":"json","expect":{"quote":"He said \"hi\""}}},{"id":"json-07","category":"json","prompt":"Return a JSON object with exactly the keys a, b and c, whose values are the integers 1, 2 and 3 respectively. Output only the JSON, with no code fences and no other text.","grader":{"type":"json","expect":{"a":1,"b":2,"c":3}}},{"id":"json-08","category":"json","prompt":"Convert this CSV to a JSON array of objects, using the header names as keys and integers for numeric values:\nid,name,qty\n7,widget,12\nOutput only the JSON, with no code fences and no other text.","grader":{"type":"json","expect":[{"id":7,"name":"widget","qty":12}]}},{"id":"json-09","category":"json","prompt":"Convert the date \"March 5, 2024\" to a JSON object with integer keys year, month and day. Output only the JSON, with no code fences and no other text.","grader":{"type":"json","expect":{"year":2024,"month":3,"day":5}}},{"id":"json-10","category":"json","prompt":"Return a JSON object with one key, \"overdue\", whose value is an array of overdue invoice ids found in this text: \"All invoices are paid.\" Output only the JSON, with no code fences and no other text.","grader":{"type":"json","expect":{"overdue":[]}}},{"id":"extract-01","category":"extraction","prompt":"Extract the email address from: Contact us at support@acme-labs.io for help. Reply with the value only.","grader":{"type":"match","expect":["support@acme-labs.io"]}},{"id":"extract-02","category":"extraction","prompt":"Extract the invoice total as a plain number with no currency symbol and no thousands separator, from: Invoice total: $1,249.50 due 2025-03-01. Reply with the number only.","grader":{"type":"match","expect":["1249.50","1249.5"]}},{"id":"extract-03","category":"extraction","prompt":"The meeting moved from 4 June to 11 June 2025. Give the new meeting date in ISO format YYYY-MM-DD. Reply with the date only.","grader":{"type":"match","expect":["2025-06-11"]}},{"id":"extract-04","category":"extraction","prompt":"Extract the two people's full names without titles, in order of appearance, separated by a semicolon and a space, from: Dr. Elena Park met Prof. Tom Reyes in Lisbon. Reply with the names only.","grader":{"type":"match","expect":["elena park; tom reyes"]}},{"id":"extract-05","category":"extraction","prompt":"Extract the mobile phone number from: Call 415-555-0134 (office) or 415-555-0199 (mobile). Reply with the value only.","grader":{"type":"match","expect":["415-555-0199"]}},{"id":"extract-06","category":"extraction","prompt":"How many of these log lines have the level ERROR? Reply with the number only.\nINFO ok\nERROR disk full\nINFO ok\nERROR timeout\nWARN slow","grader":{"type":"match","expect":["2"]}},{"id":"extract-07","category":"extraction","prompt":"Extract the full host name, including any subdomain but without the scheme or path, from: Visit https://docs.example.org/guide/start?x=1 now. Reply with the value only.","grader":{"type":"match","expect":["docs.example.org"]}},{"id":"extract-08","category":"extraction","prompt":"Extract the three-letter currency code from: Price: 45 EUR per month. Reply with the value only.","grader":{"type":"match","expect":["eur"]}},{"id":"extract-09","category":"extraction","prompt":"Extract the author's last name from: Written by Priya Natarajan on 3 May 2023. Reply with the value only.","grader":{"type":"match","expect":["natarajan"]}},{"id":"extract-10","category":"extraction","prompt":"Extract the tracking code (not the order id) from: Your order ZX-90417 shipped; tracking TRK-5521. Reply with the value only.","grader":{"type":"match","expect":["trk-5521"]}},{"id":"classify-01","category":"classification","prompt":"Classify the sentiment of: \"The battery died after two days and support never answered.\"\nLabels: positive, negative, neutral. Reply with exactly one label, lowercase, and nothing else.","grader":{"type":"match","expect":["negative"]}},{"id":"classify-02","category":"classification","prompt":"Classify the sentiment of: \"Absolutely love the new update, everything feels faster!\"\nLabels: positive, negative, neutral. Reply with exactly one label, lowercase, and nothing else.","grader":{"type":"match","expect":["positive"]}},{"id":"classify-03","category":"classification","prompt":"Classify the sentiment of: \"The package arrived on Tuesday.\"\nLabels: positive, negative, neutral. Reply with exactly one label, lowercase, and nothing else.","grader":{"type":"match","expect":["neutral"]}},{"id":"classify-04","category":"classification","prompt":"Classify the intent of this customer message: \"I want my money back for order 5521.\"\nLabels: refund, shipping, login, other. Reply with exactly one label, lowercase, and nothing else.","grader":{"type":"match","expect":["refund"]}},{"id":"classify-05","category":"classification","prompt":"Classify the intent of this customer message: \"I can't sign in, it says wrong password.\"\nLabels: refund, shipping, login, other. Reply with exactly one label, lowercase, and nothing else.","grader":{"type":"match","expect":["login"]}},{"id":"classify-06","category":"classification","prompt":"Classify the topic of: \"The Lakers beat the Celtics 112-104 last night.\"\nLabels: sports, politics, technology, finance. Reply with exactly one label, lowercase, and nothing else.","grader":{"type":"match","expect":["sports"]}},{"id":"classify-07","category":"classification","prompt":"Classify the topic of: \"The central bank raised interest rates by 25 basis points.\"\nLabels: sports, politics, technology, finance. Reply with exactly one label, lowercase, and nothing else.","grader":{"type":"match","expect":["finance"]}},{"id":"classify-08","category":"classification","prompt":"Classify the topic of: \"A new open-source compiler release cuts build times in half.\"\nLabels: sports, politics, technology, finance. Reply with exactly one label, lowercase, and nothing else.","grader":{"type":"match","expect":["technology"]}},{"id":"classify-09","category":"classification","prompt":"Is this message spam? \"WINNER!! Claim your free prize now at bit.ly/xyz\"\nLabels: spam, not_spam. Reply with exactly one label, lowercase, and nothing else.","grader":{"type":"match","expect":["spam"]}},{"id":"classify-10","category":"classification","prompt":"Is this message spam? \"Hi Sam, are we still on for lunch at noon tomorrow?\"\nLabels: spam, not_spam. Reply with exactly one label, lowercase, and nothing else.","grader":{"type":"match","expect":["not_spam"]}},{"id":"follow-01","category":"instruction","prompt":"Write exactly three bullet points about coffee. Start every line with '- '. Output nothing except the three lines.","grader":{"type":"constraints","checks":[["lines",3],["eachStartsWith","- "]]}},{"id":"follow-02","category":"instruction","prompt":"Write one sentence about rain, entirely in lowercase letters, with no capital letters at all.","grader":{"type":"constraints","checks":[["lowercase"],["minWords",3]]}},{"id":"follow-03","category":"instruction","prompt":"Write one sentence about the moon that contains exactly 8 words. Output only the sentence.","grader":{"type":"constraints","checks":[["words",8]]}},{"id":"follow-04","category":"instruction","prompt":"Reply with the word yes repeated exactly 4 times, separated by single spaces, and nothing else.","grader":{"type":"constraints","checks":[["equals","yes yes yes yes"]]}},{"id":"follow-05","category":"instruction","prompt":"List exactly three different colors on one line, separated by commas, in alphabetical order. Output nothing else.","grader":{"type":"constraints","checks":[["lines",1],["csvSorted",3]]}},{"id":"follow-06","category":"instruction","prompt":"Write exactly two sentences describing a bicycle. The first sentence must start with the words 'A bicycle'. Do not use the letter z anywhere.","grader":{"type":"constraints","checks":[["startsWith","A bicycle"],["sentences",2],["notContains","z"]]}},{"id":"follow-07","category":"instruction","prompt":"Answer in at most 12 words: why is the sky blue?","grader":{"type":"constraints","checks":[["maxWords",12],["minWords",3]]}},{"id":"follow-08","category":"instruction","prompt":"Write the numbers 1 to 5, each on its own line, and nothing else.","grader":{"type":"constraints","checks":[["equalsLines",["1","2","3","4","5"]]]}},{"id":"follow-09","category":"instruction","prompt":"Write a three-line poem about snow. Output exactly three lines, no title, no blank lines.","grader":{"type":"constraints","checks":[["lines",3]]}},{"id":"follow-10","category":"instruction","prompt":"Say hello to Dana. Use uppercase letters only, and end the reply with an exclamation mark.","grader":{"type":"constraints","checks":[["uppercase"],["endsWith","!"],["contains","DANA"]]}}]};
const SET_SHA = "f2ee123cfd10ce6138f49b2d1b4cfd75dcbc9b76804bd7f4ee4d7188e4eab5cc";
const MODELS = ["@cf/google/gemma-4-26b-a4b-it","@cf/openai/gpt-oss-20b","@cf/meta/llama-4-scout-17b-16e-instruct","@cf/meta/llama-3.3-70b-instruct-fp8-fast","@cf/meta/llama-3.1-8b-instruct-fp8-fast","@cf/mistralai/mistral-small-3.1-24b-instruct"];

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
