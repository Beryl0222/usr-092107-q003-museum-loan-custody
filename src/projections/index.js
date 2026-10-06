// 投影：从追加式事件流派生的读模型。所有函数都是纯查询，不改写任何记录。

export function loanOf(store, loanId) {
  return store.latest("LOAN_REGISTERED", (e) => e.payload.loan_id === loanId);
}

export function objectsOf(store, loanId) {
  return store.find("OBJECT_REGISTERED", (e) => e.payload.loan_id === loanId);
}

export function objectOf(store, objectId) {
  return store.latest("OBJECT_REGISTERED", (e) => e.payload.object_id === objectId);
}

export function thresholdsOf(store, loanId) {
  const latest = store.latest("THRESHOLDS_SET", (e) => e.payload.loan_id === loanId);
  const rules = latest?.payload?.rules ?? [];
  const byMetric = {};
  for (const rule of rules) byMetric[rule.metric] = rule;
  return { rules, byMetric };
}

export function licenseOf(store, licenseId) {
  return store.latest("LICENSE_GRANTED", (e) => e.payload.license_id === licenseId);
}

export function insuranceOf(store, policyId) {
  return store.latest("INSURANCE_BOUND", (e) => e.payload.policy_id === policyId);
}

// 重放装箱/拆分/重组事件，得到每个箱件当前内容。藏品换箱时自动离开旧箱。
export function caseContents(store) {
  const contents = new Map();
  const location = new Map();
  const ensure = (id) => {
    if (!contents.has(id)) contents.set(id, new Set());
    return contents.get(id);
  };
  for (const e of store.all()) {
    const p = e.payload;
    if (e.event_type === "CASE_ASSEMBLED") {
      contents.set(p.case_id, new Set(p.object_ids));
      for (const id of p.object_ids) location.set(id, p.case_id);
    } else if (e.event_type === "OBJECT_PACKED") {
      const prev = location.get(p.object_id);
      if (prev && contents.has(prev)) contents.get(prev).delete(p.object_id);
      ensure(p.case_id).add(p.object_id);
      location.set(p.object_id, p.case_id);
    } else if (e.event_type === "CASE_SPLIT") {
      for (const child of p.into) {
        contents.set(child.case_id, new Set(child.object_ids));
        for (const id of child.object_ids) {
          ensure(p.case_id).delete(id);
          location.set(id, child.case_id);
        }
      }
    } else if (e.event_type === "CASE_RECOMBINED") {
      for (const from of p.from_case_ids) ensure(from).clear();
      contents.set(p.case_id, new Set(p.object_ids));
      for (const id of p.object_ids) location.set(id, p.case_id);
    }
  }
  return { contents, location };
}

// 藏品在箱件间的驻留区间，用于从损伤回看相关箱件。
export function caseMembershipHistory(store, objectId) {
  const intervals = [];
  let current = null;
  const close = (seq) => {
    if (current) {
      current.to_seq = seq;
      intervals.push(current);
      current = null;
    }
  };
  const open = (caseId, seq) => {
    close(seq);
    current = { case_id: caseId, from_seq: seq, to_seq: null };
  };
  for (const e of store.all()) {
    const p = e.payload;
    if (e.event_type === "OBJECT_PACKED" && p.object_id === objectId) {
      open(p.case_id, e.seq);
    } else if (e.event_type === "CASE_SPLIT") {
      const child = p.into.find((c) => c.object_ids.includes(objectId));
      if (current && child) open(child.case_id, e.seq);
    } else if (e.event_type === "CASE_RECOMBINED" && p.object_ids.includes(objectId)) {
      if (current) open(p.case_id, e.seq);
    }
  }
  close(Number.MAX_SAFE_INTEGER);
  return intervals;
}

export function currentCustodian(store, objectId, loan) {
  const transfer = store.latest("CUSTODY_TRANSFERRED", (e) => e.payload.object_ids.includes(objectId));
  return transfer ? transfer.payload.to_org : loan?.payload?.lender_org;
}

export function reportOf(store, reportId) {
  const opened = store.latest("CONDITION_INSPECTED", (e) => e.payload.report_id === reportId);
  if (!opened) return null;
  const added = store.find("FINDING_RECORDED", (e) => e.payload.report_id === reportId);
  const signed = store.latest("CONDITION_SIGNED", (e) => e.payload.report_id === reportId);
  return {
    report_id: reportId,
    object_id: opened.payload.object_id,
    loan_id: opened.payload.loan_id,
    phase: opened.payload.phase,
    station: opened.payload.station,
    inspected_at: opened.occurred_instant,
    findings: [...opened.payload.findings, ...added.map((e) => e.payload.finding)],
    signed: Boolean(signed),
    signed_by: signed?.payload?.signed_by,
    signed_at: signed?.payload?.signed_at,
  };
}

export function conditionReports(store, objectId) {
  return store
    .find("CONDITION_INSPECTED", (e) => e.payload.object_id === objectId)
    .map((e) => reportOf(store, e.payload.report_id))
    .sort((a, b) => a.inspected_at.localeCompare(b.inspected_at));
}

export function exceptionState(store, exceptionId) {
  const opened = store.latest("EXCEPTION_OPENED", (e) => e.payload.exception_id === exceptionId);
  if (!opened) return null;
  const moves = store.find("EMERGENCY_MOVED", (e) => e.payload.exception_id === exceptionId);
  const confirmations = store.find("EMERGENCY_CONFIRMED", (e) => e.payload.exception_id === exceptionId);
  const closed = store.latest("EXCEPTION_CLOSED", (e) => e.payload.exception_id === exceptionId);
  return {
    exception_id: exceptionId,
    loan_id: opened.payload.loan_id,
    kind: opened.payload.kind,
    object_ids: opened.payload.object_ids,
    description: opened.payload.description,
    related_risk_ids: opened.payload.related_risk_ids ?? [],
    opened_at: opened.occurred_instant,
    moves: moves.map((e) => e.payload),
    pending_confirmation: moves.length > 0 && confirmations.length === 0,
    closed: Boolean(closed),
    resolution: closed?.payload?.resolution,
  };
}

export function risksOf(store, loanId) {
  const raised = store.find("RISK_RAISED", (e) => e.payload.loan_id === loanId);
  return raised.map((e) => {
    const resolved = store.latest("RISK_RESOLVED", (r) => r.payload.risk_id === e.payload.risk_id);
    return {
      ...e.payload,
      status: resolved ? resolved.payload.decision : "PENDING",
      resolved: resolved?.payload ?? null,
    };
  });
}

// 出借方远程可见的未闭合事项：未闭合异常（含待补齐双人确认）与待研判风险。
export function openItems(store, loanId) {
  const opened = store.find("EXCEPTION_OPENED", (e) => e.payload.loan_id === loanId);
  const exceptions = opened
    .map((e) => exceptionState(store, e.payload.exception_id))
    .filter((s) => !s.closed);
  const pendingRisks = risksOf(store, loanId).filter((r) => r.status === "PENDING");
  return { exceptions, pending_risks: pendingRisks };
}

export function readingsOf(store, { sensorId, caseIds, from, to } = {}) {
  const rows = [];
  for (const e of store.ofType("READING_INGESTED")) {
    if (sensorId && e.payload.sensor_id !== sensorId) continue;
    if (caseIds && !(e.payload.case_id && caseIds.includes(e.payload.case_id))) continue;
    for (const r of e.payload.readings) {
      const instant = new Date(r.measured_at).toISOString();
      if (from && instant < from) continue;
      if (to && instant > to) continue;
      rows.push({
        sensor_id: e.payload.sensor_id,
        case_id: e.payload.case_id ?? null,
        location: e.payload.location ?? null,
        metric: r.metric,
        value: r.value,
        unit: r.unit,
        instant,
      });
    }
  }
  return rows.sort((a, b) => a.instant.localeCompare(b.instant));
}

export function displayStatusOf(store, objectId) {
  const deinstall = store.latest("DEINSTALL_ORDERED", (e) => e.payload.object_id === objectId);
  const rotation = store.latest("DISPLAY_ROTATED", (e) => e.payload.object_id === objectId);
  return {
    deinstalled: Boolean(deinstall),
    current_slot: rotation?.payload?.to_slot ?? null,
  };
}

// 保管链：藏品从登记到返还的全部 custody 相关事件，按落账顺序排列。
export function custodyChain(store, objectId) {
  const membership = caseMembershipHistory(store, objectId);
  const caseIds = new Set(membership.map((m) => m.case_id));
  return store
    .all()
    .filter((e) => {
      const p = e.payload;
      if (p.object_id === objectId) return true;
      if (Array.isArray(p.object_ids) && p.object_ids.includes(objectId)) return true;
      if (["CASE_ASSEMBLED", "CASE_SPLIT", "CASE_RECOMBINED"].includes(e.event_type)) {
        if (caseIds.has(p.case_id)) return true;
        if (e.event_type === "CASE_SPLIT" && p.into.some((c) => caseIds.has(c.case_id))) return true;
        if (e.event_type === "CASE_RECOMBINED" && p.from_case_ids.some((id) => caseIds.has(id))) return true;
      }
      return false;
    })
    .map((e) => ({
      seq: e.seq,
      event_type: e.event_type,
      occurred_instant: e.occurred_instant,
      summary: e.summary,
      actor: e.actor ?? null,
      payload: e.payload,
    }));
}

// 审计回溯：从一处损伤回看相关箱件、环境曲线与签收证据。
export function traceFinding(store, reportId, findingId) {
  const report = reportOf(store, reportId);
  if (!report) return null;
  const finding = report.findings.find((f) => f.finding_id === findingId) ?? null;
  const objectId = report.object_id;
  const loanId = report.loan_id;

  const registered = objectOf(store, objectId);
  const membership = caseMembershipHistory(store, objectId);
  const caseIds = membership.map((m) => m.case_id);
  const environment = readingsOf(store, { caseIds });
  const handoffs = store
    .find("CUSTODY_TRANSFERRED", (e) => e.payload.object_ids.includes(objectId))
    .map((e) => ({
      handoff_id: e.payload.handoff_id,
      from_org: e.payload.from_org,
      to_org: e.payload.to_org,
      location: e.payload.location,
      occurred_instant: e.occurred_instant,
      signatures: e.payload.signatures,
    }));
  const excursions = store
    .find("EXCURSION_REPORTED", (e) => e.payload.case_id && caseIds.includes(e.payload.case_id))
    .map((e) => e.payload);
  const risks = risksOf(store, loanId).filter((r) => (r.object_ids ?? []).includes(objectId));

  return {
    finding,
    report,
    object: {
      object_id: objectId,
      name: registered?.payload?.name,
      historical_condition: registered?.payload?.historical_condition ?? [],
    },
    condition_timeline: conditionReports(store, objectId),
    case_lineage: membership,
    environment_curve: environment,
    handoffs,
    excursions,
    risks,
  };
}
