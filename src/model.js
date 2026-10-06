// 借展护送后端核心：仅追加事件日志 + 业务投影。
// 事件是唯一事实来源；任何“当前状态”都由事件流重放得到，不就地修改历史。
import { EVENT_AGGREGATE, validateEvent, parseTimestamp } from "./event-types.js";

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

const ts = (v) => parseTimestamp(v)?.epochMs;

// 对外返回的事件是只读视图：递归冻结，避免调用方误改历史。
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const v of Object.values(value)) deepFreeze(v);
  return Object.freeze(value);
}

// 各事件类型允许的提交角色。撤展研判等敏感动作在此收口。
const ROLE_MATRIX = {
  LOAN_AGREED: ["REGISTRAR", "ADMIN"],
  EXHIBITION_OPENED: ["REGISTRAR", "CURATOR", "ADMIN"],
  LOAN_CLOSED: ["REGISTRAR", "ADMIN"],
  OBJECT_REGISTERED: ["REGISTRAR", "LENDER_CONSERVATOR"],
  CONDITION_REPORTED: ["LENDER_CONSERVATOR", "BORROWER_CONSERVATOR", "COURIER"],
  OBJECT_REMOVED_FROM_DISPLAY: ["LENDER_CONSERVATOR", "BORROWER_CONSERVATOR", "REGISTRAR", "CURATOR"],
  OBJECT_PACKED: ["REGISTRAR", "COURIER", "LENDER_CONSERVATOR"],
  OBJECT_UNPACKED: ["REGISTRAR", "COURIER", "BORROWER_CONSERVATOR"],
  CASE_RECOMPOSED: ["REGISTRAR", "COURIER", "LENDER_CONSERVATOR", "BORROWER_CONSERVATOR"],
  CUSTODY_TRANSFERRED: ["REGISTRAR", "COURIER", "CARRIER", "LENDER_CONSERVATOR", "BORROWER_CONSERVATOR"],
  THRESHOLD_SET: ["LENDER_CONSERVATOR", "BORROWER_CONSERVATOR"],
  SENSOR_READING: ["SYSTEM"],
  EXCURSION_REPORTED: ["SYSTEM"],
  RISK_DECISION: ["LENDER_CONSERVATOR", "BORROWER_CONSERVATOR"],
  ANOMALY_OPENED: ["LENDER_CONSERVATOR", "BORROWER_CONSERVATOR", "REGISTRAR", "COURIER"],
  ANOMALY_NOTE: ["LENDER_CONSERVATOR", "BORROWER_CONSERVATOR", "REGISTRAR", "COURIER"],
  ANOMALY_CLOSED: ["LENDER_CONSERVATOR", "BORROWER_CONSERVATOR", "REGISTRAR"],
  EVACUATION_STARTED: ["LENDER_CONSERVATOR", "BORROWER_CONSERVATOR", "REGISTRAR"],
  EVACUATION_CONFIRMED: ["LENDER_CONSERVATOR", "BORROWER_CONSERVATOR", "REGISTRAR"],
  OBJECT_INSTALLED: ["CURATOR", "REGISTRAR", "BORROWER_CONSERVATOR"],
  SLOT_ROTATED: ["CURATOR", "REGISTRAR"],
  MEDIA_GRANTED: ["REGISTRAR", "LENDER_CONSERVATOR", "ADMIN"],
  MEDIA_USAGE_LOGGED: ["PHOTOGRAPHER", "CURATOR", "REGISTRAR"],
  MEDIA_REVOKED: ["REGISTRAR", "LENDER_CONSERVATOR", "ADMIN"],
  INSURANCE_BOUND: ["REGISTRAR", "ADMIN"],
  CLAIM_FILED: ["REGISTRAR", "INSURANCE_AUDITOR"],
  RETURN_ACCEPTED: ["REGISTRAR", "LENDER_CONSERVATOR", "BORROWER_CONSERVATOR"],
};

export class EventLog {
  constructor() {
    /** @type {object[]} 仅追加、冻结保存 */
    this._events = [];
    this._byId = new Map();
    this._versions = new Map(); // aggregate_id -> 最新版本
    this._idempotency = new Map(); // aggregate_id|key -> event_id
  }

  get size() {
    return this._events.length;
  }

  all() {
    return this._events.map((e) => deepFreeze(structuredClone(e)));
  }

  byId(eventId) {
    const e = this._byId.get(eventId);
    return e ? deepFreeze(structuredClone(e)) : undefined;
  }

  byAggregate(aggregateId) {
    return this._events.filter((e) => e.aggregate_id === aggregateId).map((e) => deepFreeze(structuredClone(e)));
  }

  nextVersion(aggregateId) {
    return (this._versions.get(aggregateId) ?? 0) + 1;
  }

  // 严格追加：结构、版本序列、角色、跨事件业务规则全部通过才入库。
  append(input) {
    const event = structuredClone(input);
    const structural = validateEvent(event);
    if (structural.length) throw new DomainError("INVALID_EVENT", structural.join("；"));

    if (this._byId.has(event.event_id)) {
      throw new DomainError("DUPLICATE_EVENT", `event_id 已存在：${event.event_id}（事件不可重复入库）`);
    }
    if (event.idempotency_key) {
      const seen = this._idempotency.get(`${event.aggregate_id}|${event.idempotency_key}`);
      if (seen) throw new DomainError("DUPLICATE_UPLOAD", `同一交接/上报已接收过（${seen}），幂等键：${event.idempotency_key}`);
    }

    const expectedVersion = this.nextVersion(event.aggregate_id);
    if (event.version !== expectedVersion) {
      throw new DomainError(
        "VERSION_CONFLICT",
        `${event.aggregate_id} 下一版本应为 ${expectedVersion}，收到 ${event.version}`
      );
    }

    const allowed = ROLE_MATRIX[event.event_type];
    if (allowed && !allowed.includes(event.actor.role)) {
      throw new DomainError("FORBIDDEN", `${event.actor.role} 无权提交 ${event.event_type}`);
    }

    if (event.correction_of && !this._byId.has(event.correction_of)) {
      throw new DomainError("ORIGINAL_NOT_FOUND", `correction_of 指向的记录不存在：${event.correction_of}`);
    }

    this._checkStatefulRules(event);

    Object.freeze(event);
    Object.freeze(event.payload);
    this._events.push(event);
    this._byId.set(event.event_id, event);
    this._versions.set(event.aggregate_id, event.version);
    if (event.idempotency_key) {
      this._idempotency.set(`${event.aggregate_id}|${event.idempotency_key}`, event.event_id);
    }
    return structuredClone(event);
  }

  // 面向外部系统重复上传：重复不报错、不产生任何副作用，原样返回已入库记录。
  ingest(input) {
    const existingById = this._byId.get(input?.event_id);
    if (existingById) return { status: "duplicate", reason: "event_id", event: structuredClone(existingById) };
    if (input?.aggregate_id && input?.idempotency_key) {
      const seenId = this._idempotency.get(`${input.aggregate_id}|${input.idempotency_key}`);
      if (seenId) return { status: "duplicate", reason: "idempotency_key", event: structuredClone(this._byId.get(seenId)) };
    }
    return { status: "appended", event: this.append(input) };
  }

  _eventsOfType(aggregateId, ...types) {
    return this._events.filter((e) => e.aggregate_id === aggregateId && types.includes(e.event_type));
  }

  _checkStatefulRules(event) {
    const p = event.payload;
    switch (event.event_type) {
      case "RISK_DECISION": {
        const report = this._eventsOfType(event.aggregate_id, "EXCURSION_REPORTED")[0];
        if (!report) throw new DomainError("RISK_WITHOUT_EXCURSION", "研判必须针对一条已登记的阈值风险");
        if (this._eventsOfType(event.aggregate_id, "RISK_DECISION").length) {
          throw new DomainError("RISK_ALREADY_DECIDED", "该风险已有研判结论，更正请追加后继记录");
        }
        break;
      }
      case "ANOMALY_NOTE":
      case "ANOMALY_CLOSED": {
        const opened = this._eventsOfType(event.aggregate_id, "ANOMALY_OPENED")[0];
        if (!opened) throw new DomainError("ANOMALY_NOT_OPENED", "异常尚未立案，不能补充或关闭");
        if (event.event_type === "ANOMALY_CLOSED" && this._eventsOfType(event.aggregate_id, "ANOMALY_CLOSED").length) {
          throw new DomainError("ANOMALY_ALREADY_CLOSED", "异常已关闭");
        }
        break;
      }
      case "EVACUATION_CONFIRMED": {
        const started = this._eventsOfType(event.aggregate_id, "EVACUATION_STARTED")[0];
        if (!started) throw new DomainError("EVACUATION_NOT_STARTED", "没有先保护实物的发起记录，不能凭空双人确认");
        if (this._eventsOfType(event.aggregate_id, "EVACUATION_CONFIRMED").length) {
          throw new DomainError("EVACUATION_ALREADY_CONFIRMED", "紧急转移已完成双人确认");
        }
        if (p.second_person.person_id === started.actor.person_id) {
          throw new DomainError("SAME_PERSON_CONFIRMATION", "双人确认人不得是紧急转移发起人本人");
        }
        break;
      }
      case "OBJECT_REMOVED_FROM_DISPLAY": {
        if (p.reason === "risk_decision") {
          const decision = p.risk_review_id
            ? this._eventsOfType(p.risk_review_id, "RISK_DECISION")[0]
            : undefined;
          if (!decision || decision.payload.decision !== "remove_from_display") {
            throw new DomainError("NO_REMOVAL_AUTHORIZATION", "以风险研判为由撤展，必须引用“撤出展出”的文保人员决定");
          }
        }
        break;
      }
      case "MEDIA_USAGE_LOGGED": {
        const grant = this._eventsOfType(event.aggregate_id, "MEDIA_GRANTED")[0];
        if (!grant) throw new DomainError("NO_MEDIA_GRANT", "使用图文视频前必须存在有效许可");
        const gp = grant.payload;
        const used = ts(p.used_at);
        if (this._eventsOfType(event.aggregate_id, "MEDIA_REVOKED").length) {
          throw new DomainError("MEDIA_GRANT_REVOKED", "许可已撤销，不得继续使用");
        }
        if (used < ts(gp.valid_from) || used > ts(gp.valid_to)) {
          throw new DomainError("MEDIA_OUTSIDE_WINDOW", "使用时间不在许可有效期内");
        }
        if (!gp.media_types.includes(p.media_type)) throw new DomainError("MEDIA_TYPE_NOT_LICENSED", `未许可的媒介类型：${p.media_type}`);
        if (!gp.purposes.includes(p.purpose)) throw new DomainError("MEDIA_PURPOSE_NOT_LICENSED", `未许可的用途：${p.purpose}`);
        const uncovered = p.object_ids.filter((id) => !gp.object_ids.includes(id));
        if (uncovered.length) throw new DomainError("MEDIA_OBJECT_NOT_LICENSED", `以下藏品不在许可范围：${uncovered.join("、")}`);
        break;
      }
      case "MEDIA_REVOKED": {
        if (!this._eventsOfType(event.aggregate_id, "MEDIA_GRANTED")[0]) {
          throw new DomainError("NO_MEDIA_GRANT", "许可不存在，无法撤销");
        }
        break;
      }
      case "CLAIM_FILED": {
        const policy = this._eventsOfType(event.aggregate_id, "INSURANCE_BOUND")[0];
        if (!policy) throw new DomainError("NO_POLICY", "报案必须挂在已生效保单下");
        const pp = policy.payload;
        if (!pp.object_ids.includes(p.object_id)) throw new DomainError("OBJECT_NOT_INSURED", "受损藏品不在保单清单内");
        const at = ts(event.occurred_at);
        if (at < ts(pp.valid_from) || at > ts(pp.valid_to)) {
          throw new DomainError("OUTSIDE_COVERAGE_PERIOD", "事故时间不在保险保障期间");
        }
        if (!this._eventsOfType(p.anomaly_id, "ANOMALY_OPENED")[0]) {
          throw new DomainError("ANOMALY_NOT_OPENED", "理赔必须关联已立案异常");
        }
        break;
      }
      case "RETURN_ACCEPTED": {
        const parties = new Set((p.signers ?? []).map((s) => s.party));
        if (!parties.has("lender") || !parties.has("borrower")) {
          throw new DomainError("BOTH_PARTIES_REQUIRED", "返还验收须由出借方与承借方共同签署");
        }
        for (const r of p.object_results ?? []) {
          if (r.condition_vs_baseline === "new_discrepancy") {
            const ack = (p.acknowledged_discrepancies ?? []).some((a) => a.object_id === r.object_id);
            if (!ack) {
              throw new DomainError("DISCREPANCY_UNACKNOWLEDGED", `藏品 ${r.object_id} 存在新差异，必须逐条确认后方可验收`);
            }
          }
        }
        break;
      }
      case "LOAN_CLOSED": {
        const registered = this._events.filter(
          (e) => e.event_type === "OBJECT_REGISTERED" && e.payload.loan_id === event.aggregate_id
        ).length;
        if (p.returned_object_count !== registered) {
          throw new DomainError("COUNT_MISMATCH", `返还数量 ${p.returned_object_count} 与登记数量 ${registered} 不一致，不能关账`);
        }
        break;
      }
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// 读模型：每次从事件流重放，供出借方远程看板与保险/审计回看使用。
// ---------------------------------------------------------------------------

export class LoanProjection {
  constructor(log, loanId) {
    this.log = log;
    this.loanId = loanId;
    // 后继事件（研判、关闭、确认等）载荷里不带 loan_id：以各聚合首条携带 loan_id 的事件建立归属。
    const memberAggregates = new Set();
    for (const e of log.all()) {
      if (payloadLoanId(e) === loanId) memberAggregates.add(e.aggregate_id);
    }
    this.events = log.all().filter((e) => e.aggregate_id === loanId || memberAggregates.has(e.aggregate_id));
  }

  loan() {
    const agreed = this.events.find((e) => e.event_type === "LOAN_AGREED");
    const closed = this.events.find((e) => e.event_type === "LOAN_CLOSED");
    return agreed ? { ...agreed.payload, status: closed ? "closed" : "active", agreed_at: agreed.occurred_at } : undefined;
  }

  objects() {
    const map = new Map();
    for (const e of this.events) {
      if (e.event_type === "OBJECT_REGISTERED") {
        map.set(e.aggregate_id, { object_id: e.aggregate_id, ...e.payload });
      }
    }
    return [...map.values()];
  }

  // 藏品状况时间线：旧修补痕迹在出库基线即登记，新发现只追加、不改写前站签署。
  conditionTimeline(objectId) {
    return this.log
      .byAggregate(objectId)
      .filter((e) => e.event_type === "CONDITION_REPORTED")
      .map((e) => ({
        report_event_id: e.event_id,
        stage: e.payload.stage,
        occurred_at: e.occurred_at,
        signers: e.payload.signers,
        overall_status: e.payload.overall_status,
        findings: e.payload.findings,
        correction_of: e.correction_of,
      }))
      .sort((a, b) => ts(a.occurred_at) - ts(b.occurred_at));
  }

  // 某时刻某藏品所在箱件：逐件重放包装/开箱/拆分/重组。
  caseContainment(atEpochMs = Number.POSITIVE_INFINITY) {
    const placement = new Map(); // object_id -> case_no | null
    const history = [];
    for (const e of this.events.filter((x) => ts(x.occurred_at) <= atEpochMs)) {
      const p = e.payload;
      if (e.event_type === "OBJECT_PACKED") {
        for (const id of p.object_ids) {
          placement.set(id, p.case_no);
          history.push({ at: e.occurred_at, object_id: id, case_no: p.case_no, action: "packed", seal_no: p.seal_no });
        }
      } else if (e.event_type === "OBJECT_UNPACKED") {
        for (const id of p.object_ids) {
          placement.set(id, null);
          history.push({ at: e.occurred_at, object_id: id, case_no: p.case_no, action: "unpacked" });
        }
      } else if (e.event_type === "CASE_RECOMPOSED") {
        for (const id of p.object_ids) {
          placement.set(id, p.case_no);
          history.push({
            at: e.occurred_at,
            object_id: id,
            case_no: p.case_no,
            action: p.action,
            source_case_nos: p.source_case_nos,
            seal_no: p.seal_no,
          });
        }
      }
    }
    return { current: placement, history };
  }

  // 保管链：按发生时刻（统一折算为瞬时点，时区写法不同也不会错序）排列的交接序列。
  custodyChain() {
    const handoffs = this.events
      .filter((e) => e.event_type === "CUSTODY_TRANSFERRED")
      .map((e) => ({
        handoff_event_id: e.event_id,
        handoff_no: e.payload.handoff_no,
        stage: e.payload.stage,
        occurred_at: e.occurred_at,
        location: e.payload.location,
        from_party: e.payload.from_party,
        to_party: e.payload.to_party,
        case_nos: e.payload.case_nos ?? [],
        object_ids: e.payload.object_ids ?? [],
        signers: e.payload.signers,
      }))
      .sort((a, b) => ts(a.occurred_at) - ts(b.occurred_at));
    const holder = new Map();
    for (const h of handoffs) {
      for (const id of h.object_ids) holder.set(id, h.to_party);
      for (const caseNo of h.case_nos) holder.set(`case:${caseNo}`, h.to_party);
    }
    return { handoffs, currentHolder: holder };
  }

  risks() {
    return this.events
      .filter((e) => e.event_type === "EXCURSION_REPORTED" || e.event_type === "RISK_DECISION")
      .reduce((acc, e) => {
        const r = acc.get(e.aggregate_id) ?? { risk_id: e.aggregate_id, reports: [], decision: undefined };
        if (e.event_type === "EXCURSION_REPORTED") r.reports.push({ event_id: e.event_id, ...e.payload });
        else r.decision = { event_id: e.event_id, decided_at: e.occurred_at, ...e.payload };
        acc.set(e.aggregate_id, r);
        return acc;
      }, new Map());
  }

  anomalies() {
    const map = new Map();
    for (const e of this.events.filter((x) => ["ANOMALY_OPENED", "ANOMALY_NOTE", "ANOMALY_CLOSED"].includes(x.event_type))) {
      const a = map.get(e.aggregate_id) ?? { anomaly_id: e.aggregate_id, notes: [], closed: undefined, opened: undefined };
      if (e.event_type === "ANOMALY_OPENED") a.opened = { event_id: e.event_id, at: e.occurred_at, ...e.payload };
      if (e.event_type === "ANOMALY_NOTE") a.notes.push({ event_id: e.event_id, at: e.occurred_at, ...e.payload });
      if (e.event_type === "ANOMALY_CLOSED") a.closed = { event_id: e.event_id, at: e.occurred_at, ...e.payload };
      map.set(e.aggregate_id, a);
    }
    return map;
  }

  evacuations() {
    const map = new Map();
    for (const e of this.events.filter((x) => ["EVACUATION_STARTED", "EVACUATION_CONFIRMED"].includes(x.event_type))) {
      const v = map.get(e.aggregate_id) ?? { evacuation_id: e.aggregate_id };
      if (e.event_type === "EVACUATION_STARTED") v.started = { event_id: e.event_id, at: e.occurred_at, actor: e.actor, ...e.payload };
      else v.confirmed = { event_id: e.event_id, at: e.occurred_at, ...e.payload };
      map.set(e.aggregate_id, v);
    }
    return map;
  }

  mediaGrants() {
    const map = new Map();
    for (const e of this.events.filter((x) => x.aggregate_type === "media_grant")) {
      const g = map.get(e.aggregate_id) ?? { grant_id: e.aggregate_id, usages: [], revoked: undefined };
      if (e.event_type === "MEDIA_GRANTED") Object.assign(g, { granted: { event_id: e.event_id, ...e.payload } });
      if (e.event_type === "MEDIA_USAGE_LOGGED") g.usages.push({ event_id: e.event_id, ...e.payload });
      if (e.event_type === "MEDIA_REVOKED") g.revoked = { event_id: e.event_id, ...e.payload };
      map.set(e.aggregate_id, g);
    }
    return map;
  }

  insurance() {
    const policies = [];
    const claims = [];
    for (const e of this.events.filter((x) => x.aggregate_type === "insurance_policy")) {
      if (e.event_type === "INSURANCE_BOUND") policies.push({ policy_id: e.aggregate_id, ...e.payload });
      if (e.event_type === "CLAIM_FILED") claims.push({ claim_event_id: e.event_id, policy_id: e.aggregate_id, ...e.payload });
    }
    return { policies, claims };
  }

  // 出借方远程看板：一切尚未闭合的事项。
  openIssues() {
    const anomalies = [...this.anomalies().values()];
    const evacuations = [...this.evacuations().values()];
    const risks = [...this.risks().values()];
    return {
      anomalies_open: anomalies.filter((a) => !a.closed).map((a) => ({ anomaly_id: a.anomaly_id, ...a.opened })),
      evacuations_awaiting_second_confirmation: evacuations.filter((v) => !v.confirmed).map((v) => ({
        evacuation_id: v.evacuation_id,
        started_at: v.started.at,
        object_ids: v.started.object_ids,
        immediate_action: v.started.immediate_action,
      })),
      risks_pending_decision: risks.filter((r) => !r.decision).map((r) => ({
        risk_id: r.risk_id,
        latest: r.reports[r.reports.length - 1],
      })),
    };
  }

  // 保险/审计损伤回看：一处损伤 → 首见站点、相关箱件、交接签收、同时段环境曲线。
  damageTrace(objectId, findingCode, windowMs = 24 * 3600_000) {
    const timeline = this.conditionTimeline(objectId);
    let firstSeen;
    for (const report of timeline) {
      const f = report.findings.find((x) => x.code === findingCode);
      if (f) {
        firstSeen = { report_event_id: report.report_event_id, stage: report.stage, at: report.occurred_at, finding: f };
        break;
      }
    }
    if (!firstSeen) return { object_id: objectId, finding_code: findingCode, found: false };

    const at = ts(firstSeen.at);
    const before = at - windowMs;

    // 首见时刻该藏品所在箱件；若已开箱，则回退到开箱前最后所在箱件。
    const containment = this.caseContainment(at);
    const ownHistory = containment.history.filter((h) => h.object_id === objectId && ts(h.at) <= at);
    const lastCaseRecord = ownHistory[ownHistory.length - 1];
    const caseAtTime = containment.current.get(objectId) ?? lastCaseRecord?.case_no ?? null;
    const caseStatus = containment.current.get(objectId) ? "packed" : lastCaseRecord ? "unpacked" : null;
    const caseHistory = containment.history.filter((h) => {
      const t = ts(h.at);
      return h.object_id === objectId && t <= at && t >= before;
    });

    // 首见之前最近一次交接签收（界定责任段）。
    const { handoffs } = this.custodyChain();
    const priorHandoff = [...handoffs].reverse().find((h) => ts(h.occurred_at) <= at);

    // 同时段相关环境曲线：限本借展已登记的监测器；钉到藏品/箱件的，以及车厢、展位等区域监测。
    const loanMonitors = new Set(
      this.events.filter((e) => e.aggregate_type === "environment_monitor").map((e) => e.aggregate_id)
    );
    const env = environmentSeries(this.log).filter((m) => {
      const ref = m.scope?.ref;
      return loanMonitors.has(m.monitor_id) &&
        (ref === objectId || (caseAtTime && ref === caseAtTime) || m.scope?.kind === "zone");
    });
    const curves = env.map((m) => ({
      monitor_id: m.monitor_id,
      scope: m.scope,
      metric: m.metric,
      unit: m.unit,
      threshold_at_time: thresholdAt(m, at),
      readings: m.readings.filter((r) => r.observed_epoch >= before && r.observed_epoch <= at + windowMs),
    })).filter((c) => c.readings.length > 0);

    return {
      object_id: objectId,
      finding_code: findingCode,
      found: true,
      first_seen: firstSeen,
      case_at_time: caseAtTime,
      case_status_at_time: caseStatus,
      case_history: caseHistory,
      last_handoff_before_discovery: priorHandoff
        ? { handoff_no: priorHandoff.handoff_no, stage: priorHandoff.stage, from_party: priorHandoff.from_party, to_party: priorHandoff.to_party, signers: priorHandoff.signers }
        : null,
      environment_curves: curves,
    };
  }

  returnAcceptance() {
    const e = this.events.find((x) => x.event_type === "RETURN_ACCEPTED");
    return e ? { event_id: e.event_id, ...e.payload } : undefined;
  }
}

function payloadLoanId(e) {
  return typeof e.payload === "object" && e.payload && "loan_id" in e.payload ? e.payload.loan_id : undefined;
}

// ---------------------------------------------------------------------------
// 环境评估：断网补报按 observed_at 归位；同测点同瞬时去重；超阈值只产出待研判风险。
// ---------------------------------------------------------------------------

export function environmentSeries(log) {
  const monitors = new Map(); // aggregate_id -> monitor
  for (const e of log.all()) {
    if (e.event_type === "THRESHOLD_SET") {
      const m = monitors.get(e.aggregate_id) ?? { monitor_id: e.aggregate_id, scope: e.payload.scope, metrics: new Map() };
      m.scope = e.payload.scope;
      const series = m.metrics.get(e.payload.metric) ?? { metric: e.payload.metric, unit: e.payload.unit, thresholds: [], readings: new Map() };
      series.unit = e.payload.unit;
      series.thresholds.push({ from_epoch: ts(e.occurred_at), min: e.payload.min, max: e.payload.max });
      series.thresholds.sort((a, b) => a.from_epoch - b.from_epoch);
      m.metrics.set(e.payload.metric, series);
      monitors.set(e.aggregate_id, m);
    }
    if (e.event_type === "SENSOR_READING") {
      const m = monitors.get(e.aggregate_id) ?? { monitor_id: e.aggregate_id, scope: undefined, metrics: new Map() };
      for (const r of e.payload.readings ?? []) {
        const series = m.metrics.get(r.metric) ?? { metric: r.metric, unit: r.unit, thresholds: [], readings: new Map() };
        if (r.unit) series.unit = r.unit;
        const epoch = ts(r.observed_at);
        // 同一数据包重复上传，或两种时区写法指向同一瞬时：同一读数只计一次。
        const key = `${e.payload.sensor_id}|${r.metric}|${epoch}`;
        if (!series.readings.has(key)) {
          series.readings.set(key, {
            sensor_id: e.payload.sensor_id,
            observed_at: r.observed_at,
            observed_epoch: epoch,
            recorded_epoch: e.recorded_at ? ts(e.recorded_at) : null,
            value: r.value,
            source_event_id: e.event_id,
          });
        }
        m.metrics.set(r.metric, series);
      }
      monitors.set(e.aggregate_id, m);
    }
  }
  return [...monitors.values()].flatMap((m) =>
    [...m.metrics.values()].map((s) => ({
      monitor_id: m.monitor_id,
      scope: m.scope,
      metric: s.metric,
      unit: s.unit,
      thresholds: s.thresholds,
      readings: [...s.readings.values()].sort((a, b) => a.observed_epoch - b.observed_epoch),
    }))
  );
}

function thresholdAt(series, epoch) {
  let active;
  for (const t of series.thresholds ?? []) {
    if (t.from_epoch <= epoch) active = t;
    else break;
  }
  return active ? { min: active.min, max: active.max } : undefined;
}

// 计算各监测序列上的连续超阈值区间（待研判风险，不是事故）。
export function excursionRuns(log) {
  const runs = [];
  for (const series of environmentSeries(log)) {
    let current = null;
    for (const r of series.readings) {
      const t = thresholdAt(series, r.observed_epoch);
      const out = t ? ((t.min !== undefined && r.value < t.min) || (t.max !== undefined && r.value > t.max)) : false;
      if (out) {
        if (!current) {
          current = {
            monitor_id: series.monitor_id,
            scope: series.scope,
            metric: series.metric,
            unit: series.unit,
            threshold: t,
            start_epoch: r.observed_epoch,
            end_epoch: r.observed_epoch,
            peak_value: r.value,
            reading_event_ids: [r.source_event_id],
          };
        } else {
          current.end_epoch = r.observed_epoch;
          current.peak_value = Math.max(current.peak_value, r.value);
          if (!current.reading_event_ids.includes(r.source_event_id)) current.reading_event_ids.push(r.source_event_id);
        }
      } else if (current) {
        runs.push(current);
        current = null;
      }
    }
    if (current) runs.push(current);
  }
  return runs;
}

// 把尚未登记的超阈值区间登记为待研判风险。重复执行（含补报后重跑）不会重复建单。
export function reportDueExcursions(log, actor, loanId) {
  const created = [];
  for (const run of excursionRuns(log)) {
    const idempotencyKey = `exc:${run.monitor_id}:${run.metric}:${run.start_epoch}`;
    const exists = log.all().some(
      (e) => e.event_type === "EXCURSION_REPORTED" && e.idempotency_key === idempotencyKey
    );
    if (exists) continue;
    const seq = log.all().filter((e) => e.event_type === "EXCURSION_REPORTED").length + created.length + 1;
    const riskId = `risk-${run.monitor_id}-${run.metric}-${String(seq).padStart(3, "0")}`;
    created.push(
      log.append({
        event_id: `${riskId}-report`,
        event_type: "EXCURSION_REPORTED",
        aggregate_type: EVENT_AGGREGATE.EXCURSION_REPORTED,
        aggregate_id: riskId,
        occurred_at: new Date(run.end_epoch).toISOString(),
        version: 1,
        summary: `${run.metric} 超阈值，待文保人员研判`,
        actor,
        idempotency_key: idempotencyKey,
        payload: {
          loan_id: loanId,
          monitor_id: run.monitor_id,
          metric: run.metric,
          status: "pending_review",
          threshold: run.threshold,
          first_observed_at: new Date(run.start_epoch).toISOString(),
          last_observed_at: new Date(run.end_epoch).toISOString(),
          peak_value: run.peak_value,
          reading_event_ids: run.reading_event_ids,
        },
      })
    );
  }
  return created;
}
