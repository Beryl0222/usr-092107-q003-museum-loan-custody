import assert from "node:assert/strict";
import test from "node:test";

import * as proj from "../src/projections/index.js";
import { bootstrapLoan, LOAN_ID, makeContext } from "./helpers.js";

const OBJECTS = ["obj-001", "obj-002", "obj-003"];

function setup() {
  const ctx = makeContext();
  bootstrapLoan(ctx.service, ctx.actors, { objectIds: OBJECTS });
  ctx.service.assembleCase(ctx.actors.lender, {
    loan_id: LOAN_ID,
    case_id: "case-A",
    case_type: "outer",
    object_ids: [],
    at: "2026-09-01T09:00:00+08:00",
  });
  for (const id of OBJECTS) {
    ctx.service.packObject(ctx.actors.lender, {
      loan_id: LOAN_ID,
      object_id: id,
      case_id: "case-A",
      at: "2026-09-01T10:00:00+08:00",
    });
  }
  return ctx;
}

test("拆分须恰好划分原箱内容，拆分后每件藏品可追到具体箱件", () => {
  const { service, store, actors } = setup();
  service.splitCase(actors.lender, {
    loan_id: LOAN_ID,
    case_id: "case-A",
    into: [
      { case_id: "case-B", object_ids: ["obj-001", "obj-002"] },
      { case_id: "case-C", object_ids: ["obj-003"] },
    ],
    reason: "分车运输",
    at: "2026-09-02T09:00:00+08:00",
  });

  const { contents, location } = proj.caseContents(store);
  assert.deepEqual([...contents.get("case-A")], []);
  assert.deepEqual([...contents.get("case-B")].sort(), ["obj-001", "obj-002"]);
  assert.deepEqual([...contents.get("case-C")], ["obj-003"]);
  assert.equal(location.get("obj-003"), "case-C");

  const history = proj.caseMembershipHistory(store, "obj-003");
  assert.deepEqual(
    history.map((h) => h.case_id),
    ["case-A", "case-C"],
  );
});

test("拆分少分、多分或重复分配都会被拒绝", () => {
  const { service, actors } = setup();
  assert.throws(
    () =>
      service.splitCase(actors.lender, {
        loan_id: LOAN_ID,
        case_id: "case-A",
        into: [{ case_id: "case-B", object_ids: ["obj-001"] }],
        reason: "少分",
      }),
    /恰好划分/,
  );
  assert.throws(
    () =>
      service.splitCase(actors.lender, {
        loan_id: LOAN_ID,
        case_id: "case-A",
        into: [
          { case_id: "case-B", object_ids: ["obj-001", "obj-002", "obj-003"] },
          { case_id: "case-C", object_ids: ["obj-003"] },
        ],
        reason: "重复分配",
      }),
    /重复分配|不在原箱/,
  );
});

test("重组内容须等于来源之并集，重组后谱系仍可追", () => {
  const { service, store, actors } = setup();
  service.splitCase(actors.lender, {
    loan_id: LOAN_ID,
    case_id: "case-A",
    into: [
      { case_id: "case-B", object_ids: ["obj-001", "obj-002"] },
      { case_id: "case-C", object_ids: ["obj-003"] },
    ],
    reason: "分车运输",
    at: "2026-09-02T09:00:00+08:00",
  });
  assert.throws(
    () =>
      service.recombineCase(actors.lender, {
        loan_id: LOAN_ID,
        case_id: "case-D",
        from_case_ids: ["case-B", "case-C"],
        object_ids: ["obj-001", "obj-002"],
        reason: "少装",
      }),
    /并集/,
  );

  service.recombineCase(actors.lender, {
    loan_id: LOAN_ID,
    case_id: "case-D",
    from_case_ids: ["case-B", "case-C"],
    object_ids: ["obj-001", "obj-002", "obj-003"],
    reason: "合并装车",
    at: "2026-09-03T09:00:00+08:00",
  });
  const { contents, location } = proj.caseContents(store);
  assert.deepEqual([...contents.get("case-D")].sort(), OBJECTS);
  assert.equal(location.get("obj-001"), "case-D");
  assert.deepEqual(
    proj.caseMembershipHistory(store, "obj-001").map((h) => h.case_id),
    ["case-A", "case-B", "case-D"],
  );
});
