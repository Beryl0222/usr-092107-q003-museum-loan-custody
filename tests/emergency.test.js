import assert from "node:assert/strict";
import test from "node:test";

import * as proj from "../src/projections/index.js";
import { bootstrapLoan, LOAN_ID, makeContext, packAndShip } from "./helpers.js";

function setupAtVenue() {
  const ctx = makeContext();
  bootstrapLoan(ctx.service, ctx.actors, { objectIds: ["obj-001"] });
  packAndShip(ctx.service, ctx.actors, { objectIds: ["obj-001"] });
  return ctx;
}

test("紧急转移先保护实物：单人即可记录，异常保持待确认", () => {
  const { service, store, actors } = setupAtVenue();
  const events = service.emergencyMove(actors.borrower, {
    loan_id: LOAN_ID,
    object_ids: ["obj-001"],
    from_location: "特展厅",
    to_location: "库房安全区",
    reason: "展厅漏水",
    at: "2026-10-01T08:00:00+08:00",
  });
  assert.deepEqual(events.map((e) => e.event_type), ["EXCEPTION_OPENED", "EMERGENCY_MOVED"]);

  const exceptionId = events[0].payload.exception_id;
  const state = proj.exceptionState(store, exceptionId);
  assert.equal(state.pending_confirmation, true);
  // 出借方远程可见未闭合异常
  const open = proj.openItems(store, LOAN_ID);
  assert.equal(open.exceptions.length, 1);
  assert.equal(open.exceptions[0].pending_confirmation, true);

  // 双人确认未补齐前不能闭合
  assert.throws(
    () => service.closeException(actors.borrower, { exception_id: exceptionId, resolution: "处置完毕" }),
    /双人确认尚未补齐/,
  );
});

test("双人确认须两名不同人员且至少一人非执行人", () => {
  const { service, store, actors } = setupAtVenue();
  const events = service.emergencyMove(actors.borrower, {
    loan_id: LOAN_ID,
    object_ids: ["obj-001"],
    from_location: "特展厅",
    to_location: "库房安全区",
    reason: "展厅漏水",
    at: "2026-10-01T08:00:00+08:00",
  });
  const exceptionId = events[0].payload.exception_id;

  assert.throws(
    () => service.confirmEmergency(actors.borrower, { exception_id: exceptionId, confirmer_ids: ["bao-01", "bao-01"] }),
    /两名不同人员/,
  );
  assert.throws(
    () =>
      service.confirmEmergency(actors.borrower, { exception_id: exceptionId, confirmer_ids: ["bao-01", "bao-01"].slice(0, 1) }),
    /两名不同人员/,
  );

  service.confirmEmergency(actors.borrower2, {
    exception_id: exceptionId,
    confirmer_ids: ["bao-01", "bao-02"],
    at: "2026-10-01T09:00:00+08:00",
  });
  service.closeException(actors.borrower, {
    exception_id: exceptionId,
    resolution: "漏水已修，藏品点交回位",
    at: "2026-10-02T09:00:00+08:00",
  });
  assert.equal(proj.openItems(store, LOAN_ID).exceptions.length, 0);
});
