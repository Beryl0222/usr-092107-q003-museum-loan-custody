import assert from "node:assert/strict";
import test from "node:test";

import * as proj from "../src/projections/index.js";
import { bootstrapLoan, LOAN_ID, makeContext, ORGS, packAndShip } from "./helpers.js";

function setupPacked() {
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

const sign = (a, b) => [
  { signer_id: a.id, signer_org: a.org, role: a.role, signed_at: "2026-09-02T09:00:00+08:00" },
  { signer_id: b.id, signer_org: b.org, role: b.role, signed_at: "2026-09-02T09:05:00+08:00" },
];

test("交接须双方签署且保管权属实", () => {
  const { service, actors } = setupPacked();
  assert.throws(
    () =>
      service.transferCustody(actors.carrier, {
        handoff_id: "ho-x",
        loan_id: LOAN_ID,
        from_org: ORGS.lender,
        to_org: ORGS.carrier,
        object_ids: ["obj-001"],
        case_ids: ["case-01"],
        location: "绩溪县博物馆",
        signatures: sign(actors.lender, actors.lender2), // 只有交出方
      }),
    /覆盖交出方与接收方/,
  );
  assert.throws(
    () =>
      service.transferCustody(actors.carrier, {
        handoff_id: "ho-y",
        loan_id: LOAN_ID,
        from_org: ORGS.borrower, // 承借方尚未接手
        to_org: ORGS.carrier,
        object_ids: ["obj-001"],
        case_ids: ["case-01"],
        location: "绩溪县博物馆",
        signatures: sign(actors.borrower, actors.carrier),
      }),
    /当前保管方/,
  );
});

test("同一交接单重复上传不产生第二条记录，也不制造异常", () => {
  const { service, store, actors } = setupPacked();
  const args = {
    handoff_id: "ho-01",
    loan_id: LOAN_ID,
    from_org: ORGS.lender,
    to_org: ORGS.carrier,
    object_ids: ["obj-001"],
    case_ids: ["case-01"],
    location: "绩溪县博物馆",
    signatures: sign(actors.lender, actors.carrier),
    at: "2026-09-02T09:00:00+08:00",
  };
  const first = service.transferCustody(actors.carrier, args);
  const retry = service.transferCustody(actors.carrier, args); // 网络重试重复上传
  assert.equal(first.deduplicated, false);
  assert.equal(retry.deduplicated, true);
  assert.equal(store.ofType("CUSTODY_TRANSFERRED").length, 1);
  assert.equal(store.ofType("EXCEPTION_OPENED").length, 0);
  assert.equal(proj.currentCustodian(store, "obj-001", proj.loanOf(store, LOAN_ID)), ORGS.carrier);
});

test("未装箱藏品不能交接运输", () => {
  const ctx = makeContext();
  bootstrapLoan(ctx.service, ctx.actors, { objectIds: ["obj-001"] });
  assert.throws(
    () =>
      ctx.service.transferCustody(ctx.actors.carrier, {
        handoff_id: "ho-z",
        loan_id: LOAN_ID,
        from_org: ORGS.lender,
        to_org: ORGS.carrier,
        object_ids: ["obj-001"],
        case_ids: [],
        location: "绩溪县博物馆",
        signatures: sign(ctx.actors.lender, ctx.actors.carrier),
      }),
    /未装箱/,
  );
});

test("完整两段交接后保管链可查", () => {
  const { service, store, actors } = (() => {
    const ctx = makeContext();
    bootstrapLoan(ctx.service, ctx.actors, { objectIds: ["obj-001"] });
    packAndShip(ctx.service, ctx.actors, { objectIds: ["obj-001"] });
    return ctx;
  })();
  const chain = proj.custodyChain(store, "obj-001");
  const types = chain.map((c) => c.event_type);
  assert.ok(types.includes("OBJECT_PACKED"));
  assert.deepEqual(types.filter((t) => t === "CUSTODY_TRANSFERRED").length, 2);
  const loan = proj.loanOf(store, LOAN_ID);
  assert.equal(proj.currentCustodian(store, "obj-001", loan), ORGS.borrower);
});
