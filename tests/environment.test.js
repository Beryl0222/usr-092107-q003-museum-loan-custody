import assert from "node:assert/strict";
import test from "node:test";

import * as proj from "../src/projections/index.js";
import { bootstrapLoan, LOAN_ID, makeContext } from "./helpers.js";

function setup() {
  const ctx = makeContext();
  bootstrapLoan(ctx.service, ctx.actors, { objectIds: ["obj-001"] });
  ctx.service.assembleCase(ctx.actors.lender, {
    loan_id: LOAN_ID,
    case_id: "case-01",
    case_type: "outer",
    object_ids: [],
    at: "2026-09-01T09:00:00+08:00",
  });
  ctx.service.packObject(ctx.actors.lender, {
    loan_id: LOAN_ID,
    object_id: "obj-001",
    case_id: "case-01",
    at: "2026-09-01T10:00:00+08:00",
  });
  return ctx;
}

const humidity = (value, measured_at) => ({ metric: "humidity", value, unit: "%RH", measured_at });

test("超阈值只生成待研判风险，不自动立案也不自动撤展", () => {
  const { service, store, actors } = setup();
  const result = service.ingestReadings(actors.device, {
    sensor_id: "sensor-01",
    case_id: "case-01",
    readings: [humidity(66, "2026-09-10T10:00:00+08:00"), humidity(67, "2026-09-10T11:00:00+08:00")],
    at: "2026-09-10T11:05:00+08:00",
  });
  assert.equal(result.deduplicated, false);

  assert.equal(store.ofType("EXCURSION_REPORTED").length, 1);
  assert.equal(store.ofType("RISK_RAISED").length, 1);
  assert.equal(store.ofType("EXCEPTION_OPENED").length, 0);
  assert.equal(store.ofType("DEINSTALL_ORDERED").length, 0);

  const risks = proj.risksOf(store, LOAN_ID);
  assert.equal(risks.length, 1);
  assert.equal(risks[0].status, "PENDING");
  assert.deepEqual(risks[0].object_ids, ["obj-001"]);
});

test("同一批次换时区写法重复上传，不产生第二条读数与第二个风险", () => {
  const { service, store, actors } = setup();
  service.ingestReadings(actors.device, {
    sensor_id: "sensor-01",
    case_id: "case-01",
    readings: [humidity(66, "2026-09-10T10:00:00+08:00")],
    at: "2026-09-10T10:05:00+08:00",
  });
  // 断网恢复后重传同一时刻，时区写法不同
  const retry = service.ingestReadings(actors.device, {
    sensor_id: "sensor-01",
    case_id: "case-01",
    backfilled: true,
    readings: [humidity(66, "2026-09-10T02:00:00Z")],
    at: "2026-09-10T12:00:00+08:00",
  });
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.skipped, 1);
  assert.equal(store.ofType("READING_INGESTED").length, 1);
  assert.equal(store.ofType("EXCURSION_REPORTED").length, 1);
  assert.equal(store.ofType("RISK_RAISED").length, 1);
});

test("断网补报把窗口向前延伸时，原风险被标注取代而不是留下虚假事故", () => {
  const { service, store, actors } = setup();
  // 在线先到 11:00 的越界读数
  service.ingestReadings(actors.device, {
    sensor_id: "sensor-01",
    case_id: "case-01",
    readings: [humidity(66, "2026-09-10T11:00:00+08:00")],
    at: "2026-09-10T11:05:00+08:00",
  });
  assert.equal(proj.risksOf(store, LOAN_ID).filter((r) => r.status === "PENDING").length, 1);

  // 补报更早的 10:00 越界读数：窗口起点前移，原窗口失效
  service.ingestReadings(actors.device, {
    sensor_id: "sensor-01",
    case_id: "case-01",
    backfilled: true,
    readings: [humidity(65, "2026-09-10T10:00:00+08:00")],
    at: "2026-09-10T12:00:00+08:00",
  });

  const risks = proj.risksOf(store, LOAN_ID);
  const pending = risks.filter((r) => r.status === "PENDING");
  const superseded = risks.filter((r) => r.status === "superseded_by_backfill");
  assert.equal(pending.length, 1);
  assert.equal(superseded.length, 1);
  // 窗口确实从 10:00 开始
  const excursion = store.ofType("EXCURSION_REPORTED").at(-1);
  assert.equal(excursion.payload.window.start, "2026-09-10T02:00:00.000Z");
  // 全程没有自动立案
  assert.equal(store.ofType("EXCEPTION_OPENED").length, 0);
});

test("正常读数闭合窗口，新的越界开启新窗口", () => {
  const { service, store, actors } = setup();
  service.ingestReadings(actors.device, {
    sensor_id: "sensor-01",
    case_id: "case-01",
    readings: [
      humidity(66, "2026-09-10T10:00:00+08:00"),
      humidity(50, "2026-09-10T11:00:00+08:00"),
      humidity(68, "2026-09-10T12:00:00+08:00"),
    ],
    at: "2026-09-10T12:05:00+08:00",
  });
  assert.equal(store.ofType("EXCURSION_REPORTED").length, 2);
  assert.equal(proj.risksOf(store, LOAN_ID).filter((r) => r.status === "PENDING").length, 2);
});
