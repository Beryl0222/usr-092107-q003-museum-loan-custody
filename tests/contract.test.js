import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { parseTimestamp } from "../src/event-types.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("全流程事件流中的每一条记录都通过信封校验", async () => {
  const events = JSON.parse(await readFile(new URL("../data/lifecycle.json", import.meta.url), "utf8"));
  assert.ok(events.length > 300);
  const errors = events.flatMap((e, i) => validateEvent(e).map((msg) => `#${i} ${e.event_id}: ${msg}`));
  assert.deepEqual(errors, []);
});

test("事件类型必须与所属聚合匹配", () => {
  const base = {
    event_id: "x", aggregate_id: "a", occurred_at: "2026-09-20T10:00:00+08:00",
    version: 1, summary: "s", actor: { person_id: "p", name: "n", role: "REGISTRAR", org: "o" }, payload: {},
  };
  const missingPayload = validateEvent({ ...base, event_type: "OBJECT_PACKED", aggregate_type: "shipping_case", payload: {} });
  assert.ok(missingPayload.some((m) => m.includes("payload 缺少字段：object_ids")));
  const mismatch = validateEvent({ ...base, event_type: "OBJECT_PACKED", aggregate_type: "loan", payload: {} });
  assert.ok(mismatch.some((m) => m.includes("aggregate_type 必须是 shipping_case")));
  assert.ok(validateEvent({ ...base, event_type: "UNKNOWN", aggregate_type: "loan" }).some((m) => m.includes("未知事件类型")));
});

test("时间戳必须携带时区偏移", () => {
  assert.equal(parseTimestamp("2026-09-20T18:00:00+08:00").offsetMin, 480);
  assert.equal(parseTimestamp("2026-09-20T10:00:00Z").offsetMin, 0);
  // Z 与 +08:00 同一瞬时折算到同一毫秒
  assert.equal(parseTimestamp("2026-09-21T02:00:00Z").epochMs, parseTimestamp("2026-09-21T10:00:00+08:00").epochMs);
  assert.equal(parseTimestamp("2026-09-20T18:00:00"), null);
  assert.equal(parseTimestamp("2026-09-20 18:00:00"), null);
  assert.equal(parseTimestamp("not-a-time"), null);
});

test("未知信封字段与非法角色会被拒绝", () => {
  const event = {
    event_id: "x", event_type: "LOAN_AGREED", aggregate_type: "loan", aggregate_id: "a",
    occurred_at: "2026-09-20T10:00:00+08:00", version: 1, summary: "s",
    actor: { person_id: "p", name: "n", role: "VISITOR", org: "o" },
    payload: { lender: "绩溪县博物馆", borrower: "山东某馆", object_count: 1, period: { start: "2026-09-20T00:00:00+08:00", end: "2026-10-20T00:00:00+08:00" }, venues: ["v"] },
    surprise: true,
  };
  const errors = validateEvent(event);
  assert.ok(errors.some((e) => e.includes("未知信封字段：surprise")));
  assert.ok(errors.some((e) => e.includes("actor.role 不在角色目录内")));
});
