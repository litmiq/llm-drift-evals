// Litmiq LLM drift evals: deterministic grader + runner. No dependencies. No LLM judge.
// Same file runs in Node (cli/run.mjs) and in a Cloudflare Worker (worker/worker.js is built from it).
export const GRADER_VERSION = "1.0.0";

const UNI = /[\u00a0\u2009\u202f]/g;

export function clean(out) {
  let s = typeof out === "string" ? out : out == null ? "" : JSON.stringify(out);
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(UNI, " ");
  return s;
}

export function normMatch(s) {
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
export function grade(task, output) {
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

export function messages(task) {
  const m = [];
  if (task.system) m.push({ role: "system", content: task.system });
  m.push({ role: "user", content: task.prompt });
  return m;
}

export function contentOf(resp) {
  const r = resp && resp.result ? resp.result : resp;
  const c = r && r.choices && r.choices[0] && r.choices[0].message ? r.choices[0].message.content : undefined;
  if (c != null) return c;
  if (r && r.response != null) return r.response;
  return "";
}

export async function sha256Hex(text) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// The task-set fingerprint: sha256 of the minified JSON of the tasks file.
export const setSha = (set) => sha256Hex(JSON.stringify(set));

// runChat(model, messages, {temperature, max_tokens}) -> { content, served_model, neurons, finish_reason }
// throws an Error with .quota = true when the provider says the free allowance is used up.
export async function runModel(runChat, model, set, opts = {}) {
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
