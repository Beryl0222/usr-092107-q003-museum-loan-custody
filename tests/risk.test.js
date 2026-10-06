import assert from "node:assert/strict";
import test from "node:test";

import * as proj from "../src/projections/index.js";
import { bootstrapLoan, LOAN_ID, makeContext, packAndShip } from "./helpers.js";

function setupWithRisk() {
  const ctx = makeContext();
  bootstrapLoan(ctx.service, ctx.actors, { objectIds: ["obj-001"] });
  packAndShip(ctx.service, ctx.actors, { objectIds: ["obj-001"] });
  ctx.service.ingestReadings(ctx.actors.device, {
    sensor_id: "sensor-01",
    case_id: "case-01",
    readings: [{ metric: "humidity", value: 66, unit: "%RH", measured_at: "2026-09-10T10:00:00+08:00" }],
    at: "2026-09-10T10:05:00+08:00",
  });
  const riskId = proj.risksOf(ctx.store, LOAN_ID)[0].risk_id;
  return { ...ctx, riskId };
}

test("是否撤展只能由协议授权的文保人员决定", () => {
  const { service, riskId, actors } = setupWithRisk();
  assert.throws(
    () => service.resolveRisk(actors.borrower, { risk_id: riskId, decision: "deinstall", rationale: "湿度持续偏高" }),
    /授权的文保人员/,
  );
  assert.throws(
    () => service.resolveRisk(actors.lender, { risk_id: riskId, decision: "dismissed", rationale: "误报" }),
    /授权的文保人员/,
  );
});

test("授权人员研判撤展后，藏品进入已撤展状态且拒绝再轮换", () => {
  const { service, store, riskId, actors } = setupWithRisk();
  service.resolveRisk(actors.lead, {
    risk_id: riskId,
    decision: "deinstall",
    rationale: "湿度持续超阈值，保护性撤展",
    at: "2026-09-11T09:00:00+08:00",
  });
  assert.equal(store.ofType("DEINSTALL_ORDERED").length, 1);
  assert.equal(proj.displayStatusOf(store, "obj-001").deinstalled, true);
  assert.throws(
    () =>
      service.rotateDisplay(actors.borrower, {
        loan_id: LOAN_ID,
        object_id: "obj-001",
        to_slot: "展位B",
        license_id: "lic-01",
        at: "2026-09-12T09:00:00+08:00",
      }),
    /已撤展/,
  );
});

test("研判为继续观察则不撤展，风险闭合", () => {
  const { service, store, riskId, actors } = setupWithRisk();
  service.resolveRisk(actors.lead, {
    risk_id: riskId,
    decision: "monitor",
    rationale: "短时波动，加强监测",
    at: "2026-09-11T09:00:00+08:00",
  });
  assert.equal(store.ofType("DEINSTALL_ORDERED").length, 0);
  assert.equal(proj.risksOf(store, LOAN_ID)[0].status, "monitor");
  assert.throws(
    () => service.resolveRisk(actors.lead, { risk_id: riskId, decision: "dismissed", rationale: "重复研判" }),
    /已有研判结论/,
  );
});
