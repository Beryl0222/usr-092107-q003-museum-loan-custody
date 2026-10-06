import { randomUUID } from "node:crypto";

import { detectExcursions, readingKey } from "../domain/environment.js";
import {
  CONSERVATOR_ROLES,
  ROLES,
  StateError,
  requireDecisionMaker,
  requireRole,
} from "../domain/policies.js";
import * as proj from "../projections/index.js";

const SYSTEM_ACTOR = { id: "system", role: ROLES.DEVICE, org: "system" };

function definedOnly(record) {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
}

/**
 * 借展护送应用服务：每个方法是一条业务命令，校验规则后向存储追加事件。
 * 规则要点：
 * - 已签署的状况报告不可改写，新发现只能进新报告；
 * - 箱件拆分/重组前后内容守恒，藏品始终可追到具体箱件；
 * - 交接单按 handoff_id 幂等，重复上传不产生第二条；
 * - 超阈值只生成待研判风险，撤展只能由 decision_makers 决定；
 * - 紧急转移先记录实物移动，双人确认后补。
 */
export class LoanService {
  constructor(store) {
    this.store = store;
  }

  _append(actor, spec) {
    const event = definedOnly({
      event_id: spec.eventId ?? randomUUID(),
      event_type: spec.eventType,
      aggregate_type: spec.aggregateType,
      aggregate_id: spec.aggregateId,
      occurred_at: spec.occurredAt ?? new Date().toISOString(),
      version: this.store.nextVersion(spec.aggregateType, spec.aggregateId),
      summary: spec.summary,
      loan_id: spec.loanId,
      actor: actor ? { id: actor.id, role: actor.role, org: actor.org } : undefined,
      idempotency_key: spec.idempotencyKey,
      payload: spec.payload,
    });
    return this.store.append(event);
  }

  _loan(loanId) {
    const loan = proj.loanOf(this.store, loanId);
    if (!loan) throw new StateError(`借展不存在：${loanId}`);
    return loan;
  }

  _conservatorOf(actor, loan, action) {
    requireRole(actor, CONSERVATOR_ROLES, action);
    const expectedOrg =
      actor.role === ROLES.LENDER_CONSERVATOR ? loan.payload.lender_org : loan.payload.borrower_org;
    if (actor.org && actor.org !== expectedOrg) {
      throw new StateError(`${action}：${actor.role} 应属于机构 ${expectedOrg}`);
    }
    return expectedOrg;
  }

  // ---- 登记 ----

  registerLoan(actor, args) {
    requireRole(actor, [ROLES.REGISTRAR, ROLES.LENDER_CONSERVATOR], "登记借展");
    return this._append(actor, {
      eventType: "LOAN_REGISTERED",
      aggregateType: "loan_agreement",
      aggregateId: args.loan_id,
      loanId: args.loan_id,
      occurredAt: args.at,
      summary: `登记借展 ${args.loan_id}：${args.lender_org} → ${args.borrower_org}，共 ${args.object_ids.length} 件`,
      payload: {
        loan_id: args.loan_id,
        lender_org: args.lender_org,
        borrower_org: args.borrower_org,
        object_ids: args.object_ids,
        period: args.period,
        venue: args.venue,
        decision_makers: args.decision_makers,
        insurance_policy_id: args.insurance_policy_id,
        license_ids: args.license_ids,
      },
    });
  }

  registerObject(actor, args) {
    const loan = this._loan(args.loan_id);
    requireRole(actor, [ROLES.REGISTRAR, ROLES.LENDER_CONSERVATOR], "登记藏品");
    if (!loan.payload.object_ids.includes(args.object_id)) {
      throw new StateError(`藏品 ${args.object_id} 不在借展 ${args.loan_id} 的清单内`);
    }
    return this._append(actor, {
      eventType: "OBJECT_REGISTERED",
      aggregateType: "collection_object",
      aggregateId: args.object_id,
      loanId: args.loan_id,
      occurredAt: args.at,
      summary: `登记藏品 ${args.name}（含历史状况 ${args.historical_condition.length} 条）`,
      payload: {
        object_id: args.object_id,
        loan_id: args.loan_id,
        name: args.name,
        category: args.category,
        historical_condition: args.historical_condition,
        dimensions: args.dimensions,
        weight_kg: args.weight_kg,
        fragile_points: args.fragile_points,
      },
    });
  }

  setThresholds(actor, args) {
    this._loan(args.loan_id);
    requireRole(actor, [ROLES.LENDER_CONSERVATOR], "设定环境阈值");
    return this._append(actor, {
      eventType: "THRESHOLDS_SET",
      aggregateType: "loan_agreement",
      aggregateId: args.loan_id,
      loanId: args.loan_id,
      occurredAt: args.at,
      summary: `设定环境阈值 ${args.rules.length} 条`,
      payload: { loan_id: args.loan_id, rules: args.rules },
    });
  }

  bindInsurance(actor, args) {
    this._loan(args.loan_id);
    requireRole(actor, [ROLES.REGISTRAR, ROLES.LENDER_CONSERVATOR], "登记保险");
    return this._append(actor, {
      eventType: "INSURANCE_BOUND",
      aggregateType: "insurance_policy",
      aggregateId: args.policy_id,
      loanId: args.loan_id,
      occurredAt: args.at,
      summary: `登记保险 ${args.policy_id}，覆盖 ${args.covered_object_ids.length} 件藏品`,
      payload: {
        policy_id: args.policy_id,
        loan_id: args.loan_id,
        insurer: args.insurer,
        covered_object_ids: args.covered_object_ids,
        coverage: args.coverage,
        period: args.period,
        amount: args.amount,
        currency: args.currency,
        premium: args.premium,
      },
    });
  }

  grantLicense(actor, args) {
    const loan = this._loan(args.loan_id);
    requireRole(actor, [ROLES.LENDER_CONSERVATOR], "授予许可");
    if (args.licensor_org !== loan.payload.lender_org) {
      throw new StateError("许可方必须是出借机构");
    }
    return this._append(actor, {
      eventType: "LICENSE_GRANTED",
      aggregateType: "media_license",
      aggregateId: args.license_id,
      loanId: args.loan_id,
      occurredAt: args.at,
      summary: `授予许可 ${args.license_id}：${args.allowed_uses.join("/")}`,
      payload: {
        license_id: args.license_id,
        loan_id: args.loan_id,
        licensor_org: args.licensor_org,
        licensee_org: args.licensee_org,
        object_ids: args.object_ids,
        allowed_uses: args.allowed_uses,
        valid_period: args.valid_period,
        restrictions: args.restrictions,
      },
    });
  }

  // ---- 包装 ----

  assembleCase(actor, args) {
    const loan = this._loan(args.loan_id);
    this._conservatorOf(actor, loan, "组配箱件");
    return this._append(actor, {
      eventType: "CASE_ASSEMBLED",
      aggregateType: "shipping_case",
      aggregateId: args.case_id,
      loanId: args.loan_id,
      occurredAt: args.at,
      summary: `组配箱件 ${args.case_id}（${args.case_type}）`,
      payload: {
        case_id: args.case_id,
        loan_id: args.loan_id,
        case_type: args.case_type,
        object_ids: args.object_ids ?? [],
        parent_case_id: args.parent_case_id,
        sealed: args.sealed,
      },
    });
  }

  packObject(actor, args) {
    const loan = this._loan(args.loan_id);
    this._conservatorOf(actor, loan, "装箱");
    if (!proj.objectOf(this.store, args.object_id)) throw new StateError(`藏品未登记：${args.object_id}`);
    const { contents } = proj.caseContents(this.store);
    if (!contents.has(args.case_id)) throw new StateError(`箱件不存在：${args.case_id}`);
    return this._append(actor, {
      eventType: "OBJECT_PACKED",
      aggregateType: "collection_object",
      aggregateId: args.object_id,
      loanId: args.loan_id,
      occurredAt: args.at,
      summary: `藏品 ${args.object_id} 装入 ${args.case_id}`,
      payload: {
        object_id: args.object_id,
        case_id: args.case_id,
        packed_by: actor.id,
        slot_id: args.slot_id,
        materials: args.materials,
      },
    });
  }

  splitCase(actor, args) {
    const loan = this._loan(args.loan_id);
    this._conservatorOf(actor, loan, "拆分箱件");
    const { contents } = proj.caseContents(this.store);
    const current = contents.get(args.case_id);
    if (!current) throw new StateError(`箱件不存在：${args.case_id}`);

    const seen = new Set();
    for (const child of args.into) {
      if (contents.has(child.case_id)) throw new StateError(`子箱编号已被使用：${child.case_id}`);
      for (const id of child.object_ids) {
        if (seen.has(id)) throw new StateError(`拆分后藏品重复分配：${id}`);
        if (!current.has(id)) throw new StateError(`藏品 ${id} 不在原箱 ${args.case_id} 内`);
        seen.add(id);
      }
    }
    if (seen.size !== current.size) {
      throw new StateError(`拆分必须恰好划分原箱内容：原 ${current.size} 件，分出 ${seen.size} 件`);
    }
    return this._append(actor, {
      eventType: "CASE_SPLIT",
      aggregateType: "shipping_case",
      aggregateId: args.case_id,
      loanId: args.loan_id,
      occurredAt: args.at,
      summary: `箱件 ${args.case_id} 拆分为 ${args.into.map((c) => c.case_id).join("、")}`,
      payload: { case_id: args.case_id, into: args.into, reason: args.reason },
    });
  }

  recombineCase(actor, args) {
    const loan = this._loan(args.loan_id);
    this._conservatorOf(actor, loan, "重组箱件");
    const { contents } = proj.caseContents(this.store);
    const union = new Set();
    for (const from of args.from_case_ids) {
      const source = contents.get(from);
      if (!source) throw new StateError(`来源箱件不存在：${from}`);
      for (const id of source) union.add(id);
    }
    const target = new Set(args.object_ids);
    const missing = [...union].filter((id) => !target.has(id));
    const extra = [...target].filter((id) => !union.has(id));
    if (missing.length || extra.length) {
      throw new StateError(`重组内容须等于来源之并集；缺失 ${missing.join(",") || "无"}，多出 ${extra.join(",") || "无"}`);
    }
    const existing = contents.get(args.case_id);
    if (existing && existing.size > 0 && !args.from_case_ids.includes(args.case_id)) {
      throw new StateError(`目标箱 ${args.case_id} 非空，不能作为重组目标`);
    }
    return this._append(actor, {
      eventType: "CASE_RECOMBINED",
      aggregateType: "shipping_case",
      aggregateId: args.case_id,
      loanId: args.loan_id,
      occurredAt: args.at,
      summary: `箱件 ${args.from_case_ids.join("、")} 重组为 ${args.case_id}（${target.size} 件）`,
      payload: {
        case_id: args.case_id,
        from_case_ids: args.from_case_ids,
        object_ids: args.object_ids,
        reason: args.reason,
      },
    });
  }

  // ---- 交接 ----

  transferCustody(actor, args) {
    // 同一交接单重复上传：幂等命中先于业务校验（保管权可能已因首单变更）。
    const idemKey = `handoff:${args.handoff_id}`;
    const prior = this.store.findByIdempotencyKey(idemKey);
    if (prior) return { event: prior, deduplicated: true };

    const loan = this._loan(args.loan_id);
    requireRole(actor, [...CONSERVATOR_ROLES, ROLES.CARRIER], "承运交接");
    const signerOrgs = new Set(args.signatures.map((s) => s.signer_org));
    const signerIds = new Set(args.signatures.map((s) => s.signer_id));
    if (!signerOrgs.has(args.from_org) || !signerOrgs.has(args.to_org)) {
      throw new StateError("交接签署须覆盖交出方与接收方");
    }
    if (signerIds.size < 2) throw new StateError("交接须至少两名不同签署人");

    const { location } = proj.caseContents(this.store);
    for (const objectId of args.object_ids) {
      const custodian = proj.currentCustodian(this.store, objectId, loan);
      if (custodian !== args.from_org) {
        throw new StateError(`藏品 ${objectId} 当前保管方是 ${custodian}，不能由 ${args.from_org} 交出`);
      }
      const caseId = location.get(objectId);
      if (!caseId) throw new StateError(`藏品 ${objectId} 未装箱，不能交接运输`);
      if (!args.case_ids.includes(caseId)) {
        throw new StateError(`交接单缺少藏品 ${objectId} 所在箱件 ${caseId}`);
      }
    }
    return this._append(actor, {
      eventType: "CUSTODY_TRANSFERRED",
      aggregateType: "custody_handoff",
      aggregateId: args.handoff_id,
      loanId: args.loan_id,
      occurredAt: args.at,
      idempotencyKey: idemKey,
      summary: `交接 ${args.handoff_id}：${args.from_org} → ${args.to_org}（${args.object_ids.length} 件）`,
      payload: {
        handoff_id: args.handoff_id,
        loan_id: args.loan_id,
        from_org: args.from_org,
        to_org: args.to_org,
        object_ids: args.object_ids,
        case_ids: args.case_ids,
        location: args.location,
        signatures: args.signatures,
        condition_report_ids: args.condition_report_ids,
      },
    });
  }

  // ---- 状况检查 ----

  inspect(actor, args) {
    const loan = this._loan(args.loan_id);
    const org = this._conservatorOf(actor, loan, "状况检查");
    const custodian = proj.currentCustodian(this.store, args.object_id, loan);
    if (org !== custodian) {
      throw new StateError(`藏品当前由 ${custodian} 保管，${org} 不能检查`);
    }
    const reportId = args.report_id ?? randomUUID();
    return this._append(actor, {
      eventType: "CONDITION_INSPECTED",
      aggregateType: "condition_report",
      aggregateId: reportId,
      loanId: args.loan_id,
      occurredAt: args.at,
      summary: `检查 ${args.object_id}（${args.phase} @ ${args.station}），初步发现 ${args.findings?.length ?? 0} 条`,
      payload: {
        report_id: reportId,
        object_id: args.object_id,
        loan_id: args.loan_id,
        phase: args.phase,
        station: args.station,
        findings: args.findings ?? [],
        previous_report_id: args.previous_report_id,
      },
    });
  }

  recordFinding(actor, args) {
    const report = proj.reportOf(this.store, args.report_id);
    if (!report) throw new StateError(`报告不存在：${args.report_id}`);
    if (report.signed) {
      throw new StateError(`报告 ${args.report_id} 已签署，不得修改；请另立新报告补充新发现`);
    }
    const loan = this._loan(report.loan_id);
    this._conservatorOf(actor, loan, "补充发现");
    return this._append(actor, {
      eventType: "FINDING_RECORDED",
      aggregateType: "condition_report",
      aggregateId: args.report_id,
      loanId: report.loan_id,
      occurredAt: args.at,
      summary: `报告 ${args.report_id} 补充发现：${args.finding.description}`,
      payload: { report_id: args.report_id, finding: args.finding },
    });
  }

  signCondition(actor, args) {
    const report = proj.reportOf(this.store, args.report_id);
    if (!report) throw new StateError(`报告不存在：${args.report_id}`);
    if (report.signed) throw new StateError(`报告 ${args.report_id} 已签署`);
    const loan = this._loan(report.loan_id);
    this._conservatorOf(actor, loan, "签署状况报告");
    return this._append(actor, {
      eventType: "CONDITION_SIGNED",
      aggregateType: "condition_report",
      aggregateId: args.report_id,
      loanId: report.loan_id,
      occurredAt: args.at,
      summary: `签署报告 ${args.report_id}（${report.findings.length} 条发现冻结）`,
      payload: {
        report_id: args.report_id,
        signed_by: actor.id,
        signed_at: args.at ?? new Date().toISOString(),
      },
    });
  }

  // ---- 环境与风险 ----

  ingestReadings(actor, args) {
    requireRole(actor, [ROLES.DEVICE, ...CONSERVATOR_ROLES, ROLES.REGISTRAR], "接收环境数据");
    const loanId = args.loan_id ?? this._loanOfCase(args.case_id);
    const loan = this._loan(loanId);

    // 断网补报与重复批次去重：同一（传感器, 指标, 时刻）只入账一次。
    const known = new Set();
    for (const e of this.store.find("READING_INGESTED", (x) => x.payload.sensor_id === args.sensor_id)) {
      for (const r of e.payload.readings) known.add(readingKey(args.sensor_id, r));
    }
    const fresh = args.readings.filter((r) => !known.has(readingKey(args.sensor_id, r)));
    if (fresh.length === 0) {
      return { deduplicated: true, skipped: args.readings.length, events: [] };
    }

    const appended = this._append(actor, {
      eventType: "READING_INGESTED",
      aggregateType: "environment_sensor",
      aggregateId: args.sensor_id,
      loanId,
      occurredAt: args.at,
      summary: `接收 ${args.sensor_id} 读数 ${fresh.length} 条${args.backfilled ? "（断网补报）" : ""}`,
      payload: {
        sensor_id: args.sensor_id,
        readings: fresh,
        case_id: args.case_id,
        location: args.location,
        loan_id: loanId,
        backfilled: args.backfilled,
      },
    });

    const riskEvents = this._evaluateExcursions(loan, args.sensor_id, args.case_id);
    return { deduplicated: false, skipped: args.readings.length - fresh.length, events: [appended.event, ...riskEvents] };
  }

  _loanOfCase(caseId) {
    if (!caseId) throw new StateError("缺少 loan_id 且无法从箱件推断");
    const assembled = this.store.latest("CASE_ASSEMBLED", (e) => e.payload.case_id === caseId);
    if (!assembled) throw new StateError(`箱件不存在：${caseId}`);
    return assembled.payload.loan_id;
  }

  // 超阈值只生成待研判风险；补报导致窗口合并时，失效风险以继任事件标注，不留下虚假事故。
  _evaluateExcursions(loan, sensorId, caseId) {
    const { byMetric } = proj.thresholdsOf(this.store, loan.payload.loan_id);
    if (Object.keys(byMetric).length === 0) return [];

    const readings = [];
    for (const e of this.store.find("READING_INGESTED", (x) => x.payload.sensor_id === sensorId)) {
      readings.push(...e.payload.readings);
    }
    const excursions = detectExcursions(sensorId, readings, byMetric);
    const currentKeys = new Set(excursions.map((x) => x.key));
    const events = [];
    const { contents } = proj.caseContents(this.store);

    for (const excursion of excursions) {
      const stream = this.store.stream("environment_excursion", excursion.key);
      const head = stream[stream.length - 1];
      const changed =
        !head ||
        head.payload.window.end !== excursion.window.end ||
        head.payload.reading_count !== excursion.reading_count;
      if (changed) {
        const result = this._append(SYSTEM_ACTOR, {
          eventType: "EXCURSION_REPORTED",
          aggregateType: "environment_excursion",
          aggregateId: excursion.key,
          loanId: loan.payload.loan_id,
          occurredAt: excursion.window.end,
          summary: `超阈值：${excursion.metric} 窗口 ${excursion.window.start} ~ ${excursion.window.end}`,
          payload: { ...excursion, excursion_key: excursion.key, case_id: caseId },
        });
        events.push(result.event);
      }

      const riskId = `risk:${excursion.key}`;
      const existing = this.store.latest("RISK_RAISED", (e) => e.payload.risk_id === riskId);
      if (!existing) {
        const rule = byMetric[excursion.metric];
        const objectIds = rule.scope_object_ids ?? [...(contents.get(caseId) ?? [])];
        const result = this._append(SYSTEM_ACTOR, {
          eventType: "RISK_RAISED",
          aggregateType: "risk_assessment",
          aggregateId: riskId,
          loanId: loan.payload.loan_id,
          occurredAt: excursion.window.end,
          idempotencyKey: riskId,
          summary: `待研判风险：${excursion.metric} 超阈值，涉及 ${objectIds.length} 件藏品`,
          payload: {
            risk_id: riskId,
            loan_id: loan.payload.loan_id,
            basis: `传感器 ${sensorId} 的 ${excursion.metric} 超出阈值`,
            status: "PENDING",
            excursion_key: excursion.key,
            object_ids: objectIds,
            case_ids: caseId ? [caseId] : [],
          },
        });
        events.push(result.event);
      }
    }

    // 补报合并窗口后，已不成立的窗口对应风险标注为被取代，避免留下虚假事故。
    const stale = this.store.find(
      "RISK_RAISED",
      (e) =>
        e.payload.loan_id === loan.payload.loan_id &&
        e.payload.excursion_key?.startsWith(`${sensorId}:`) &&
        !currentKeys.has(e.payload.excursion_key),
    );
    for (const raised of stale) {
      const resolved = this.store.latest("RISK_RESOLVED", (e) => e.payload.risk_id === raised.payload.risk_id);
      if (resolved) continue;
      const result = this._append(SYSTEM_ACTOR, {
        eventType: "RISK_RESOLVED",
        aggregateType: "risk_assessment",
        aggregateId: raised.payload.risk_id,
        loanId: loan.payload.loan_id,
        summary: `风险 ${raised.payload.risk_id} 因补报合并窗口而失效`,
        payload: {
          risk_id: raised.payload.risk_id,
          decision: "superseded_by_backfill",
          rationale: "断网补报后窗口重新计算，原窗口不再成立",
          decided_by: "system",
        },
      });
      events.push(result.event);
    }
    return events;
  }

  resolveRisk(actor, args) {
    const risk = this.store.latest("RISK_RAISED", (e) => e.payload.risk_id === args.risk_id);
    if (!risk) throw new StateError(`风险不存在：${args.risk_id}`);
    const loan = this._loan(risk.payload.loan_id);
    requireDecisionMaker(actor, loan, "研判风险");
    if (this.store.latest("RISK_RESOLVED", (e) => e.payload.risk_id === args.risk_id)) {
      throw new StateError(`风险 ${args.risk_id} 已有研判结论`);
    }
    if (!["dismissed", "monitor", "deinstall"].includes(args.decision)) {
      throw new StateError(`未知研判结论：${args.decision}`);
    }
    const events = [
      this._append(actor, {
        eventType: "RISK_RESOLVED",
        aggregateType: "risk_assessment",
        aggregateId: args.risk_id,
        loanId: loan.payload.loan_id,
        occurredAt: args.at,
        summary: `风险研判：${args.decision}（${args.rationale}）`,
        payload: {
          risk_id: args.risk_id,
          decision: args.decision,
          rationale: args.rationale,
          decided_by: actor.id,
        },
      }).event,
    ];
    if (args.decision === "deinstall") {
      for (const objectId of risk.payload.object_ids ?? []) {
        events.push(
          this._append(actor, {
            eventType: "DEINSTALL_ORDERED",
            aggregateType: "collection_object",
            aggregateId: objectId,
            loanId: loan.payload.loan_id,
            occurredAt: args.at,
            summary: `撤展决定：${objectId}`,
            payload: { object_id: objectId, reason: args.rationale, ordered_by: actor.id, risk_id: args.risk_id },
          }).event,
        );
      }
    }
    return events;
  }

  // ---- 异常与紧急转移 ----

  openException(actor, args) {
    const loan = this._loan(args.loan_id);
    this._conservatorOf(actor, loan, "异常立案");
    const exceptionId = args.exception_id ?? randomUUID();
    return this._append(actor, {
      eventType: "EXCEPTION_OPENED",
      aggregateType: "exception_case",
      aggregateId: exceptionId,
      loanId: args.loan_id,
      occurredAt: args.at,
      summary: `异常立案 ${exceptionId}（${args.kind}）：${args.description}`,
      payload: {
        exception_id: exceptionId,
        loan_id: args.loan_id,
        kind: args.kind,
        object_ids: args.object_ids,
        description: args.description,
        related_risk_ids: args.related_risk_ids,
      },
    });
  }

  // 紧急转移：先保护实物，单人即可记录；双人确认由 confirmEmergency 补齐。
  emergencyMove(actor, args) {
    const loan = this._loan(args.loan_id);
    this._conservatorOf(actor, loan, "紧急转移");
    let exceptionId = args.exception_id;
    const events = [];
    if (!exceptionId) {
      exceptionId = randomUUID();
      events.push(
        this._append(actor, {
          eventType: "EXCEPTION_OPENED",
          aggregateType: "exception_case",
          aggregateId: exceptionId,
          loanId: args.loan_id,
          occurredAt: args.at,
          summary: `紧急转移立案 ${exceptionId}`,
          payload: {
            exception_id: exceptionId,
            loan_id: args.loan_id,
            kind: "emergency_move",
            object_ids: args.object_ids,
            description: args.reason,
          },
        }).event,
      );
    } else {
      const state = proj.exceptionState(this.store, exceptionId);
      if (!state) throw new StateError(`异常不存在：${exceptionId}`);
      if (state.closed) throw new StateError(`异常 ${exceptionId} 已闭合`);
    }
    events.push(
      this._append(actor, {
        eventType: "EMERGENCY_MOVED",
        aggregateType: "exception_case",
        aggregateId: exceptionId,
        loanId: args.loan_id,
        occurredAt: args.at,
        summary: `紧急转移 ${args.object_ids.length} 件：${args.from_location} → ${args.to_location}（待双人确认）`,
        payload: {
          exception_id: exceptionId,
          object_ids: args.object_ids,
          from_location: args.from_location,
          to_location: args.to_location,
          reason: args.reason,
          moved_by: actor.id,
          confirmation_status: "PENDING",
        },
      }).event,
    );
    return events;
  }

  confirmEmergency(actor, args) {
    const state = proj.exceptionState(this.store, args.exception_id);
    if (!state) throw new StateError(`异常不存在：${args.exception_id}`);
    const loan = this._loan(state.loan_id);
    this._conservatorOf(actor, loan, "紧急转移确认");
    if (state.moves.length === 0) throw new StateError("没有待确认的紧急转移");
    if (!state.pending_confirmation) throw new StateError("双人确认已补齐");
    const confirmers = args.confirmer_ids;
    if (!Array.isArray(confirmers) || confirmers.length !== 2 || new Set(confirmers).size !== 2) {
      throw new StateError("双人确认须为两名不同人员");
    }
    const mover = state.moves[state.moves.length - 1].moved_by;
    if (confirmers.every((id) => id === mover)) {
      throw new StateError("确认人至少一人须不同于转移执行人");
    }
    return this._append(actor, {
      eventType: "EMERGENCY_CONFIRMED",
      aggregateType: "exception_case",
      aggregateId: args.exception_id,
      loanId: state.loan_id,
      occurredAt: args.at,
      summary: `紧急转移双人确认补齐：${confirmers.join("、")}`,
      payload: {
        exception_id: args.exception_id,
        confirmer_ids: confirmers,
        confirmed_at: args.at ?? new Date().toISOString(),
      },
    });
  }

  closeException(actor, args) {
    const state = proj.exceptionState(this.store, args.exception_id);
    if (!state) throw new StateError(`异常不存在：${args.exception_id}`);
    const loan = this._loan(state.loan_id);
    this._conservatorOf(actor, loan, "异常闭合");
    if (state.closed) throw new StateError(`异常 ${args.exception_id} 已闭合`);
    if (state.pending_confirmation) {
      throw new StateError("紧急转移的双人确认尚未补齐，不能闭合");
    }
    for (const riskId of state.related_risk_ids) {
      const resolved = this.store.latest("RISK_RESOLVED", (e) => e.payload.risk_id === riskId);
      if (!resolved) throw new StateError(`关联风险 ${riskId} 尚未研判，不能闭合`);
    }
    return this._append(actor, {
      eventType: "EXCEPTION_CLOSED",
      aggregateType: "exception_case",
      aggregateId: args.exception_id,
      loanId: state.loan_id,
      occurredAt: args.at,
      summary: `异常闭合 ${args.exception_id}：${args.resolution}`,
      payload: { exception_id: args.exception_id, resolution: args.resolution, closed_by: actor.id },
    });
  }

  // ---- 展陈与拍摄 ----

  _checkLicense(actor, args, use) {
    const license = proj.licenseOf(this.store, args.license_id);
    if (!license) throw new StateError(`许可不存在：${args.license_id}`);
    const p = license.payload;
    if (p.licensee_org !== actor.org) throw new StateError(`许可持有人是 ${p.licensee_org}，不是 ${actor.org}`);
    if (!p.allowed_uses.includes(use)) throw new StateError(`许可不允许用途：${use}`);
    const at = Date.parse(args.at ?? new Date().toISOString());
    if (at < Date.parse(p.valid_period.start) || at > Date.parse(p.valid_period.end)) {
      throw new StateError("许可不在有效期内");
    }
    const objects = Array.isArray(args.object_ids) ? args.object_ids : [args.object_id];
    for (const id of objects) {
      if (!p.object_ids.includes(id)) throw new StateError(`藏品 ${id} 不在许可范围内`);
    }
    return p;
  }

  rotateDisplay(actor, args) {
    const loan = this._loan(args.loan_id);
    requireRole(actor, [ROLES.BORROWER_CONSERVATOR], "展位轮换");
    this._checkLicense(actor, { ...args, object_ids: [args.object_id] }, "display");
    if (proj.displayStatusOf(this.store, args.object_id).deinstalled) {
      throw new StateError(`藏品 ${args.object_id} 已撤展，不能轮换`);
    }
    return this._append(actor, {
      eventType: "DISPLAY_ROTATED",
      aggregateType: "display_slot",
      aggregateId: `display:${args.object_id}`,
      loanId: args.loan_id,
      occurredAt: args.at,
      summary: `展位轮换：${args.object_id} → ${args.to_slot}`,
      payload: {
        object_id: args.object_id,
        loan_id: args.loan_id,
        from_slot: args.from_slot,
        to_slot: args.to_slot,
        license_id: args.license_id,
        reason: args.reason,
      },
    });
  }

  logMediaUsage(actor, args) {
    this._loan(args.loan_id);
    requireRole(actor, [ROLES.BORROWER_CONSERVATOR], "拍摄登记");
    this._checkLicense(actor, args, args.use_type);
    return this._append(actor, {
      eventType: "MEDIA_USAGE_LOGGED",
      aggregateType: "media_license",
      aggregateId: args.license_id,
      loanId: args.loan_id,
      occurredAt: args.at,
      summary: `拍摄登记：${args.use_type}，涉及 ${args.object_ids.length} 件`,
      payload: {
        usage_id: args.usage_id ?? randomUUID(),
        license_id: args.license_id,
        object_ids: args.object_ids,
        use_type: args.use_type,
        operator_id: actor.id,
        purpose: args.purpose,
      },
    });
  }

  // ---- 返还验收 ----

  acceptReturn(actor, args) {
    // 验收单与交接单是不同的业务事实，幂等键须各自独立。
    const idemKey = `return-acceptance:${args.handoff_id}`;
    const prior = this.store.findByIdempotencyKey(idemKey);
    if (prior) return { event: prior, deduplicated: true };

    const loan = this._loan(args.loan_id);
    requireRole(actor, [ROLES.LENDER_CONSERVATOR], "返还验收");
    const lender = loan.payload.lender_org;

    for (const objectId of args.object_ids) {
      const custodian = proj.currentCustodian(this.store, objectId, loan);
      if (custodian !== lender) {
        throw new StateError(`藏品 ${objectId} 尚未交还 ${lender}，不能验收`);
      }
    }
    const reports = args.condition_report_ids.map((id) => {
      const report = proj.reportOf(this.store, id);
      if (!report) throw new StateError(`报告不存在：${id}`);
      if (!report.signed) throw new StateError(`报告 ${id} 未签署，不能作为验收依据`);
      if (!["pre_return", "return"].includes(report.phase)) {
        throw new StateError(`报告 ${id} 节点为 ${report.phase}，须为 pre_return 或 return`);
      }
      return report;
    });

    // 对照各站签署状况：验收报告中的新发现即为差异。
    const discrepancies = reports.flatMap((r) =>
      r.findings
        .filter((f) => f.is_new)
        .map((f) => ({ object_id: r.object_id, finding_id: f.finding_id, description: f.description })),
    );

    const events = [];
    let openedExceptionId;
    if (discrepancies.length > 0) {
      openedExceptionId = randomUUID();
      events.push(
        this._append(actor, {
          eventType: "EXCEPTION_OPENED",
          aggregateType: "exception_case",
          aggregateId: openedExceptionId,
          loanId: args.loan_id,
          occurredAt: args.at,
          summary: `返还验收发现 ${discrepancies.length} 处差异，自动立案`,
          payload: {
            exception_id: openedExceptionId,
            loan_id: args.loan_id,
            kind: "damage",
            object_ids: [...new Set(discrepancies.map((d) => d.object_id))],
            description: `返还验收差异：${discrepancies.map((d) => d.description).join("；")}`,
          },
        }).event,
      );
    }
    events.push(
      this._append(actor, {
        eventType: "RETURN_ACCEPTED",
        aggregateType: "custody_handoff",
        aggregateId: args.handoff_id,
        loanId: args.loan_id,
        occurredAt: args.at,
        idempotencyKey: idemKey,
        summary: `返还验收 ${args.object_ids.length} 件，差异 ${discrepancies.length} 处`,
        payload: {
          handoff_id: args.handoff_id,
          loan_id: args.loan_id,
          object_ids: args.object_ids,
          condition_report_ids: args.condition_report_ids,
          discrepancies,
          accepted_by: actor.id,
          opened_exception_id: openedExceptionId,
        },
      }).event,
    );
    return events;
  }
}
