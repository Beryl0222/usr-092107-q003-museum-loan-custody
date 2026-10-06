// 事件类型 -> 所属聚合，以及该类型 payload 的最小必填字段。
// 跨机构交换时只约定这些最小字段；其余字段允许在各自系统内扩展。
export const EVENT_AGGREGATE = {
  LOAN_AGREED: "loan",
  EXHIBITION_OPENED: "loan",
  LOAN_CLOSED: "loan",
  OBJECT_REGISTERED: "collection_object",
  CONDITION_REPORTED: "collection_object",
  OBJECT_REMOVED_FROM_DISPLAY: "collection_object",
  OBJECT_PACKED: "shipping_case",
  OBJECT_UNPACKED: "shipping_case",
  CASE_RECOMPOSED: "shipping_case",
  CUSTODY_TRANSFERRED: "custody_handoff",
  THRESHOLD_SET: "environment_monitor",
  SENSOR_READING: "environment_monitor",
  EXCURSION_REPORTED: "risk_review",
  RISK_DECISION: "risk_review",
  ANOMALY_OPENED: "condition_anomaly",
  ANOMALY_NOTE: "condition_anomaly",
  ANOMALY_CLOSED: "condition_anomaly",
  EVACUATION_STARTED: "emergency_evacuation",
  EVACUATION_CONFIRMED: "emergency_evacuation",
  OBJECT_INSTALLED: "exhibition_slot",
  SLOT_ROTATED: "exhibition_slot",
  MEDIA_GRANTED: "media_grant",
  MEDIA_USAGE_LOGGED: "media_grant",
  MEDIA_REVOKED: "media_grant",
  INSURANCE_BOUND: "insurance_policy",
  CLAIM_FILED: "insurance_policy",
  RETURN_ACCEPTED: "return_acceptance",
};

export const PAYLOAD_REQUIRED = {
  LOAN_AGREED: ["lender", "borrower", "object_count", "period", "venues"],
  EXHIBITION_OPENED: ["venue"],
  LOAN_CLOSED: ["returned_object_count"],
  OBJECT_REGISTERED: ["loan_id", "accession_no", "name", "material"],
  CONDITION_REPORTED: ["loan_id", "stage", "signers", "findings"],
  OBJECT_REMOVED_FROM_DISPLAY: ["loan_id", "slot_id", "reason"],
  OBJECT_PACKED: ["loan_id", "case_no", "package_level", "object_ids"],
  OBJECT_UNPACKED: ["loan_id", "case_no", "object_ids", "stage"],
  CASE_RECOMPOSED: ["loan_id", "case_no", "action", "object_ids"],
  CUSTODY_TRANSFERRED: ["loan_id", "handoff_no", "stage", "from_party", "to_party", "signers"],
  THRESHOLD_SET: ["loan_id", "scope", "metric", "unit"],
  SENSOR_READING: ["sensor_id", "readings"],
  EXCURSION_REPORTED: ["loan_id", "monitor_id", "metric", "status"],
  RISK_DECISION: ["decision", "decided_by", "rationale"],
  ANOMALY_OPENED: ["loan_id", "title", "category", "severity"],
  ANOMALY_NOTE: ["note"],
  ANOMALY_CLOSED: ["resolution", "signers"],
  EVACUATION_STARTED: ["loan_id", "object_ids", "from_location", "immediate_action"],
  EVACUATION_CONFIRMED: ["second_person", "to_location"],
  OBJECT_INSTALLED: ["loan_id", "slot_no", "venue", "object_ids"],
  SLOT_ROTATED: ["loan_id", "slot_no"],
  MEDIA_GRANTED: ["loan_id", "object_ids", "media_types", "purposes", "valid_from", "valid_to", "granted_by"],
  MEDIA_USAGE_LOGGED: ["loan_id", "object_ids", "media_type", "purpose", "used_at", "used_by"],
  MEDIA_REVOKED: ["reason"],
  INSURANCE_BOUND: ["loan_id", "policy_no", "insurer", "object_ids", "coverage_total", "currency", "valid_from", "valid_to"],
  CLAIM_FILED: ["loan_id", "claim_no", "anomaly_id", "object_id", "amount"],
  RETURN_ACCEPTED: ["loan_id", "acceptance_no", "object_results", "signers"],
};

const ENVELOPE_FIELDS = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "recorded_at",
  "version",
  "summary",
  "actor",
  "idempotency_key",
  "correction_of",
  "payload",
];

const ROLES = new Set([
  "LENDER_CONSERVATOR",
  "BORROWER_CONSERVATOR",
  "COURIER",
  "CARRIER",
  "REGISTRAR",
  "CURATOR",
  "PHOTOGRAPHER",
  "INSURANCE_AUDITOR",
  "SYSTEM",
  "ADMIN",
]);

// RFC 3339：必须带时区偏移（Z 或 ±HH:MM），拒绝无时区的“裸本地时间”。
// 返回 { epochMs, offsetMin } 或 null。
export function parseTimestamp(value) {
  if (typeof value !== "string") return null;
  const m = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac = "0", zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31 || h > 23 || mi > 59 || s > 60) return null;
  let offsetMin = 0;
  if (zone !== "Z" && zone !== "z") {
    const sign = zone[0] === "+" ? 1 : -1;
    offsetMin = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  }
  const asUtc = Date.UTC(year, month - 1, day, h, mi, s, Number(`0.${frac}`) * 1000);
  if (Number.isNaN(asUtc)) return null;
  return { epochMs: asUtc - offsetMin * 60_000, offsetMin };
}

export function validateTimestamp(value, field = "occurred_at") {
  const parsed = parseTimestamp(value);
  if (!parsed) return [`${field} 必须是带时区偏移的 RFC3339 时间（如 2026-09-20T18:00:00+08:00）`];
  return [];
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// 单条事件信封的结构校验。跨聚合的业务不变量（版本连续、权限、去重等）在 EventLog 中校验。
export function validateEvent(record) {
  const errors = [];
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return ["事件必须是对象"];
  }

  for (const name of ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary", "actor", "payload"]) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  for (const key of Object.keys(record)) {
    if (!ENVELOPE_FIELDS.includes(key)) errors.push(`未知信封字段：${key}`);
  }
  if (errors.some((m) => m.startsWith("缺少字段"))) return errors;

  if (!isNonEmptyString(record.event_id)) errors.push("event_id 不能为空");
  if (!isNonEmptyString(record.aggregate_id)) errors.push("aggregate_id 不能为空");
  if (!isNonEmptyString(record.summary)) errors.push("summary 不能为空");
  if (!Number.isInteger(record.version) || record.version < 1) errors.push("version 必须是正整数");
  errors.push(...validateTimestamp(record.occurred_at, "occurred_at"));
  if ("recorded_at" in record) errors.push(...validateTimestamp(record.recorded_at, "recorded_at"));

  const expectedAggregate = EVENT_AGGREGATE[record.event_type];
  if (!expectedAggregate) {
    errors.push(`未知事件类型：${record.event_type}`);
  } else if (record.aggregate_type !== expectedAggregate) {
    errors.push(`${record.event_type} 的 aggregate_type 必须是 ${expectedAggregate}，实际为 ${record.aggregate_type}`);
  }

  const actor = record.actor;
  if (actor === null || typeof actor !== "object" || Array.isArray(actor)) {
    errors.push("actor 必须是对象");
  } else {
    for (const name of ["person_id", "name", "role", "org"]) {
      if (!isNonEmptyString(actor[name])) errors.push(`actor.${name} 不能为空`);
    }
    if (actor.role && !ROLES.has(actor.role)) errors.push(`actor.role 不在角色目录内：${actor.role}`);
  }

  const payload = record.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    errors.push("payload 必须是对象");
    return errors;
  }

  const required = PAYLOAD_REQUIRED[record.event_type] ?? [];
  for (const name of required) {
    if (!(name in payload)) errors.push(`payload 缺少字段：${name}`);
  }

  if (record.event_type === "SENSOR_READING") {
    const readings = payload.readings;
    if (Array.isArray(readings)) {
      if (readings.length === 0) errors.push("payload.readings 至少包含一条读数");
      readings.forEach((r, i) => {
        if (!r || typeof r !== "object") return errors.push(`readings[${i}] 必须是对象`);
        if (!isNonEmptyString(r.metric)) errors.push(`readings[${i}].metric 不能为空`);
        if (typeof r.value !== "number") errors.push(`readings[${i}].value 必须是数字`);
        errors.push(...validateTimestamp(r.observed_at, `readings[${i}].observed_at`));
      });
    }
  }

  return errors;
}
