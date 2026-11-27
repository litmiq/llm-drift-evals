// Builds worker/worker.js (single file) and worker/meta.json from src/core.mjs + tasks/v1.0.0.json + the model list.
import { readFileSync, writeFileSync } from "node:fs";
import { setSha } from "../src/core.mjs";
const root = new URL("../", import.meta.url);
const rd = (p) => readFileSync(new URL(p, root), "utf8");
const full = JSON.parse(rd("tasks/v1.0.0.json"));
const MODELS = JSON.parse(rd("worker/models.json"));
const slim = { ...full, tasks: full.tasks.map(({ gold, bad, ...t }) => t) };   // gold/bad answers are for tests only
const sha = await setSha(full);
const core = rd("src/core.mjs").replace(/^export /gm, "");
let w = rd("worker/worker.src.mjs").replace(/^import .*\n/m, "");
w = w.replace("__SET_SHA__", JSON.stringify(sha)).replace("__SET__", JSON.stringify(slim)).replace("__MODELS__", JSON.stringify(MODELS.map((m) => m.id)));
writeFileSync(new URL("worker/worker.js", root), core + "\n" + w.replace("export default", "export default"));
writeFileSync(new URL("worker/meta.json", root), JSON.stringify({ set_id: full.id, version: full.version, sha256: sha, tasks: full.tasks.length,
  categories: Object.fromEntries(full.categories.map((c) => [c, full.tasks.filter((t) => t.category === c).length])), decoding: full.decoding, models: MODELS }, null, 1));
console.log("built", sha);
