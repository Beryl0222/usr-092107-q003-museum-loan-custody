import assert from "node:assert/strict";
import test from "node:test";

import * as proj from "../src/projections/index.js";
import { bootstrapLoan, LOAN_ID, makeContext, packAndShip } from "./helpers.js";

function setupShipped() {
  const ctx = makeContext();
  bootstrapLoan(ctx.service, ctx.actors, { objectIds: ["obj-001"] });
  packAndShip(ctx.service, ctx.actors, { objectIds: ["obj-001"] });
  return ctx;
}

test("未签署报告可补充新发现，签署后冻结", () => {
  const { service, store, actors } = setupShipped();
  service.inspect(actors.borrower, {
    loan_id: LOAN_ID,
    report_id: "rpt-1",
    object_id: "obj-001",
    phase: "post_unpack",
    station: "山东博物馆开箱区",
    findings: [{ finding_id: "f-1", part: "边框", description: "旧修补痕迹与基线一致", severity: "stable", is_new: false }],
    at: "2026-09-05T09:00:00+08:00",
  });
  service.recordFinding(actors.borrower, {
    report_id: "rpt-1",
    finding: { finding_id: "f-2", part: "背板", description: "新见细微开裂", severity: "watch", is_new: true },
    at: "2026-09-05T09:30:00+08:00",
  });
  service.signCondition(actors.borrower, { report_id: "rpt-1", at: "2026-09-05T10:00:00+08:00" });

  assert.throws(
    () =>
      service.recordFinding(actors.borrower, {
        report_id: "rpt-1",
        finding: { finding_id: "f-3", part: "边框", description: "事后补写", severity: "watch", is_new: true },
      }),
    /已签署，不得修改/,
  );

  const report = proj.reportOf(store, "rpt-1");
  assert.equal(report.signed, true);
  assert.equal(report.findings.length, 2);
});

test("前一站签署的状况不能被后一站改掉，新发现只能进新报告", () => {
  const { service, store, actors } = setupShipped();
  service.inspect(actors.borrower, {
    loan_id: LOAN_ID,
    report_id: "rpt-1",
    object_id: "obj-001",
    phase: "post_unpack",
    station: "山东博物馆开箱区",
    findings: [{ finding_id: "f-1", part: "边框", description: "旧修补痕迹与基线一致", severity: "stable", is_new: false }],
    at: "2026-09-05T09:00:00+08:00",
  });
  service.signCondition(actors.borrower, { report_id: "rpt-1", at: "2026-09-05T10:00:00+08:00" });

  // 展期复查另立新报告，引用上一站
  service.inspect(actors.borrower, {
    loan_id: LOAN_ID,
    report_id: "rpt-2",
    object_id: "obj-001",
    phase: "on_display",
    station: "特展厅",
    previous_report_id: "rpt-1",
    findings: [{ finding_id: "f-9", part: "背板", description: "展期新见开裂 2cm", severity: "watch", is_new: true }],
    at: "2026-10-01T09:00:00+08:00",
  });
  service.signCondition(actors.borrower, { report_id: "rpt-2", at: "2026-10-01T10:00:00+08:00" });

  const reports = proj.conditionReports(store, "obj-001");
  assert.equal(reports.length, 2);
  // 前一站签署内容保持原样
  assert.deepEqual(
    reports[0].findings.map((f) => f.finding_id),
    ["f-1"],
  );
  assert.deepEqual(
    reports[1].findings.map((f) => f.finding_id),
    ["f-9"],
  );
});

test("非当前保管方不能检查", () => {
  const { service, actors } = setupShipped();
  assert.throws(
    () =>
      service.inspect(actors.lender, {
        loan_id: LOAN_ID,
        report_id: "rpt-x",
        object_id: "obj-001",
        phase: "on_display",
        station: "特展厅",
        findings: [],
      }),
    /不能检查/,
  );
});
