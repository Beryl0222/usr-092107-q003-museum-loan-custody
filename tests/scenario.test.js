import assert from "node:assert/strict";
import test from "node:test";

import * as proj from "../src/projections/index.js";
import { bootstrapLoan, LOAN_ID, makeContext, ORGS } from "./helpers.js";

const OBJECT_IDS = Array.from({ length: 51 }, (_, i) => `obj-${String(i + 1).padStart(3, "0")}`);

// 绩溪县博物馆 51 件徽州木雕借往山东展出的完整旅程。
test("51 件木雕借展全程：运输、布展、开放、返还的连续交接", () => {
  const { service, store, actors } = makeContext();
  bootstrapLoan(service, actors, { objectIds: OBJECT_IDS });
  service.bindInsurance(actors.registrar, {
    policy_id: "pol-01",
    loan_id: LOAN_ID,
    insurer: "example-insurance",
    covered_object_ids: OBJECT_IDS,
    coverage: ["transit", "exhibition", "water_damage"],
    period: { start: "2026-09-01T00:00:00+08:00", end: "2027-03-01T00:00:00+08:00" },
    amount: 80000000,
    currency: "CNY",
    at: "2026-08-25T09:00:00+08:00",
  });

  // 分装三只外箱
  const cases = [
    ["case-01", OBJECT_IDS.slice(0, 17)],
    ["case-02", OBJECT_IDS.slice(17, 34)],
    ["case-03", OBJECT_IDS.slice(34, 51)],
  ];
  for (const [caseId, objects] of cases) {
    service.assembleCase(actors.lender, {
      loan_id: LOAN_ID,
      case_id: caseId,
      case_type: "outer",
      object_ids: [],
      sealed: true,
      at: "2026-09-01T09:00:00+08:00",
    });
    for (const objectId of objects) {
      service.packObject(actors.lender, {
        loan_id: LOAN_ID,
        object_id: objectId,
        case_id: caseId,
        materials: ["无酸纸", "定制囊匣"],
        at: "2026-09-01T10:00:00+08:00",
      });
    }
  }

  // 出借方 → 承运 → 承借方
  const sign = (a, b, at) => [
    { signer_id: a.id, signer_org: a.org, role: a.role, signed_at: at },
    { signer_id: b.id, signer_org: b.org, role: b.role, signed_at: at },
  ];
  service.transferCustody(actors.carrier, {
    handoff_id: "ho-out-1",
    loan_id: LOAN_ID,
    from_org: ORGS.lender,
    to_org: ORGS.carrier,
    object_ids: OBJECT_IDS,
    case_ids: cases.map(([id]) => id),
    location: "绩溪县博物馆库房",
    signatures: sign(actors.lender, actors.carrier, "2026-09-02T09:00:00+08:00"),
    at: "2026-09-02T09:00:00+08:00",
  });
  service.transferCustody(actors.carrier, {
    handoff_id: "ho-out-2",
    loan_id: LOAN_ID,
    from_org: ORGS.carrier,
    to_org: ORGS.borrower,
    object_ids: OBJECT_IDS,
    case_ids: cases.map(([id]) => id),
    location: "山东博物馆卸货区",
    signatures: sign(actors.carrier, actors.borrower, "2026-09-04T10:00:00+08:00"),
    at: "2026-09-04T10:00:00+08:00",
  });

  // 开箱检查并签署
  service.inspect(actors.borrower, {
    loan_id: LOAN_ID,
    report_id: "rpt-unpack-007",
    object_id: "obj-007",
    phase: "post_unpack",
    station: "山东博物馆开箱区",
    findings: [{ finding_id: "f-base", part: "边框", description: "旧修补痕迹与基线一致", severity: "stable", is_new: false }],
    at: "2026-09-05T09:00:00+08:00",
  });
  service.signCondition(actors.borrower, { report_id: "rpt-unpack-007", at: "2026-09-05T10:00:00+08:00" });

  // 展期湿度越界 → 待研判风险 → 授权人员决定继续观察
  service.ingestReadings(actors.device, {
    sensor_id: "sensor-hall-1",
    case_id: "case-01",
    readings: [{ metric: "humidity", value: 63, unit: "%RH", measured_at: "2026-10-10T14:00:00+08:00" }],
    at: "2026-10-10T14:05:00+08:00",
  });
  const risk = proj.risksOf(store, LOAN_ID)[0];
  assert.equal(risk.status, "PENDING");
  service.resolveRisk(actors.lead, {
    risk_id: risk.risk_id,
    decision: "monitor",
    rationale: "短时波动，除湿机已介入",
    at: "2026-10-10T16:00:00+08:00",
  });

  // 展厅渗水紧急转移 → 双人确认补齐 → 闭合
  const moveEvents = service.emergencyMove(actors.borrower, {
    loan_id: LOAN_ID,
    object_ids: ["obj-007"],
    from_location: "特展厅",
    to_location: "库房安全区",
    reason: "展厅顶部渗水",
    at: "2026-11-01T08:00:00+08:00",
  });
  const exceptionId = moveEvents[0].payload.exception_id;
  service.confirmEmergency(actors.borrower2, {
    exception_id: exceptionId,
    confirmer_ids: ["bao-01", "bao-02"],
    at: "2026-11-01T10:00:00+08:00",
  });
  service.closeException(actors.borrower, {
    exception_id: exceptionId,
    resolution: "渗水修复，藏品无恙回位",
    at: "2026-11-03T09:00:00+08:00",
  });

  // 按许可轮换展位与拍摄
  service.rotateDisplay(actors.borrower, {
    loan_id: LOAN_ID,
    object_id: "obj-007",
    to_slot: "特展厅-展位A3",
    license_id: "lic-01",
    at: "2026-11-05T09:00:00+08:00",
  });
  service.logMediaUsage(actors.borrower, {
    loan_id: LOAN_ID,
    license_id: "lic-01",
    object_ids: ["obj-007"],
    use_type: "photo",
    purpose: "展览图录",
    at: "2026-11-06T09:00:00+08:00",
  });

  // 返还：承借方检查签署（obj-007 新见损伤）→ 交还 → 出借方验收
  service.inspect(actors.borrower, {
    loan_id: LOAN_ID,
    report_id: "rpt-return-007",
    object_id: "obj-007",
    phase: "pre_return",
    station: "山东博物馆点交区",
    findings: [{ finding_id: "f-dmg", part: "右下角雕花", description: "新见磕碰缺肉 3mm", severity: "damage", is_new: true }],
    at: "2027-02-01T09:00:00+08:00",
  });
  service.signCondition(actors.borrower, { report_id: "rpt-return-007", at: "2027-02-01T10:00:00+08:00" });
  service.transferCustody(actors.carrier, {
    handoff_id: "ho-back-1",
    loan_id: LOAN_ID,
    from_org: ORGS.borrower,
    to_org: ORGS.lender,
    object_ids: OBJECT_IDS,
    case_ids: cases.map(([id]) => id),
    location: "绩溪县博物馆库房",
    signatures: sign(actors.borrower, actors.lender, "2027-02-03T09:00:00+08:00"),
    at: "2027-02-03T09:00:00+08:00",
  });
  service.acceptReturn(actors.lender, {
    handoff_id: "ho-back-1",
    loan_id: LOAN_ID,
    object_ids: OBJECT_IDS,
    condition_report_ids: ["rpt-return-007"],
    at: "2027-02-03T10:00:00+08:00",
  });

  // 出借方远程视角：obj-007 保管链完整、未闭合异常正是那处损伤
  const chain = proj.custodyChain(store, "obj-007").map((c) => c.event_type);
  for (const expected of [
    "OBJECT_REGISTERED",
    "OBJECT_PACKED",
    "CUSTODY_TRANSFERRED",
    "CONDITION_INSPECTED",
    "EMERGENCY_MOVED",
    "DISPLAY_ROTATED",
    "RETURN_ACCEPTED",
  ]) {
    assert.ok(chain.includes(expected), `保管链缺少 ${expected}`);
  }
  const open = proj.openItems(store, LOAN_ID);
  assert.equal(open.exceptions.length, 1);
  assert.equal(open.exceptions[0].kind, "damage");
  assert.deepEqual(open.exceptions[0].object_ids, ["obj-007"]);
  assert.equal(open.pending_risks.length, 0);

  // 审计视角：从损伤回看箱件、环境曲线与签收证据
  const trace = proj.traceFinding(store, "rpt-return-007", "f-dmg");
  assert.equal(trace.object.name, "徽州木雕·obj-007");
  assert.deepEqual(trace.case_lineage.map((c) => c.case_id), ["case-01"]);
  assert.ok(trace.environment_curve.length > 0);
  assert.equal(trace.handoffs.length, 3);
  assert.equal(trace.excursions.length, 1);
});
