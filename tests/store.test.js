import assert from "node:assert/strict";
import test from "node:test";

import { EventStore, StoreError } from "../src/store/eventStore.js";

const base = {
  event_id: "evt-1",
  event_type: "OBJECT_PACKED",
  aggregate_type: "collection_object",
  aggregate_id: "obj-1",
  occurred_at: "2026-09-20T18:00:00+08:00",
  version: 1,
  summary: "装箱",
  payload: { object_id: "obj-1", case_id: "case-1", packed_by: "wen-01" },
};

test("同一事件重复上传按幂等处理，不产生第二条", () => {
  const store = new EventStore();
  const first = store.append(base);
  const again = store.append({ ...base });
  assert.equal(first.deduplicated, false);
  assert.equal(again.deduplicated, true);
  assert.equal(store.all().length, 1);
});

test("event_id 相同但内容不同视为冲突", () => {
  const store = new EventStore();
  store.append(base);
  assert.throws(() => store.append({ ...base, summary: "另一内容" }), StoreError);
});

test("idempotency_key 命中时返回原记录", () => {
  const store = new EventStore();
  store.append({ ...base, idempotency_key: "handoff:ho-1" });
  const retry = store.append({ ...base, event_id: "evt-2", idempotency_key: "handoff:ho-1" });
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.event.event_id, "evt-1");
  assert.equal(store.all().length, 1);
});

test("同一聚合流内 version 必须严格递增", () => {
  const store = new EventStore();
  store.append(base);
  assert.throws(() => store.append({ ...base, event_id: "evt-2", version: 3 }), /期望 version=2/);
  const ok = store.append({ ...base, event_id: "evt-2", version: 2 });
  assert.equal(ok.deduplicated, false);
});

test("不同时区写法归一化为同一 UTC 时刻", () => {
  const store = new EventStore();
  const a = store.append(base).event;
  assert.equal(a.occurred_instant, "2026-09-20T10:00:00.000Z");
  // 同一时刻换时区写法，event_id 相同 → 幂等去重而非冲突
  const b = store.append({ ...base, occurred_at: "2026-09-20T10:00:00Z" });
  assert.equal(b.deduplicated, true);
  assert.equal(store.all().length, 1);
});

test("缺少契约字段被拒绝", () => {
  const store = new EventStore();
  assert.throws(() => store.append({ ...base, payload: { object_id: "obj-1" } }), /payload 缺少字段/);
});
