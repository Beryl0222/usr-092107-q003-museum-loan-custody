import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EventLog, LoanProjection, DomainError, environmentSeries, excursionRuns, reportDueExcursions } from "../src/model.js";

const A = {
  registrar: { person_id: "p-reg", name: "董籍", role: "REGISTRAR", org: "绩溪县博物馆" },
  lender: { person_id: "p-lc", name: "汪慎", role: "LENDER_CONSERVATOR", org: "绩溪县博物馆" },
  borrower: { person_id: "p-bc", name: "鲁岩", role: "BORROWER_CONSERVATOR", org: "山东某馆" },
  courier: { person_id: "p-co", name: "卢随", role: "COURIER", org: "绩溪县博物馆" },
  carrier: { person_id: "p-ca", name: "安途", role: "CARRIER", org: "安途文物运输" },
  curator: { person_id: "p-cu", name: "齐展", role: "CURATOR", org: "山东某馆" },
  photo: { person_id: "p-ph", name: "光影", role: "PHOTOGRAPHER", org: "山东某馆" },
  system: { person_id: "p-sys", name: "监测平台", role: "SYSTEM", org: "监测平台" },
};
const sig = (party, person) => ({ party, person_id: person.person_id, name: person.name });

function scenario(loanId = "L1") {
  const log = new EventLog();
  let n = 0;
  const put = (type, aggId, actor, payload, at, extra = {}) => {
    n += 1;
    return log.append({
      event_id: extra.event_id ?? `e-${n}`,
      event_type: type,
      aggregate_type: {
        LOAN_AGREED: "loan", OBJECT_REGISTERED: "collection_object", CONDITION_REPORTED: "collection_object",
        OBJECT_REMOVED_FROM_DISPLAY: "collection_object",
        OBJECT_PACKED: "shipping_case", OBJECT_UNPACKED: "shipping_case", CASE_RECOMPOSED: "shipping_case",
        CUSTODY_TRANSFERRED: "custody_handoff",
        THRESHOLD_SET: "environment_monitor", SENSOR_READING: "environment_monitor",
        EXCURSION_REPORTED: "risk_review", RISK_DECISION: "risk_review",
        ANOMALY_OPENED: "condition_anomaly", ANOMALY_NOTE: "condition_anomaly", ANOMALY_CLOSED: "condition_anomaly",
        EVACUATION_STARTED: "emergency_evacuation", EVACUATION_CONFIRMED: "emergency_evacuation",
        OBJECT_INSTALLED: "exhibition_slot",
        MEDIA_GRANTED: "media_grant", MEDIA_USAGE_LOGGED: "media_grant", MEDIA_REVOKED: "media_grant",
        INSURANCE_BOUND: "insurance_policy", CLAIM_FILED: "insurance_policy",
        RETURN_ACCEPTED: "return_acceptance", LOAN_CLOSED: "loan",
      }[type],
      aggregate_id: aggId,
      occurred_at: at ?? extra.at ?? "2026-09-20T10:00:00+08:00",
      version: log.nextVersion(aggId),
      summary: extra.summary ?? type,
      actor,
      payload,
      ...(extra.recorded_at ? { recorded_at: extra.recorded_at } : {}),
      ...(extra.idempotency_key ? { idempotency_key: extra.idempotency_key } : {}),
    });
  };
  const registerObject = (oid, n2 = 1) =>
    put("OBJECT_REGISTERED", oid, A.registrar, {
      loan_id: loanId, accession_no: `acc-${oid}`, name: oid, material: "木",
    }, "2026-09-19T10:00:00+08:00");
  return { log, put, registerObject, loanId };
}

const expectError = (code, fn) => {
  try {
    fn();
    assert.fail(`应当抛出 ${code}`);
  } catch (err) {
    assert.ok(err instanceof DomainError, `期望 DomainError，实际 ${err.constructor.name}: ${err.message}`);
    assert.equal(err.code, code);
  }
};

// ---------------------------------------------------------------------------

test("事件日志仅追加：版本严格递增、event_id 唯一、记录冻结", () => {
  const { log, put, registerObject } = scenario();
  registerObject("o1");
  put("CONDITION_REPORTED", "o1", A.lender, { loan_id: "L1", stage: "出库点交", signers: [sig("lender", A.lender)], findings: [] }, "2026-09-20T09:00:00+08:00");
  expectError("VERSION_CONFLICT", () =>
    log.append({
      event_id: "dup-version", event_type: "CONDITION_REPORTED", aggregate_type: "collection_object", aggregate_id: "o1",
      occurred_at: "2026-09-21T09:00:00+08:00", version: 1, summary: "旧版本号", actor: A.lender,
      payload: { loan_id: "L1", stage: "开箱检查", signers: [], findings: [] },
    }));
  expectError("DUPLICATE_EVENT", () =>
    log.append({
      event_id: "e-1", event_type: "CONDITION_REPORTED", aggregate_type: "collection_object", aggregate_id: "o1",
      occurred_at: "2026-09-25T09:00:00+08:00", version: 3, summary: "重放同一 event_id", actor: A.lender,
      payload: { loan_id: "L1", stage: "撤展", signers: [], findings: [] },
    }));

  const stored = log.byId("e-1");
  assert.ok(Object.isFrozen(stored));
  assert.throws(() => { stored.summary = "x"; }, TypeError);
});

test("更正只能追加 correction_of 后继记录，且必须指向存在的原记录", () => {
  const { log, put, registerObject } = scenario();
  registerObject("o1");
  expectError("ORIGINAL_NOT_FOUND", () =>
    log.append({
      event_id: "c1", event_type: "CONDITION_REPORTED", aggregate_type: "collection_object", aggregate_id: "o1",
      occurred_at: "2026-09-20T11:00:00+08:00", version: 2, summary: "更正", actor: A.lender, correction_of: "missing",
      payload: { loan_id: "L1", stage: "开箱检查", signers: [], findings: [] },
    }));
  put("CONDITION_REPORTED", "o1", A.lender, { loan_id: "L1", stage: "出库点交", signers: [sig("lender", A.lender)], findings: [{ code: "F1", area: "a", description: "原文", kind: "old_repair" }] }, "2026-09-20T09:00:00+08:00");
  // 后续补充不会改掉前一站记录
  const firstId = log.byAggregate("o1")[1].event_id;
  put("CONDITION_REPORTED", "o1", A.borrower, { loan_id: "L1", stage: "开箱检查", signers: [sig("borrower", A.borrower)], findings: [{ code: "F2", area: "b", description: "新发现", kind: "new_damage", severity: "minor" }] }, "2026-09-23T09:00:00+08:00", {});
  const first = log.byId(firstId);
  assert.deepEqual(first.payload.findings.map((f) => f.code), ["F1"]);
  assert.equal(first.payload.findings[0].description, "原文");
});

test("同一交接单/数据包重复上传不产生第二条记录", () => {
  const { log, put, registerObject } = scenario();
  registerObject("o1");
  const payload = () => ({
    loan_id: "L1", handoff_no: "H01", stage: "装车发运", from_party: "甲", to_party: "乙",
    case_nos: [], object_ids: ["o1"], signers: [sig("lender", A.registrar)],
  });
  put("CUSTODY_TRANSFERRED", "h1", A.registrar, payload(), "2026-09-20T17:00:00+08:00", { idempotency_key: "H01" });
  const size = log.size;
  const retry = log.ingest({
    event_id: "foreign-retry", event_type: "CUSTODY_TRANSFERRED", aggregate_type: "custody_handoff", aggregate_id: "h1",
    occurred_at: "2026-09-20T17:00:00+08:00", version: 99, summary: "网络重试", actor: A.carrier, idempotency_key: "H01", payload: payload(),
  });
  assert.equal(retry.status, "duplicate");
  assert.equal(log.size, size);
});

test("断网补报按采集时刻归位；Z 与 +08:00 同一瞬时去重；补报本身不算事故", () => {
  const { log, put } = scenario();
  put("THRESHOLD_SET", "m1", A.lender, { loan_id: "L1", scope: { kind: "zone", ref: "z1" }, metric: "temperature", unit: "C", min: 15, max: 25 }, "2026-09-20T17:00:00+08:00");
  // 采集在 09-21，接收在 09-24（断网补报）；两种时区写法
  put("SENSOR_READING", "m1", A.system, {
    loan_id: "L1", sensor_id: "s1", readings: [
      { metric: "temperature", value: 22.0, unit: "C", observed_at: "2026-09-21T02:00:00Z" },
      { metric: "temperature", value: 22.0, unit: "C", observed_at: "2026-09-21T10:00:00+08:00" },
    ],
  }, "2026-09-24T08:00:00+08:00", { recorded_at: "2026-09-24T08:00:00+08:00", idempotency_key: "batch-1" });
  const series = environmentSeries(log).find((s) => s.monitor_id === "m1");
  assert.equal(series.readings.length, 1, "同一瞬时两种写法只计一次");
  assert.equal(series.readings[0].recorded_epoch - series.readings[0].observed_epoch > 0, true, "记录接收时间晚于采集时间");
  assert.deepEqual(excursionRuns(log), [], "22℃ 在阈值内，补报不产生任何风险/事故");
});

test("超阈值只生成待研判风险，且重复扫描不重复建单", () => {
  const { log, put } = scenario();
  put("THRESHOLD_SET", "m1", A.lender, { loan_id: "L1", scope: { kind: "zone", ref: "z1" }, metric: "relative_humidity", unit: "%RH", min: 45, max: 60 }, "2026-09-20T17:00:00+08:00");
  put("SENSOR_READING", "m1", A.system, {
    loan_id: "L1", sensor_id: "s1", readings: [
      { metric: "relative_humidity", value: 55, unit: "%RH", observed_at: "2026-09-21T01:00:00Z" },
      { metric: "relative_humidity", value: 63, unit: "%RH", observed_at: "2026-09-21T02:00:00Z" },
      { metric: "relative_humidity", value: 64, unit: "%RH", observed_at: "2026-09-21T03:00:00Z" },
      { metric: "relative_humidity", value: 56, unit: "%RH", observed_at: "2026-09-21T04:00:00Z" },
    ],
  }, "2026-09-21T05:00:00Z");
  const runs = excursionRuns(log);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].peak_value, 64);
  const first = reportDueExcursions(log, A.system, "L1");
  assert.equal(first.length, 1);
  assert.equal(first[0].payload.status, "pending_review");
  assert.equal(reportDueExcursions(log, A.system, "L1").length, 0, "再次扫描不重复建单");
});

test("撤展只能由有权限的文保人员研判后执行", () => {
  const { log, put, registerObject } = scenario();
  registerObject("o1");
  put("THRESHOLD_SET", "m1", A.lender, { loan_id: "L1", scope: { kind: "object", ref: "o1" }, metric: "temperature", unit: "C", min: 15, max: 25 }, "2026-09-26T09:00:00+08:00");
  put("SENSOR_READING", "m1", A.system, { loan_id: "L1", sensor_id: "s", readings: [{ metric: "temperature", value: 30, unit: "C", observed_at: "2026-10-02T13:00:00+08:00" }] }, "2026-10-02T13:05:00+08:00");
  const [risk] = reportDueExcursions(log, A.system, "L1");

  // 摄影师/策展人无权研判
  expectError("FORBIDDEN", () =>
    put("RISK_DECISION", risk.aggregate_id, A.photo, { decision: "remove_from_display", decided_by: A.photo, rationale: "x" }, "2026-10-02T14:00:00+08:00"));
  // 无研判结论不得撤展
  expectError("NO_REMOVAL_AUTHORIZATION", () =>
    put("OBJECT_REMOVED_FROM_DISPLAY", "o1", A.curator, { loan_id: "L1", slot_id: "s1", reason: "risk_decision" }, "2026-10-02T14:10:00+08:00"));
  // 无 EXCURSION 的凭空研判不允许
  expectError("RISK_WITHOUT_EXCURSION", () =>
    put("RISK_DECISION", "risk-ghost", A.lender, { decision: "remove_from_display", decided_by: A.lender, rationale: "x" }, "2026-10-02T14:20:00+08:00"));

  // 承借方文保人员研判撤出
  put("RISK_DECISION", risk.aggregate_id, A.borrower, { decision: "remove_from_display", decided_by: A.borrower, rationale: "空调故障升温" }, "2026-10-02T14:30:00+08:00");
  // 同一风险不可重复研判
  expectError("RISK_ALREADY_DECIDED", () =>
    put("RISK_DECISION", risk.aggregate_id, A.lender, { decision: "keep_monitoring", decided_by: A.lender, rationale: "改主意" }, "2026-10-02T14:40:00+08:00"));
  const removed = put("OBJECT_REMOVED_FROM_DISPLAY", "o1", A.borrower, { loan_id: "L1", slot_id: "s1", reason: "risk_decision", risk_review_id: risk.aggregate_id }, "2026-10-02T15:00:00+08:00");
  assert.equal(removed.event_type, "OBJECT_REMOVED_FROM_DISPLAY");
});

test("紧急转移先保护实物，后补双人确认，且确认人不得是发起人", () => {
  const { log, put } = scenario();
  // 未发起先确认不允许
  expectError("EVACUATION_NOT_STARTED", () =>
    put("EVACUATION_CONFIRMED", "ev1", A.lender, { second_person: A.lender, to_location: "内库" }, "2026-10-08T08:00:00+08:00"));
  put("EVACUATION_STARTED", "ev1", A.borrower, {
    loan_id: "L1", object_ids: ["o1"], from_location: "展厅", reason: "漏水", immediate_action: "连同内匣抱入内库",
  }, "2026-10-08T02:14:00+08:00");
  expectError("SAME_PERSON_CONFIRMATION", () =>
    put("EVACUATION_CONFIRMED", "ev1", A.borrower, { second_person: A.borrower, to_location: "内库" }, "2026-10-08T08:30:00+08:00"));
  put("EVACUATION_CONFIRMED", "ev1", A.lender, { second_person: A.lender, to_location: "二层内库 B-12" }, "2026-10-08T08:30:00+08:00");
  expectError("EVACUATION_ALREADY_CONFIRMED", () =>
    put("EVACUATION_CONFIRMED", "ev1", A.borrower, { second_person: A.borrower, to_location: "内库" }, "2026-10-08T09:00:00+08:00"));

  const proj = new LoanProjection(log, "L1");
  assert.deepEqual(proj.openIssues().evacuations_awaiting_second_confirmation, []);
});

test("箱件拆分与重新组合始终可追到具体藏品", () => {
  const { log, put, registerObject } = scenario();
  for (let i = 1; i <= 6; i += 1) registerObject(`o${i}`);
  put("OBJECT_PACKED", "c1", A.courier, { loan_id: "L1", case_no: "c1", package_level: "外箱", object_ids: ["o1", "o2", "o3", "o4", "o5", "o6"], seal_no: "s-1" }, "2026-09-20T15:00:00+08:00");
  put("CASE_RECOMPOSED", "c2", A.borrower, { loan_id: "L1", case_no: "c2", action: "split", source_case_nos: ["c1"], object_ids: ["o5", "o6"], seal_no: "s-2", note: "货梯限界" }, "2026-09-22T14:00:00+08:00");
  let proj = new LoanProjection(log, "L1");
  let state = proj.caseContainment(Date.parse("2026-09-22T15:00:00+08:00"));
  assert.equal(state.current.get("o5"), "c2");
  assert.equal(state.current.get("o1"), "c1");
  // o1–o4 开箱，o5/o6 仍在 c2
  put("OBJECT_UNPACKED", "c1", A.borrower, { loan_id: "L1", case_no: "c1", object_ids: ["o1", "o2", "o3", "o4"], stage: "开箱检查" }, "2026-09-23T09:00:00+08:00");
  proj = new LoanProjection(log, "L1");
  state = proj.caseContainment();
  assert.equal(state.current.get("o1"), null);
  assert.equal(state.current.get("o5"), "c2");
  // 回运并箱
  put("OBJECT_UNPACKED", "c2", A.borrower, { loan_id: "L1", case_no: "c2", object_ids: ["o5", "o6"], stage: "撤展" }, "2026-10-18T10:00:00+08:00");
  put("CASE_RECOMPOSED", "c1", A.courier, { loan_id: "L1", case_no: "c1", action: "merge", source_case_nos: ["c1", "c2"], object_ids: ["o1", "o2", "o3", "o4", "o5", "o6"], seal_no: "s-3" }, "2026-10-18T15:00:00+08:00");
  state = new LoanProjection(log, "L1").caseContainment();
  assert.deepEqual(["o1", "o2", "o3", "o4", "o5", "o6"].map((o) => state.current.get(o)), Array(6).fill("c1"));
});

test("图文视频使用受许可媒介、用途、期限、撤销约束", () => {
  const { log, put } = scenario();
  const grant = () => ({
    loan_id: "L1", object_ids: ["o1"], media_types: ["photo"], purposes: ["展览图录"],
    valid_from: "2026-09-24T00:00:00+08:00", valid_to: "2026-10-20T17:00:00+08:00", granted_by: A.lender.person_id,
  });
  const use = (over = {}) => put("MEDIA_USAGE_LOGGED", "mg1", A.photo, {
    loan_id: "L1", object_ids: ["o1"], media_type: "photo", purpose: "展览图录",
    used_at: "2026-09-28T10:00:00+08:00", used_by: A.photo.person_id, ...over,
  }, over.used_at ?? "2026-09-28T10:00:00+08:00");
  expectError("NO_MEDIA_GRANT", () => use());
  put("MEDIA_GRANTED", "mg1", A.lender, grant(), "2026-09-24T12:00:00+08:00");
  assert.equal(use().event_type, "MEDIA_USAGE_LOGGED");
  expectError("MEDIA_TYPE_NOT_LICENSED", () => use({ media_type: "video" }));
  expectError("MEDIA_PURPOSE_NOT_LICENSED", () => use({ purpose: "商业广告" }));
  expectError("MEDIA_OBJECT_NOT_LICENSED", () => use({ object_ids: ["o2"] }));
  expectError("MEDIA_OUTSIDE_WINDOW", () => use({ used_at: "2026-11-01T10:00:00+08:00" }));
  put("MEDIA_REVOKED", "mg1", A.registrar, { reason: "撤展" }, "2026-10-10T10:00:00+08:00");
  expectError("MEDIA_GRANT_REVOKED", () => use({ used_at: "2026-10-11T10:00:00+08:00" }));
});

test("保险理赔必须在保单清单与保障期内并关联已立案异常", () => {
  const { log, put, registerObject } = scenario();
  registerObject("o1");
  expectError("NO_POLICY", () =>
    put("CLAIM_FILED", "pol1", A.registrar, { loan_id: "L1", claim_no: "c", anomaly_id: "a1", object_id: "o1", amount: 1 }, "2026-09-25T00:00:00+08:00"));
  put("INSURANCE_BOUND", "pol1", A.registrar, {
    loan_id: "L1", policy_no: "P1", insurer: "保司", object_ids: ["o1"], coverage_total: 1000, currency: "CNY",
    valid_from: "2026-09-20T00:00:00+08:00", valid_to: "2026-10-20T23:59:00+08:00",
  }, "2026-09-18T00:00:00+08:00");
  expectError("ANOMALY_NOT_OPENED", () =>
    put("CLAIM_FILED", "pol1", A.registrar, { loan_id: "L1", claim_no: "c", anomaly_id: "a1", object_id: "o1", amount: 1 }, "2026-09-25T00:00:00+08:00"));
  put("ANOMALY_OPENED", "a1", A.borrower, { loan_id: "L1", title: "裂", category: "damage", severity: "minor", object_id: "o1" }, "2026-09-23T16:00:00+08:00");
  expectError("OBJECT_NOT_INSURED", () =>
    put("CLAIM_FILED", "pol1", A.registrar, { loan_id: "L1", claim_no: "c", anomaly_id: "a1", object_id: "oX", amount: 1 }, "2026-09-25T00:00:00+08:00"));
  expectError("OUTSIDE_COVERAGE_PERIOD", () =>
    put("CLAIM_FILED", "pol1", A.registrar, { loan_id: "L1", claim_no: "c", anomaly_id: "a1", object_id: "o1", amount: 1 }, "2026-11-01T00:00:00+08:00"));
  assert.equal(put("CLAIM_FILED", "pol1", A.registrar, { loan_id: "L1", claim_no: "CL-1", anomaly_id: "a1", object_id: "o1", amount: 8000, currency: "CNY" }, "2026-09-25T00:00:00+08:00").event_type, "CLAIM_FILED");
});

test("返还验收：双方会签、新差异逐条确认；数量不符不得关账", () => {
  const { log, put, registerObject } = scenario();
  registerObject("o1");
  registerObject("o2");
  const acceptance = (over = {}) => put("RETURN_ACCEPTED", "rt1", A.registrar, {
    loan_id: "L1", acceptance_no: "RT",
    object_results: [
      { object_id: "o1", accepted: true, condition_vs_baseline: "new_discrepancy" },
      { object_id: "o2", accepted: true, condition_vs_baseline: "match" },
    ],
    signers: [sig("lender", A.lender), sig("borrower", A.borrower)],
    ...over,
  }, "2026-10-20T16:00:00+08:00");
  expectError("DISCREPANCY_UNACKNOWLEDGED", () => acceptance());
  expectError("BOTH_PARTIES_REQUIRED", () => acceptance({
    acknowledged_discrepancies: [{ object_id: "o1", anomaly_id: "a1", note: "确认" }],
    signers: [sig("borrower", A.borrower)],
  }));
  acceptance({ acknowledged_discrepancies: [{ object_id: "o1", anomaly_id: "a1", note: "双方确认" }] });
  expectError("COUNT_MISMATCH", () =>
    put("LOAN_CLOSED", "L1", A.registrar, { returned_object_count: 1 }, "2026-10-20T17:00:00+08:00"));
  put("LOAN_CLOSED", "L1", A.registrar, { returned_object_count: 2 }, "2026-10-20T17:00:00+08:00");
});

test("异常必须先立案再补充/关闭，且只能关闭一次", () => {
  const { log, put } = scenario();
  expectError("ANOMALY_NOT_OPENED", () =>
    put("ANOMALY_NOTE", "a1", A.borrower, { note: "x" }, "2026-09-23T17:00:00+08:00"));
  put("ANOMALY_OPENED", "a1", A.borrower, { loan_id: "L1", title: "封签异常", category: "seal", severity: "minor" }, "2026-09-23T16:30:00+08:00");
  put("ANOMALY_NOTE", "a1", A.lender, { note: "复核封签编号一致" }, "2026-09-24T09:00:00+08:00");
  put("ANOMALY_CLOSED", "a1", A.lender, { resolution: "虚惊", signers: [sig("lender", A.lender)] }, "2026-09-24T10:00:00+08:00");
  expectError("ANOMALY_ALREADY_CLOSED", () =>
    put("ANOMALY_CLOSED", "a1", A.borrower, { resolution: "再关一次", signers: [sig("borrower", A.borrower)] }, "2026-10-08T09:00:00+08:00"));
});

test("全流程事件流可整体重放，保管链、未闭合事项与损伤回看一致", async () => {
  const events = JSON.parse(await readFile(new URL("../data/lifecycle.json", import.meta.url), "utf8"));
  const log = new EventLog();
  for (const e of events) log.append(e);
  assert.equal(log.size, events.length);

  const proj = new LoanProjection(log, "loan-jx-sd-2026");
  assert.equal(proj.objects().length, 51);

  const { handoffs, currentHolder } = proj.custodyChain();
  assert.deepEqual(handoffs.map((h) => h.handoff_no), ["H01", "H02", "H03", "H04"]);
  assert.equal(currentHolder.get("obj-001"), "绩溪县博物馆");

  const issues = proj.openIssues();
  assert.deepEqual(issues, { anomalies_open: [], evacuations_awaiting_second_confirmation: [], risks_pending_decision: [] });

  const trace = proj.damageTrace("obj-001", "F001-edge-crack", 72 * 3600_000);
  assert.equal(trace.found, true);
  assert.equal(trace.first_seen.stage, "开箱检查");
  assert.equal(trace.case_at_time, "case-A");
  assert.equal(trace.case_status_at_time, "unpacked");
  assert.equal(trace.last_handoff_before_discovery.handoff_no, "H02");
  assert.ok(trace.environment_curves.some((c) => c.metric === "relative_humidity" && c.readings.length >= 3));

  const acceptance = proj.returnAcceptance();
  assert.equal(acceptance.object_results.length, 51);
  assert.equal(acceptance.object_results.filter((r) => r.accepted).length, 51);

  const { claims } = proj.insurance();
  assert.equal(claims.length, 1);
  assert.equal(claims[0].anomaly_id, "anomaly-001");

  const grants = proj.mediaGrants();
  assert.equal(grants.get("media-001").usages.length, 1);
});
