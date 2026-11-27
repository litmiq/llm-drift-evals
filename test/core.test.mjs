import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { grade, setSha, clean } from "../src/core.mjs";

const set = JSON.parse(readFileSync(new URL("../tasks/v1.0.0.json", import.meta.url), "utf8"));
test("40 tasks, 10 per category, unique ids", () => {
  assert.equal(set.tasks.length, 40);
  assert.equal(new Set(set.tasks.map((t) => t.id)).size, 40);
  for (const c of set.categories) assert.equal(set.tasks.filter((t) => t.category === c).length, 10);
});
test("every gold answer passes", () => {
  for (const t of set.tasks) assert.equal(grade(t, t.gold).pass, true, t.id);
});
test("every bad answer fails", () => {
  for (const t of set.tasks) assert.equal(grade(t, t.bad).pass, false, t.id);
});
test("empty / null output fails every task", () => {
  for (const t of set.tasks) { assert.equal(grade(t, "").pass, false, t.id); assert.equal(grade(t, null).pass, false, t.id); }
});
test("strict JSON: code fences and prose fail", () => {
  const t = set.tasks.find((x) => x.id === "json-01");
  assert.equal(grade(t, '```json\n{"name":"Maria","age":34}\n```').pass, false);
  assert.equal(grade(t, 'Sure: {"name":"Maria","age":34}').pass, false);
  assert.equal(grade(t, ' {"name":"Maria","age":34}\n').pass, true);
});
test("think blocks and unicode spaces are normalised", () => {
  assert.equal(clean("<think>x</think>ok"), "ok");
  const t = set.tasks.find((x) => x.id === "extract-04");
  assert.equal(grade(t, "Elena\u00a0Park; Tom Reyes.").pass, true);
});
test("fingerprint is stable", async () => { assert.equal(await setSha(set), await setSha(JSON.parse(JSON.stringify(set)))); });
