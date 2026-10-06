import assert from "node:assert/strict";
import test from "node:test";

import { buildServer } from "../src/http/server.js";

async function withServer(fn) {
  const server = buildServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const registrar = { id: "reg-01", role: "registrar", org: "jixi-museum" };

test("HTTP：命令端点与只读端点", async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    assert.equal(health.status, "ok");

    const created = await fetch(`${base}/commands/registerLoan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: registrar,
        loan_id: "loan-http-1",
        lender_org: "jixi-museum",
        borrower_org: "shandong-museum",
        object_ids: ["obj-1"],
        period: { start: "2026-09-01T00:00:00+08:00", end: "2027-03-01T00:00:00+08:00" },
        venue: "山东博物馆",
        decision_makers: ["wen-lead"],
      }),
    }).then((r) => r.json());
    assert.equal(created.event.event_type, "LOAN_REGISTERED");

    const open = await fetch(`${base}/loans/loan-http-1/open-items`).then((r) => r.json());
    assert.deepEqual(open, { exceptions: [], pending_risks: [] });

    const unknown = await fetch(`${base}/commands/notACommand`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: registrar }),
    });
    assert.equal(unknown.status, 404);
  });
});

test("HTTP：权限错误映射为 403", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/commands/registerLoan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: { id: "yun-01", role: "carrier", org: "anyun-logistics" },
        loan_id: "loan-http-2",
        lender_org: "jixi-museum",
        borrower_org: "shandong-museum",
        object_ids: [],
        period: { start: "2026-09-01T00:00:00+08:00", end: "2027-03-01T00:00:00+08:00" },
        venue: "山东博物馆",
        decision_makers: [],
      }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, "PERMISSION");
  });
});
