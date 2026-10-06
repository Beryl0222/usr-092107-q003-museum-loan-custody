import assert from "node:assert/strict";
import test from "node:test";

import { redactInsurance } from "../src/domain/policies.js";
import * as proj from "../src/projections/index.js";
import { bootstrapLoan, LOAN_ID, makeContext, ORGS, packAndShip } from "./helpers.js";

// 从一处损伤回看：相关箱件、环境曲线与签收证据都要在回溯结果里。
function setupWithDamageTrace() {
  const ctx = makeContext();
  const { service, actors } = ctx;
  bootstrapLoan(service, actors, { objectIds: ["obj-001", "obj-002"] });
  packAndShip(service, actors, { objectIds: ["obj-001", "obj-002"] });

  // 运输途中湿度越界，留下环境曲线与待研判风险
  service.ingestReadings(actors.device, {
    sensor_id: "sensor-01",
    case_id: "case-01",
    readings: [
      { metric: "humidity", value: 55, unit: "%RH", measured_at: "2026-09-03T08:00:00+08:00" },
      { metric: "humidity", value: 66, unit: "%RH", measured_at: "2026-09-03T09:00:00+08:00" },
      { metric: "humidity", value: 54, unit: "%RH", measured_at: "2026-09-03T10:00:00+08:00" },
    ],
    at: "2026-09-03T10:05:00+08:00",
  });

  // 返还前检查发现新损伤并签署
  service.inspect(actors.borrower, {
    loan_id: LOAN_ID,
    report_id: "rpt-return",
    object_id: "obj-001",
    phase: "pre_return",
    station: "山东博物馆点交区",
    findings: [{ finding_id: "f-dmg", part: "右下角雕花", description: "新见磕碰缺肉 3mm", severity: "damage", is_new: true }],
    at: "2027-02-01T09:00:00+08:00",
  });
  service.signCondition(actors.borrower, { report_id: "rpt-return", at: "2027-02-01T10:00:00+08:00" });
  return ctx;
}

test("损伤回溯给出基线、各站状况、箱件谱系、环境曲线与签收证据", () => {
  const { store } = setupWithDamageTrace();
  const trace = proj.traceFinding(store, "rpt-return", "f-dmg");

  assert.equal(trace.finding.description, "新见磕碰缺肉 3mm");
  assert.equal(trace.object.object_id, "obj-001");
  assert.equal(trace.object.historical_condition.length, 1);

  // 箱件谱系：obj-001 全程在 case-01
  assert.deepEqual(trace.case_lineage.map((c) => c.case_id), ["case-01"]);

  // 环境曲线：三条湿度读数按时刻排序
  assert.equal(trace.environment_curve.length, 3);
  assert.deepEqual(
    trace.environment_curve.map((r) => r.value),
    [55, 66, 54],
  );

  // 签收证据：两段交接，签署人齐全
  assert.equal(trace.handoffs.length, 2);
  for (const handoff of trace.handoffs) {
    assert.equal(handoff.signatures.length, 2);
  }

  // 超阈值窗口与待研判风险可关联
  assert.equal(trace.excursions.length, 1);
  assert.equal(trace.risks.length, 1);
  assert.equal(trace.risks[0].status, "PENDING");
});

test("保险信息按角色脱敏：审计可见保额，承运不可见", () => {
  const { service, store, actors } = setupWithDamageTrace();
  service.bindInsurance(actors.registrar, {
    policy_id: "pol-01",
    loan_id: LOAN_ID,
    insurer: "example-insurance",
    covered_object_ids: ["obj-001", "obj-002"],
    coverage: ["transit", "exhibition"],
    period: { start: "2026-09-01T00:00:00+08:00", end: "2027-03-01T00:00:00+08:00" },
    amount: 5000000,
    currency: "CNY",
    premium: 25000,
    at: "2026-08-25T09:00:00+08:00",
  });
  const payload = proj.insuranceOf(store, "pol-01").payload;
  assert.equal(redactInsurance(payload, "auditor").amount, 5000000);
  const forCarrier = redactInsurance(payload, "carrier");
  assert.equal(forCarrier.amount, "（按角色隐藏）");
  assert.equal(forCarrier.premium, "（按角色隐藏）");
  assert.deepEqual(forCarrier.coverage, ["transit", "exhibition"]);
});
