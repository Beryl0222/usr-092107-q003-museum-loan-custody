import assert from "node:assert/strict";
import test from "node:test";

import { bootstrapLoan, LOAN_ID, makeContext, packAndShip } from "./helpers.js";

function setupAtVenue(objectIds = ["obj-001", "obj-002"]) {
  const ctx = makeContext();
  bootstrapLoan(ctx.service, ctx.actors, { objectIds });
  packAndShip(ctx.service, ctx.actors, { objectIds });
  return ctx;
}

test("承借方按许可安排展陈轮换", () => {
  const { service, actors } = setupAtVenue();
  const result = service.rotateDisplay(actors.borrower, {
    loan_id: LOAN_ID,
    object_id: "obj-001",
    to_slot: "特展厅-展位A",
    license_id: "lic-01",
    at: "2026-09-06T09:00:00+08:00",
  });
  assert.equal(result.event.event_type, "DISPLAY_ROTATED");
});

test("许可外的藏品、用途与有效期都被拒绝", () => {
  const { service, actors } = setupAtVenue();
  // 许可未覆盖的藏品
  assert.throws(
    () =>
      service.rotateDisplay(actors.borrower, {
        loan_id: LOAN_ID,
        object_id: "obj-999",
        to_slot: "展位B",
        license_id: "lic-01",
        at: "2026-09-06T09:00:00+08:00",
      }),
    /不在许可范围/,
  );
  // 许可只允许 display/photo，未允许 video
  assert.throws(
    () =>
      service.logMediaUsage(actors.borrower, {
        loan_id: LOAN_ID,
        license_id: "lic-01",
        object_ids: ["obj-001"],
        use_type: "video",
        at: "2026-09-06T09:00:00+08:00",
      }),
    /不允许用途/,
  );
  // 许可有效期之外
  assert.throws(
    () =>
      service.rotateDisplay(actors.borrower, {
        loan_id: LOAN_ID,
        object_id: "obj-001",
        to_slot: "展位B",
        license_id: "lic-01",
        at: "2027-04-01T09:00:00+08:00",
      }),
    /不在有效期/,
  );
});

test("拍摄登记落在许可内则入账", () => {
  const { service, store, actors } = setupAtVenue();
  service.logMediaUsage(actors.borrower, {
    loan_id: LOAN_ID,
    license_id: "lic-01",
    object_ids: ["obj-001", "obj-002"],
    use_type: "photo",
    purpose: "展览图录",
    at: "2026-09-07T09:00:00+08:00",
  });
  assert.equal(store.ofType("MEDIA_USAGE_LOGGED").length, 1);
});
