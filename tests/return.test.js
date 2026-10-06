import assert from "node:assert/strict";
import test from "node:test";

import * as proj from "../src/projections/index.js";
import { bootstrapLoan, LOAN_ID, makeContext, ORGS, packAndShip } from "./helpers.js";

// 走完 出借→展期→返还 全程，返还验收时发现一处新损伤。
function setupReturning({ withDamage = true } = {}) {
  const ctx = makeContext();
  const { service, actors } = ctx;
  bootstrapLoan(service, actors, { objectIds: ["obj-001"] });
  packAndShip(service, actors, { objectIds: ["obj-001"] });

  // 展期结束，承借方做返还前检查并签署
  service.inspect(actors.borrower, {
    loan_id: LOAN_ID,
    report_id: "rpt-return",
    object_id: "obj-001",
    phase: "pre_return",
    station: "山东博物馆点交区",
    findings: withDamage
      ? [{ finding_id: "f-dmg", part: "右下角雕花", description: "新见磕碰缺肉 3mm", severity: "damage", is_new: true }]
      : [],
    at: "2027-02-01T09:00:00+08:00",
  });
  service.signCondition(actors.borrower, { report_id: "rpt-return", at: "2027-02-01T10:00:00+08:00" });

  // 返还交接回出借方
  service.transferCustody(actors.carrier, {
    handoff_id: "ho-return",
    loan_id: LOAN_ID,
    from_org: ORGS.borrower,
    to_org: ORGS.lender,
    object_ids: ["obj-001"],
    case_ids: ["case-01"],
    location: "绩溪县博物馆库房",
    signatures: [
      { signer_id: "bao-01", signer_org: ORGS.borrower, role: "borrower_conservator", signed_at: "2027-02-03T09:00:00+08:00" },
      { signer_id: "wen-01", signer_org: ORGS.lender, role: "lender_conservator", signed_at: "2027-02-03T09:05:00+08:00" },
    ],
    at: "2027-02-03T09:00:00+08:00",
  });
  return ctx;
}

test("返还验收发现新损伤时自动立案，出借方可见未闭合异常", () => {
  const { service, store, actors } = setupReturning();
  const events = service.acceptReturn(actors.lender, {
    handoff_id: "ho-return",
    loan_id: LOAN_ID,
    object_ids: ["obj-001"],
    condition_report_ids: ["rpt-return"],
    at: "2027-02-03T10:00:00+08:00",
  });
  assert.deepEqual(events.map((e) => e.event_type), ["EXCEPTION_OPENED", "RETURN_ACCEPTED"]);

  const accepted = events[1];
  assert.equal(accepted.payload.discrepancies.length, 1);
  assert.equal(accepted.payload.discrepancies[0].finding_id, "f-dmg");

  const open = proj.openItems(store, LOAN_ID);
  assert.equal(open.exceptions.length, 1);
  assert.equal(open.exceptions[0].kind, "damage");
  assert.deepEqual(open.exceptions[0].object_ids, ["obj-001"]);
});

test("无差异时正常验收，不立案", () => {
  const { service, store, actors } = setupReturning({ withDamage: false });
  const events = service.acceptReturn(actors.lender, {
    handoff_id: "ho-return",
    loan_id: LOAN_ID,
    object_ids: ["obj-001"],
    condition_report_ids: ["rpt-return"],
    at: "2027-02-03T10:00:00+08:00",
  });
  assert.deepEqual(events.map((e) => e.event_type), ["RETURN_ACCEPTED"]);
  assert.equal(proj.openItems(store, LOAN_ID).exceptions.length, 0);
});

test("未签署的报告不能作为验收依据", () => {
  const ctx = makeContext();
  const { service, actors } = ctx;
  bootstrapLoan(service, actors, { objectIds: ["obj-001"] });
  packAndShip(service, actors, { objectIds: ["obj-001"] });
  service.inspect(actors.borrower, {
    loan_id: LOAN_ID,
    report_id: "rpt-unsigned",
    object_id: "obj-001",
    phase: "pre_return",
    station: "山东博物馆点交区",
    findings: [],
    at: "2027-02-01T09:00:00+08:00",
  });
  service.transferCustody(actors.carrier, {
    handoff_id: "ho-return",
    loan_id: LOAN_ID,
    from_org: ORGS.borrower,
    to_org: ORGS.lender,
    object_ids: ["obj-001"],
    case_ids: ["case-01"],
    location: "绩溪县博物馆库房",
    signatures: [
      { signer_id: "bao-01", signer_org: ORGS.borrower, role: "borrower_conservator", signed_at: "2027-02-03T09:00:00+08:00" },
      { signer_id: "wen-01", signer_org: ORGS.lender, role: "lender_conservator", signed_at: "2027-02-03T09:05:00+08:00" },
    ],
    at: "2027-02-03T09:00:00+08:00",
  });
  assert.throws(
    () =>
      service.acceptReturn(actors.lender, {
        handoff_id: "ho-return",
        loan_id: LOAN_ID,
        object_ids: ["obj-001"],
        condition_report_ids: ["rpt-unsigned"],
        at: "2027-02-03T10:00:00+08:00",
      }),
    /未签署/,
  );
});
