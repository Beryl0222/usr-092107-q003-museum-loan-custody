// 绩溪县博物馆 51 件徽州木雕借往山东展出的端到端演示。
// 运行：npm run demo
import { redactInsurance } from "../src/domain/policies.js";
import * as proj from "../src/projections/index.js";
import { LoanService } from "../src/services/loanService.js";
import { EventStore } from "../src/store/eventStore.js";

const ORGS = { lender: "jixi-museum", borrower: "shandong-museum", carrier: "anyun-logistics" };
const LOAN_ID = "loan-jx-sd-2026";
const OBJECT_IDS = Array.from({ length: 51 }, (_, i) => `obj-${String(i + 1).padStart(3, "0")}`);

const actors = {
  registrar: { id: "reg-01", role: "registrar", org: ORGS.lender },
  lender: { id: "wen-01", role: "lender_conservator", org: ORGS.lender },
  lead: { id: "wen-lead", role: "lender_conservator", org: ORGS.lender },
  borrower: { id: "bao-01", role: "borrower_conservator", org: ORGS.borrower },
  borrower2: { id: "bao-02", role: "borrower_conservator", org: ORGS.borrower },
  carrier: { id: "yun-01", role: "carrier", org: ORGS.carrier },
  device: { id: "dev-01", role: "device", org: "sensor-hub" },
};

const store = new EventStore();
const service = new LoanService(store);
const show = (title, value) => {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(value, null, 2));
};

// 1. 借展登记：协议、阈值、保险、许可
service.registerLoan(actors.registrar, {
  loan_id: LOAN_ID,
  lender_org: ORGS.lender,
  borrower_org: ORGS.borrower,
  object_ids: OBJECT_IDS,
  period: { start: "2026-09-01T00:00:00+08:00", end: "2027-03-01T00:00:00+08:00" },
  venue: "山东博物馆特展厅",
  decision_makers: ["wen-lead"],
  at: "2026-08-20T09:00:00+08:00",
});
for (const objectId of OBJECT_IDS) {
  service.registerObject(actors.registrar, {
    loan_id: LOAN_ID,
    object_id: objectId,
    name: `徽州木雕·${objectId}`,
    category: "徽州木雕",
    historical_condition: [{ part: "边框", description: "民国年间补配雕花一角", severity: "stable" }],
    at: "2026-08-21T09:00:00+08:00",
  });
}
service.setThresholds(actors.lender, {
  loan_id: LOAN_ID,
  rules: [{ metric: "humidity", min: 45, max: 60, unit: "%RH" }],
  at: "2026-08-22T09:00:00+08:00",
});
service.bindInsurance(actors.registrar, {
  policy_id: "pol-01",
  loan_id: LOAN_ID,
  insurer: "example-insurance",
  covered_object_ids: OBJECT_IDS,
  coverage: ["transit", "exhibition", "water_damage"],
  period: { start: "2026-09-01T00:00:00+08:00", end: "2027-03-01T00:00:00+08:00" },
  amount: 80000000,
  currency: "CNY",
  premium: 320000,
  at: "2026-08-25T09:00:00+08:00",
});
service.grantLicense(actors.lender, {
  license_id: "lic-01",
  loan_id: LOAN_ID,
  licensor_org: ORGS.lender,
  licensee_org: ORGS.borrower,
  object_ids: OBJECT_IDS,
  allowed_uses: ["display", "photo"],
  valid_period: { start: "2026-09-01T00:00:00+08:00", end: "2027-03-01T00:00:00+08:00" },
  restrictions: ["no_flash"],
  at: "2026-08-23T09:00:00+08:00",
});

// 2. 装箱与两段交接
const cases = [
  ["case-01", OBJECT_IDS.slice(0, 17)],
  ["case-02", OBJECT_IDS.slice(17, 34)],
  ["case-03", OBJECT_IDS.slice(34, 51)],
];
for (const [caseId, objects] of cases) {
  service.assembleCase(actors.lender, { loan_id: LOAN_ID, case_id: caseId, case_type: "outer", object_ids: [], sealed: true, at: "2026-09-01T09:00:00+08:00" });
  for (const objectId of objects) {
    service.packObject(actors.lender, { loan_id: LOAN_ID, object_id: objectId, case_id: caseId, materials: ["无酸纸", "定制囊匣"], at: "2026-09-01T10:00:00+08:00" });
  }
}
const sign = (a, b, at) => [
  { signer_id: a.id, signer_org: a.org, role: a.role, signed_at: at },
  { signer_id: b.id, signer_org: b.org, role: b.role, signed_at: at },
];
service.transferCustody(actors.carrier, {
  handoff_id: "ho-out-1", loan_id: LOAN_ID, from_org: ORGS.lender, to_org: ORGS.carrier,
  object_ids: OBJECT_IDS, case_ids: cases.map(([id]) => id), location: "绩溪县博物馆库房",
  signatures: sign(actors.lender, actors.carrier, "2026-09-02T09:00:00+08:00"), at: "2026-09-02T09:00:00+08:00",
});
service.transferCustody(actors.carrier, {
  handoff_id: "ho-out-2", loan_id: LOAN_ID, from_org: ORGS.carrier, to_org: ORGS.borrower,
  object_ids: OBJECT_IDS, case_ids: cases.map(([id]) => id), location: "山东博物馆卸货区",
  signatures: sign(actors.carrier, actors.borrower, "2026-09-04T10:00:00+08:00"), at: "2026-09-04T10:00:00+08:00",
});

// 3. 开箱检查签署；展期湿度越界 → 待研判风险 → 授权人员研判
service.inspect(actors.borrower, {
  loan_id: LOAN_ID, report_id: "rpt-unpack-007", object_id: "obj-007", phase: "post_unpack",
  station: "山东博物馆开箱区",
  findings: [{ finding_id: "f-base", part: "边框", description: "旧修补痕迹与基线一致", severity: "stable", is_new: false }],
  at: "2026-09-05T09:00:00+08:00",
});
service.signCondition(actors.borrower, { report_id: "rpt-unpack-007", at: "2026-09-05T10:00:00+08:00" });
service.ingestReadings(actors.device, {
  sensor_id: "sensor-hall-1", case_id: "case-01",
  readings: [{ metric: "humidity", value: 63, unit: "%RH", measured_at: "2026-10-10T14:00:00+08:00" }],
  at: "2026-10-10T14:05:00+08:00",
});
const risk = proj.risksOf(store, LOAN_ID)[0];
service.resolveRisk(actors.lead, { risk_id: risk.risk_id, decision: "monitor", rationale: "短时波动，除湿机已介入", at: "2026-10-10T16:00:00+08:00" });

// 4. 展厅渗水紧急转移：先保护实物，后补双人确认
const moveEvents = service.emergencyMove(actors.borrower, {
  loan_id: LOAN_ID, object_ids: ["obj-007"], from_location: "特展厅", to_location: "库房安全区",
  reason: "展厅顶部渗水", at: "2026-11-01T08:00:00+08:00",
});
const exceptionId = moveEvents[0].payload.exception_id;
service.confirmEmergency(actors.borrower2, { exception_id: exceptionId, confirmer_ids: ["bao-01", "bao-02"], at: "2026-11-01T10:00:00+08:00" });
service.closeException(actors.borrower, { exception_id: exceptionId, resolution: "渗水修复，藏品无恙回位", at: "2026-11-03T09:00:00+08:00" });

// 5. 按许可轮换与拍摄
service.rotateDisplay(actors.borrower, { loan_id: LOAN_ID, object_id: "obj-007", to_slot: "特展厅-展位A3", license_id: "lic-01", at: "2026-11-05T09:00:00+08:00" });
service.logMediaUsage(actors.borrower, { loan_id: LOAN_ID, license_id: "lic-01", object_ids: ["obj-007"], use_type: "photo", purpose: "展览图录", at: "2026-11-06T09:00:00+08:00" });

// 6. 返还：验收发现一处新损伤，自动立案
service.inspect(actors.borrower, {
  loan_id: LOAN_ID, report_id: "rpt-return-007", object_id: "obj-007", phase: "pre_return",
  station: "山东博物馆点交区",
  findings: [{ finding_id: "f-dmg", part: "右下角雕花", description: "新见磕碰缺肉 3mm", severity: "damage", is_new: true }],
  at: "2027-02-01T09:00:00+08:00",
});
service.signCondition(actors.borrower, { report_id: "rpt-return-007", at: "2027-02-01T10:00:00+08:00" });
service.transferCustody(actors.carrier, {
  handoff_id: "ho-back-1", loan_id: LOAN_ID, from_org: ORGS.borrower, to_org: ORGS.lender,
  object_ids: OBJECT_IDS, case_ids: cases.map(([id]) => id), location: "绩溪县博物馆库房",
  signatures: sign(actors.borrower, actors.lender, "2027-02-03T09:00:00+08:00"), at: "2027-02-03T09:00:00+08:00",
});
service.acceptReturn(actors.lender, {
  handoff_id: "ho-back-1", loan_id: LOAN_ID, object_ids: OBJECT_IDS,
  condition_report_ids: ["rpt-return-007"], at: "2027-02-03T10:00:00+08:00",
});

// 出借方远程视角
show("出借方视角：obj-007 保管链", proj.custodyChain(store, "obj-007").map((c) => `${c.occurred_instant} ${c.event_type} — ${c.summary}`));
show("出借方视角：未闭合异常与待研判风险", proj.openItems(store, LOAN_ID));

// 审计视角：从损伤回看
const trace = proj.traceFinding(store, "rpt-return-007", "f-dmg");
show("审计视角：损伤回溯（箱件谱系）", trace.case_lineage);
show("审计视角：损伤回溯（环境曲线）", trace.environment_curve);
show("审计视角：损伤回溯（签收证据）", trace.handoffs.map((h) => ({ handoff_id: h.handoff_id, from: h.from_org, to: h.to_org, signers: h.signatures.map((s) => s.signer_id) })));

// 保险信息按角色脱敏
const policy = proj.insuranceOf(store, "pol-01").payload;
show("保险单（审计可见保额）", redactInsurance(policy, "auditor"));
show("保险单（承运视角，保额脱敏）", redactInsurance(policy, "carrier"));

console.log(`\n演示完成，共 ${store.all().length} 条事件。`);
