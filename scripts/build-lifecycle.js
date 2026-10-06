// 生成 51 件徽州木雕跨馆借展的全流程事件流，并验证关键不变量。
// 运行：node scripts/build-lifecycle.js
// 产出：data/lifecycle.json（事件流）与 data/lifecycle-replay-report.json（重放校验报告）
import { writeFile } from "node:fs/promises";
import { EventLog, LoanProjection, environmentSeries, excursionRuns, reportDueExcursions, DomainError } from "../src/model.js";

const LOAN = "loan-jx-sd-2026";
const N = 51;
const id = (n) => `obj-${String(n).padStart(3, "0")}`;
const ids = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => id(from + i));
const ALL = ids(1, N);

const actors = {
  registrar: { person_id: "p-dongji", name: "董籍", role: "REGISTRAR", org: "绩溪县博物馆" },
  lenderCons: { person_id: "p-wangshen", name: "汪慎", role: "LENDER_CONSERVATOR", org: "绩溪县博物馆" },
  courier: { person_id: "p-lusui", name: "卢随", role: "COURIER", org: "绩溪县博物馆" },
  borrowerCons: { person_id: "p-luyan", name: "鲁岩", role: "BORROWER_CONSERVATOR", org: "山东某馆" },
  carrier: { person_id: "p-antu", name: "安途", role: "CARRIER", org: "安途文物运输" },
  curator: { person_id: "p-qizhan", name: "齐展", role: "CURATOR", org: "山东某馆" },
  photographer: { person_id: "p-guangying", name: "光影", role: "PHOTOGRAPHER", org: "山东某馆" },
  system: { person_id: "p-sys", name: "监测平台", role: "SYSTEM", org: "监测平台" },
};

const log = new EventLog();
let seq = 0;
function E(type, aggregateId, occurredAt, actor, payload, extra = {}) {
  seq += 1;
  return log.append({
    event_id: `evt-${String(seq).padStart(4, "0")}`,
    event_type: type,
    aggregate_type: {
      LOAN_AGREED: "loan", EXHIBITION_OPENED: "loan", LOAN_CLOSED: "loan",
      OBJECT_REGISTERED: "collection_object", CONDITION_REPORTED: "collection_object", OBJECT_REMOVED_FROM_DISPLAY: "collection_object",
      OBJECT_PACKED: "shipping_case", OBJECT_UNPACKED: "shipping_case", CASE_RECOMPOSED: "shipping_case",
      CUSTODY_TRANSFERRED: "custody_handoff",
      THRESHOLD_SET: "environment_monitor", SENSOR_READING: "environment_monitor",
      EXCURSION_REPORTED: "risk_review", RISK_DECISION: "risk_review",
      ANOMALY_OPENED: "condition_anomaly", ANOMALY_NOTE: "condition_anomaly", ANOMALY_CLOSED: "condition_anomaly",
      EVACUATION_STARTED: "emergency_evacuation", EVACUATION_CONFIRMED: "emergency_evacuation",
      OBJECT_INSTALLED: "exhibition_slot", SLOT_ROTATED: "exhibition_slot",
      MEDIA_GRANTED: "media_grant", MEDIA_USAGE_LOGGED: "media_grant", MEDIA_REVOKED: "media_grant",
      INSURANCE_BOUND: "insurance_policy", CLAIM_FILED: "insurance_policy",
      RETURN_ACCEPTED: "return_acceptance",
    }[type],
    aggregate_id: aggregateId,
    occurred_at: occurredAt,
    version: log.nextVersion(aggregateId),
    summary: extra.summary ?? "",
    actor,
    payload,
    ...extra.rest,
  });
}

const sign = (party, person, at) => ({ party, person_id: person.person_id, name: person.name, signed_at: at });

// --- 1. 借展协议与保险 -------------------------------------------------------
E("LOAN_AGREED", LOAN, "2026-09-15T10:00:00+08:00", actors.registrar, {
  lender: "绩溪县博物馆",
  borrower: "山东某馆",
  object_count: N,
  period: { start: "2026-09-26T09:00:00+08:00", end: "2026-10-20T17:00:00+08:00" },
  venues: ["山东某馆三层七号展厅"],
  insurance_policy_id: "policy-P2026-0917",
}, { summary: "51 件徽州木雕赴山东借展协议生效" });

E("INSURANCE_BOUND", "policy-P2026-0917", "2026-09-18T09:30:00+08:00", actors.registrar, {
  loan_id: LOAN,
  policy_no: "P2026-0917",
  insurer: "中保文物保险",
  object_ids: ALL,
  coverage_total: 8_600_000,
  currency: "CNY",
  perils: ["运输风险", "装卸风险", "展出期间火灾水渍", "不可抗力"],
  valid_from: "2026-09-20T00:00:00+08:00",
  valid_to: "2026-10-20T23:59:00+08:00",
}, { summary: "钉到件、钉到期间的门到门保险生效" });

// --- 2. 藏品登记与出库点交（历史状况、旧修补痕迹） ----------------------------
for (let n = 1; n <= N; n += 1) {
  E("OBJECT_REGISTERED", id(n), "2026-09-19T14:00:00+08:00", actors.registrar, {
    loan_id: LOAN,
    accession_no: `绩博木2026-${String(n).padStart(3, "0")}`,
    name: `徽州木雕构件 ${String(n).padStart(2, "0")}`,
    dynasty: "明清",
    material: "樟木/髹金",
    dimensions_cm: "约 38×26×6",
    weight_kg: 2.4,
    valuation: 120000 + n * 1000,
    currency: "CNY",
    old_repairs: n === 1
      ? [{ area: "左下角榫接处", description: "20 世纪 90 年代旧修，以竹木钉加固，表面髹漆略有色差" }]
      : [],
    photo_refs: [`photo/2026/register/${id(n)}/baseline`],
  }, { summary: `${id(n)} 藏品身份与借出前状况登记` });
}

for (let n = 1; n <= N; n += 1) {
  E("CONDITION_REPORTED", id(n), "2026-09-20T09:00:00+08:00", actors.lenderCons, {
    loan_id: LOAN,
    stage: "出库点交",
    signers: [sign("lender", actors.lenderCons, "2026-09-20T09:00:00+08:00")],
    overall_status: n === 1 ? "stable" : "good",
    findings: n === 1
      ? [{ code: "F001-old-repair", area: "左下角榫接处", description: "旧竹木钉加固，髹漆色差，无新活动迹象", kind: "old_repair", severity: "minor", photo_refs: ["photo/F001-old-repair/baseline"] }]
      : [],
  }, { summary: `${id(n)} 出库点交状况基线（出借方签署）` });
}

// --- 3. 包装层级与发运交接 ----------------------------------------------------
const groups = [
  ["case-A", ids(1, 9)], ["case-B", ids(10, 18)], ["case-C", ids(19, 27)],
  ["case-D", ids(28, 36)], ["case-E", ids(37, 45)], ["case-F", ids(46, 51)],
];
for (const [caseNo, objs] of groups) {
  E("OBJECT_PACKED", caseNo, "2026-09-20T15:00:00+08:00", actors.courier, {
    loan_id: LOAN,
    case_no: caseNo,
    package_level: "外箱",
    materials: ["蜂窝纸板外箱", "EPE 缓冲层", "无酸纸内匣"],
    object_ids: objs,
    seal_no: `seal-${caseNo}-01`,
    packers: [actors.courier.name, "包装组"],
  }, { summary: `${caseNo} 装入 ${objs.length} 件并施封` });
}

E("CUSTODY_TRANSFERRED", "handoff-H01", "2026-09-20T17:30:00+08:00", actors.registrar, {
  loan_id: LOAN,
  handoff_no: "H01",
  stage: "装车发运",
  location: "绩溪县博物馆装卸区",
  from_party: "绩溪县博物馆",
  to_party: "安途文物运输",
  case_nos: ["case-A", "case-B", "case-C", "case-D", "case-E", "case-F"],
  object_ids: ALL,
  seal_nos: groups.map(([c]) => `seal-${c}-01`),
  signers: [sign("lender", actors.registrar, "2026-09-20T17:30:00+08:00"), sign("carrier", actors.carrier, "2026-09-20T17:30:00+08:00")],
}, { summary: "装车发运：出借方 → 承运方", rest: { idempotency_key: "H01" } });

// --- 4. 运输在途环境数据（含断网补报、时区混写） ------------------------------
E("THRESHOLD_SET", "mon-zone7", "2026-09-20T17:00:00+08:00", actors.lenderCons, {
  loan_id: LOAN,
  scope: { kind: "zone", ref: "车厢三区" },
  metric: "relative_humidity",
  unit: "%RH",
  min: 45,
  max: 60,
}, { summary: "运输相对湿度阈值 45–60%RH" });

E("THRESHOLD_SET", "mon-zone7", "2026-09-20T17:00:00+08:00", actors.lenderCons, {
  loan_id: LOAN,
  scope: { kind: "zone", ref: "车厢三区" },
  metric: "temperature",
  unit: "C",
  min: 15,
  max: 25,
}, { summary: "运输温度阈值 15–25℃" });

// 09-21 的读数：设备断网，09-24 才补报；时间分别用 Z 与 +08:00 两种写法。
E("SENSOR_READING", "mon-zone7", "2026-09-24T08:00:00+08:00", actors.system, {
  loan_id: LOAN,
  sensor_id: "sensor-truck-03",
  readings: [
    { metric: "relative_humidity", value: 52.4, unit: "%RH", observed_at: "2026-09-21T01:00:00Z" },
    { metric: "relative_humidity", value: 63.1, unit: "%RH", observed_at: "2026-09-21T10:00:00+08:00" },
    { metric: "relative_humidity", value: 64.0, unit: "%RH", observed_at: "2026-09-21T03:00:00Z" },
    { metric: "relative_humidity", value: 55.0, unit: "%RH", observed_at: "2026-09-21T05:00:00Z" },
    { metric: "temperature", value: 22.1, unit: "C", observed_at: "2026-09-21T01:00:00Z" },
  ],
}, { summary: "断网补报：09-21 运输湿度读数（收记时间晚于采集时间）", rest: { recorded_at: "2026-09-24T08:00:00+08:00", idempotency_key: "batch-truck-0921" } });

// --- 5. 抵馆接收、箱件拆分（货梯尺寸限制）与开箱检查 --------------------------
E("CUSTODY_TRANSFERRED", "handoff-H02", "2026-09-22T11:20:00+08:00", actors.carrier, {
  loan_id: LOAN,
  handoff_no: "H02",
  stage: "抵馆接收",
  location: "山东某馆货运平台",
  from_party: "安途文物运输",
  to_party: "山东某馆",
  case_nos: ["case-A", "case-B", "case-C", "case-D", "case-E", "case-F"],
  object_ids: ALL,
  seal_nos: groups.map(([c]) => `seal-${c}-01`),
  signers: [sign("carrier", actors.carrier, "2026-09-22T11:20:00+08:00"), sign("borrower", actors.borrowerCons, "2026-09-22T11:20:00+08:00")],
  notes: "六只外箱封签完好；case-D 尺寸超货梯限界，需到库拆分",
}, { summary: "抵馆接收：承运方 → 承借方", rest: { idempotency_key: "H02" } });

// case-D 拆分为 case-D（28–31）与 case-G（32–36），逐件仍可追溯。
E("CASE_RECOMPOSED", "case-G", "2026-09-22T14:00:00+08:00", actors.borrowerCons, {
  loan_id: LOAN,
  case_no: "case-G",
  action: "split",
  source_case_nos: ["case-D"],
  object_ids: ids(32, 36),
  seal_no: "seal-case-G-01",
  note: "原 case-D 超高超宽无法进入库房货梯，拆出 5 件另组 case-G",
}, { summary: "箱件拆分：case-D → case-D + case-G（32–36 件）" });

const unpackGroups = [
  ["case-A", ids(1, 9)], ["case-B", ids(10, 18)], ["case-C", ids(19, 27)],
  ["case-D", ids(28, 31)], ["case-G", ids(32, 36)], ["case-E", ids(37, 45)], ["case-F", ids(46, 51)],
];
for (const [caseNo, objs] of unpackGroups) {
  E("OBJECT_UNPACKED", caseNo, "2026-09-23T09:30:00+08:00", actors.borrowerCons, {
    loan_id: LOAN,
    case_no: caseNo,
    object_ids: objs,
    stage: "开箱检查",
    location: "山东某馆文保实验室",
    unpackers: [actors.borrowerCons.name, actors.lenderCons.name],
  }, { summary: `${caseNo} 开箱，取出 ${objs.length} 件逐件检查` });
}

for (let n = 1; n <= N; n += 1) {
  const isOne = n === 1;
  E("CONDITION_REPORTED", id(n), "2026-09-23T15:00:00+08:00", actors.borrowerCons, {
    loan_id: LOAN,
    stage: "开箱检查",
    signers: [
      sign("borrower", actors.borrowerCons, "2026-09-23T15:00:00+08:00"),
      sign("lender", actors.lenderCons, "2026-09-23T15:05:00+08:00"),
    ],
    overall_status: isOne ? "concern" : "good",
    findings: isOne
      ? [
          { code: "F001-old-repair", area: "左下角榫接处", description: "旧修补维持出库基线状态", kind: "old_repair", severity: "minor", photo_refs: ["photo/F001-old-repair/arrival"] },
          { code: "F001-edge-crack", area: "左下角旧修旁约 2cm", description: "旧修补痕迹边缘新见发丝状裂纹一条，开箱时首次发现", kind: "new_damage", severity: "moderate", photo_refs: ["photo/F001-edge-crack/arrival"] },
        ]
      : [],
  }, { summary: `${id(n)} 开箱检查状况（双方会签）${isOne ? "：obj-001 旧修旁新发裂纹" : ""}` });
}

// --- 6. 异常立案 / 理赔 / 风险研判（超阈只待研判，不自动撤展） ----------------
E("ANOMALY_OPENED", "anomaly-001", "2026-09-23T16:30:00+08:00", actors.borrowerCons, {
  loan_id: LOAN,
  title: "obj-001 旧修边缘新发裂纹",
  category: "damage",
  severity: "moderate",
  object_id: "obj-001",
  case_no: "case-A",
  handoff_no: "H02",
  description: "开箱检查发现 F001-edge-crack，出库基线无此记录，责任段待研判",
  evidence_refs: ["photo/F001-edge-crack/arrival", "report/开箱检查/obj-001"],
}, { summary: "损伤异常立案，关联箱件与抵馆签收单" });

E("ANOMALY_NOTE", "anomaly-001", "2026-09-24T10:00:00+08:00", actors.lenderCons, {
  note: "比对出库照片与运输湿度曲线：09-21 曾出现 64%RH 短时偏高，裂纹位于旧应力集中点；双方初判与湿度波动相关",
  action_taken: "维持平放恒湿缓冲，暂不上展台",
  evidence_refs: ["mon-zone7/batch-truck-0921"],
}, { summary: "出借方到场研判并采取先期保护" });

// 系统登记湿度超阈风险（由事件流自动评估），随后文保人员决定继续观察。
const humidityRisks = reportDueExcursions(log, actors.system, LOAN);

E("RISK_DECISION", humidityRisks[0].aggregate_id, "2026-09-25T09:00:00+08:00", actors.lenderCons, {
  decision: "keep_monitoring",
  decided_by: actors.lenderCons,
  rationale: "63–64%RH 仅持续两个采集点且已回落，无变形迹象；裂纹异常另行处置，不触发撤展",
}, { summary: "出借方文保人员研判：湿度风险继续观察，不撤展" });

E("CLAIM_FILED", "policy-P2026-0917", "2026-09-25T14:00:00+08:00", actors.registrar, {
  loan_id: LOAN,
  claim_no: "CL2026-0007",
  anomaly_id: "anomaly-001",
  object_id: "obj-001",
  amount: 8000,
  currency: "CNY",
  description: "旧修边缘裂纹修复与检测费用",
}, { summary: "就 anomaly-001 提起保险理赔" });

E("ANOMALY_NOTE", "anomaly-001", "2026-09-25T17:00:00+08:00", actors.borrowerCons, {
  note: "承借方文保实验室对裂纹做可逆转加固，湿度稳定一周后复评",
  action_taken: "B72 稀液微量渗透加固，保持原旧修不动",
  evidence_refs: ["treatment/anomaly-001/0925"],
}, { summary: "可逆加固处置记录" });

E("ANOMALY_CLOSED", "anomaly-001", "2026-10-02T10:00:00+08:00", actors.lenderCons, {
  resolution: "裂纹稳定无扩展，加固有效；返还时按出库基线 + 本异常逐条比对确认",
  signers: [
    sign("lender", actors.lenderCons, "2026-10-02T10:00:00+08:00"),
    sign("borrower", actors.borrowerCons, "2026-10-02T10:00:00+08:00"),
  ],
}, { summary: "异常关闭，双方会签" });

// --- 7. 图文视频使用许可与拍摄 ------------------------------------------------
E("MEDIA_GRANTED", "media-001", "2026-09-24T12:00:00+08:00", actors.lenderCons, {
  loan_id: LOAN,
  object_ids: ids(1, 12),
  media_types: ["photo", "graphic"],
  purposes: ["展览图录", "馆方公众号宣传"],
  channels: ["纸质图录", "山东某馆公众号"],
  restrictions: "不得用于商业广告；视频拍摄须另行申请；特写须避开 F001-edge-crack 做误导性裁切",
  valid_from: "2026-09-24T12:00:00+08:00",
  valid_to: "2026-10-20T17:00:00+08:00",
  granted_by: actors.lenderCons.person_id,
}, { summary: "出借方授予 12 件的图片与平面设计使用许可" });

E("MEDIA_USAGE_LOGGED", "media-001", "2026-09-28T10:30:00+08:00", actors.photographer, {
  loan_id: LOAN,
  object_ids: ["obj-001", "obj-004"],
  media_type: "photo",
  purpose: "展览图录",
  channel: "纸质图录",
  used_at: "2026-09-28T10:30:00+08:00",
  used_by: actors.photographer.person_id,
  ref: "shoot/catalog-0928/0142",
}, { summary: "图录拍摄使用，在许可范围与期限内" });

// --- 8. 布展、开放、展出期间温度超阈 → 有权限文保人员决定撤展 -----------------
const slotGroups = [
  ["slot-S01", ids(1, 9)], ["slot-S02", ids(10, 18)], ["slot-S03", ids(19, 27)],
  ["slot-S04", ids(28, 36)], ["slot-S05", ids(37, 45)], ["slot-S06", ids(46, 51)],
];
for (const [slotNo, objs] of slotGroups) {
  E("OBJECT_INSTALLED", slotNo, "2026-09-25T16:00:00+08:00", actors.curator, {
    loan_id: LOAN,
    slot_no: slotNo,
    venue: "山东某馆三层七号展厅",
    object_ids: objs,
    position_notes: "独立支架、低反射展柜",
  }, { summary: `${slotNo} 布展 ${objs.length} 件` });
}

E("EXHIBITION_OPENED", LOAN, "2026-09-26T09:00:00+08:00", actors.curator, {
  venue: "山东某馆三层七号展厅",
}, { summary: "展览对公众开放" });

E("THRESHOLD_SET", "mon-slot1", "2026-09-26T09:00:00+08:00", actors.borrowerCons, {
  loan_id: LOAN,
  scope: { kind: "zone", ref: "slot-S01" },
  metric: "temperature",
  unit: "C",
  min: 15,
  max: 25,
}, { summary: "S01 展柜温度阈值 15–25℃" });

E("SENSOR_READING", "mon-slot1", "2026-10-02T14:05:00+08:00", actors.system, {
  loan_id: LOAN,
  sensor_id: "sensor-case-s01",
  readings: [
    { metric: "temperature", value: 24.8, unit: "C", observed_at: "2026-10-02T13:00:00+08:00" },
    { metric: "temperature", value: 26.3, unit: "C", observed_at: "2026-10-02T13:30:00+08:00" },
    { metric: "temperature", value: 27.1, unit: "C", observed_at: "2026-10-02T14:00:00+08:00" },
  ],
}, { summary: "S01 空调故障期间温度读数", rest: { idempotency_key: "batch-s01-1002-a" } });

const tempRisks = reportDueExcursions(log, actors.system, LOAN);
const tempRisk = tempRisks.find((r) => r.payload.metric === "temperature");

E("RISK_DECISION", tempRisk.aggregate_id, "2026-10-02T15:00:00+08:00", actors.borrowerCons, {
  decision: "remove_from_display",
  decided_by: actors.borrowerCons,
  rationale: "S01 空调皮带断裂，升温趋势仍在继续；obj-002 为薄壁透雕，受热风险最高，先撤出该件",
}, { summary: "承借方文保人员决定：obj-002 撤出展出" });

E("OBJECT_REMOVED_FROM_DISPLAY", "obj-002", "2026-10-02T15:20:00+08:00", actors.borrowerCons, {
  loan_id: LOAN,
  slot_id: "slot-S01",
  reason: "risk_decision",
  risk_review_id: tempRisk.aggregate_id,
}, { summary: "依文保人员研判将 obj-002 撤入恒湿缓冲间" });

E("SLOT_ROTATED", "slot-S01", "2026-10-03T10:00:00+08:00", actors.curator, {
  loan_id: LOAN,
  slot_no: "slot-S01",
  removed_object_ids: ["obj-002"],
  installed_object_ids: ["obj-020"],
  reason: "风险撤展后展位补位轮换，obj-020 自 S03 调入",
}, { summary: "展位轮换：obj-002 撤、obj-020 补位" });

// --- 9. 紧急转移：先保护实物，后补双人确认 ------------------------------------
E("EVACUATION_STARTED", "evac-001", "2026-10-08T02:14:00+08:00", actors.borrowerCons, {
  loan_id: LOAN,
  object_ids: ["obj-007"],
  case_nos: [],
  from_location: "三层七号展厅 slot-S01 附近",
  reason: "顶层消防管道爆裂漏水，地面已见积水",
  immediate_action: "值班文保人员连同展柜内匣一起抱至二层内库缓冲间，全程约 4 分钟",
}, { summary: "凌晨漏水：先抢救实物，双人确认事后补" });

E("EVACUATION_CONFIRMED", "evac-001", "2026-10-08T08:30:00+08:00", actors.lenderCons, {
  second_person: actors.lenderCons,
  to_location: "二层内库缓冲间 B-12 架",
  condition_event_ids: [],
}, { summary: "出借方驻场人员到场核验，补齐双人确认；obj-007 检查无受潮" });

// --- 10. 撤展、回运、返还验收 ------------------------------------------------
for (let n = 1; n <= N; n += 1) {
  E("CONDITION_REPORTED", id(n), "2026-10-18T11:00:00+08:00", actors.borrowerCons, {
    loan_id: LOAN,
    stage: "撤展",
    signers: [sign("borrower", actors.borrowerCons, "2026-10-18T11:00:00+08:00")],
    overall_status: "stable",
    findings: n === 1
      ? [
          { code: "F001-old-repair", area: "左下角榫接处", description: "旧修补稳定", kind: "old_repair", severity: "minor" },
          { code: "F001-edge-crack", area: "左下角旧修旁约 2cm", description: "加固后裂纹稳定无扩展（anomaly-001）", kind: "new_damage", severity: "moderate" },
        ]
      : [],
  }, { summary: `${id(n)} 撤展状况检查` });
}

// case-G 并回 case-D 回运。
E("CASE_RECOMPOSED", "case-D", "2026-10-18T15:00:00+08:00", actors.courier, {
  loan_id: LOAN,
  case_no: "case-D",
  action: "merge",
  source_case_nos: ["case-D", "case-G"],
  object_ids: ids(28, 36),
  seal_no: "seal-case-D-02",
  note: "返运前将 case-G 的 32–36 件并回 case-D，恢复六箱编组",
}, { summary: "箱件重组：case-G 并回 case-D" });

for (const [caseNo, objs] of groups) {
  E("OBJECT_PACKED", caseNo, "2026-10-18T16:00:00+08:00", actors.courier, {
    loan_id: LOAN,
    case_no: caseNo,
    package_level: "外箱",
    materials: ["蜂窝纸板外箱", "EPE 缓冲层", "无酸纸内匣"],
    object_ids: objs,
    seal_no: `seal-${caseNo}-02`,
    packers: [actors.courier.name],
  }, { summary: `${caseNo} 返运重装 ${objs.length} 件` });
}

E("CUSTODY_TRANSFERRED", "handoff-H03", "2026-10-19T08:30:00+08:00", actors.borrowerCons, {
  loan_id: LOAN,
  handoff_no: "H03",
  stage: "回运",
  location: "山东某馆货运平台",
  from_party: "山东某馆",
  to_party: "安途文物运输",
  case_nos: ["case-A", "case-B", "case-C", "case-D", "case-E", "case-F"],
  object_ids: ALL,
  seal_nos: groups.map(([c]) => `seal-${c}-02`),
  signers: [sign("borrower", actors.borrowerCons, "2026-10-19T08:30:00+08:00"), sign("carrier", actors.carrier, "2026-10-19T08:30:00+08:00")],
}, { summary: "回运交接：承借方 → 承运方", rest: { idempotency_key: "H03" } });

E("CUSTODY_TRANSFERRED", "handoff-H04", "2026-10-20T10:00:00+08:00", actors.carrier, {
  loan_id: LOAN,
  handoff_no: "H04",
  stage: "返还验收",
  location: "绩溪县博物馆装卸区",
  from_party: "安途文物运输",
  to_party: "绩溪县博物馆",
  case_nos: ["case-A", "case-B", "case-C", "case-D", "case-E", "case-F"],
  object_ids: ALL,
  signers: [sign("carrier", actors.carrier, "2026-10-20T10:00:00+08:00"), sign("lender", actors.registrar, "2026-10-20T10:00:00+08:00")],
}, { summary: "运抵绩溪县博物馆：承运方 → 出借方", rest: { idempotency_key: "H04" } });

const returnReports = [];
for (let n = 1; n <= N; n += 1) {
  const isOne = n === 1;
  const event = E("CONDITION_REPORTED", id(n), "2026-10-20T14:00:00+08:00", actors.lenderCons, {
    loan_id: LOAN,
    stage: "返还验收",
    signers: [
      sign("lender", actors.lenderCons, "2026-10-20T14:00:00+08:00"),
      sign("borrower", actors.borrowerCons, "2026-10-20T14:00:00+08:00"),
    ],
    overall_status: isOne ? "stable" : "good",
    findings: isOne
      ? [
          { code: "F001-old-repair", area: "左下角榫接处", description: "旧修补与基线一致", kind: "old_repair", severity: "minor" },
          { code: "F001-edge-crack", area: "左下角旧修旁约 2cm", description: "借展期新发，已在 anomaly-001 登记处置，裂纹稳定", kind: "new_damage", severity: "moderate" },
        ]
      : [],
  }, { summary: `${id(n)} 返还验收状况（双方会签）` });
  returnReports.push(event);
}

E("RETURN_ACCEPTED", "return-001", "2026-10-20T16:00:00+08:00", actors.registrar, {
  loan_id: LOAN,
  acceptance_no: "RT2026-001",
  object_results: ALL.map((o) => o === "obj-001"
    ? { object_id: o, accepted: true, condition_vs_baseline: "new_discrepancy", finding_summary: "F001-edge-crack 已在 anomaly-001 全程记录并修复" }
    : { object_id: o, accepted: true, condition_vs_baseline: "match" }),
  acknowledged_discrepancies: [
    { object_id: "obj-001", anomaly_id: "anomaly-001", note: "双方确认裂纹系借展期新发、已加固稳定，按理赔流程处理" },
  ],
  signers: [
    sign("lender", actors.lenderCons, "2026-10-20T16:00:00+08:00"),
    sign("borrower", actors.borrowerCons, "2026-10-20T16:00:00+08:00"),
  ],
}, { summary: "51 件全部返还验收；唯一新差异逐条确认" });

E("LOAN_CLOSED", LOAN, "2026-10-20T17:00:00+08:00", actors.registrar, {
  returned_object_count: N,
}, { summary: "借展关账：返还 51/51" });

// --- 重放校验报告 -------------------------------------------------------------
await writeFile(new URL("../data/lifecycle.json", import.meta.url), JSON.stringify(log.all(), null, 2) + "\n", "utf8");
const report = { generated_at: new Date().toISOString(), loan_id: LOAN, event_count: log.size, checks: [] };
const check = (name, pass, detail) => report.checks.push({ name, pass: !!pass, detail });

// 1) 交接单重复上传不产生第二条记录。
const before = log.size;
const dupHandoff = log.ingest({
  event_id: "evt-foreign-dup-h02",
  event_type: "CUSTODY_TRANSFERRED",
  aggregate_type: "custody_handoff",
  aggregate_id: "handoff-H02",
  occurred_at: "2026-09-22T11:20:00+08:00",
  version: 99,
  summary: "承运方网络重试导致的重复交接单",
  actor: actors.carrier,
  idempotency_key: "H02",
  payload: { loan_id: LOAN, handoff_no: "H02", stage: "抵馆接收", from_party: "安途文物运输", to_party: "山东某馆", signers: [] },
});
check("同一交接单重复上传被幂等忽略", log.size === before && dupHandoff.status === "duplicate", `忽略原因：${dupHandoff.reason}`);

// 2) 传感器数据包重复上传不产生重复读数。
const seriesBefore = environmentSeries(log).find((s) => s.monitor_id === "mon-zone7" && s.metric === "relative_humidity").readings.length;
log.ingest({
  event_id: "evt-foreign-dup-batch",
  event_type: "SENSOR_READING",
  aggregate_type: "environment_monitor",
  aggregate_id: "mon-zone7",
  occurred_at: "2026-09-24T08:00:00+08:00",
  version: 99,
  summary: "网关重发的同一批读数",
  actor: actors.system,
  idempotency_key: "batch-truck-0921",
  payload: { sensor_id: "sensor-truck-03", readings: [] },
});
const seriesAfter = environmentSeries(log).find((s) => s.monitor_id === "mon-zone7" && s.metric === "relative_humidity").readings.length;
check("同一传感器数据包重复上传被幂等忽略", seriesBefore === seriesAfter, `湿度读数点数：${seriesAfter}`);

// 3) 时区不同但同一瞬时：Z 与 +08:00 写法归一，不产生虚假事故。
const tzLog = new EventLog();
const mkReading = (eid, observed, key) => tzLog.append({
  event_id: eid, event_type: "SENSOR_READING", aggregate_type: "environment_monitor", aggregate_id: "m-tz",
  occurred_at: "2026-09-21T08:00:00+08:00", version: tzLog.nextVersion("m-tz"), summary: "时区归一验证",
  actor: actors.system, idempotency_key: key,
  payload: { sensor_id: "s1", readings: [{ metric: "temperature", value: 22.0, unit: "C", observed_at: observed }] },
});
mkReading("tz-1", "2026-09-21T02:00:00Z", "k1");
mkReading("tz-2", "2026-09-21T10:00:00+08:00", "k2");
const tzSeries = environmentSeries(tzLog).find((s) => s.metric === "temperature");
check("Z 与 +08:00 两种写法指向同一瞬时只计一个读数", tzSeries.readings.length === 1, `读数点数：${tzSeries.readings.length}`);

// 4) 断网补报按 observed_at 归位，并只建一次风险单。
const rhRuns = excursionRuns(log).filter((r) => r.metric === "relative_humidity");
check("断网补报数据按采集时刻归位并识别出一次湿度超阈区间", rhRuns.length === 1 && rhRuns[0].peak_value === 64.0,
  JSON.stringify({ start: new Date(rhRuns[0]?.start_epoch).toISOString(), end: new Date(rhRuns[0]?.end_epoch).toISOString(), peak: rhRuns[0]?.peak_value }));
const secondPass = reportDueExcursions(log, actors.system, LOAN);
check("重复评估不会重复生成风险单", secondPass.length === 0, `第二次评估新建风险数：${secondPass.length}`);

// 5) 超阈值不自动撤展；撤展必须有文保人员决定。
const proj = new LoanProjection(log, LOAN);
const openBeforeDecision = true; // 流程中风险先 pending，再由人决定
try {
  const probe = new EventLog();
  // 最小反例：未经 RISK_DECISION 直接以风险为由撤展必须被拒。
  probe.append({ event_id: "x1", event_type: "OBJECT_REGISTERED", aggregate_type: "collection_object", aggregate_id: "o-x", occurred_at: "2026-09-19T00:00:00Z", version: 1, summary: "x", actor: actors.registrar, payload: { loan_id: "L", accession_no: "a", name: "n", material: "m" } });
  probe.append({ event_id: "x2", event_type: "OBJECT_REMOVED_FROM_DISPLAY", aggregate_type: "collection_object", aggregate_id: "o-x", occurred_at: "2026-09-20T00:00:00Z", version: 2, summary: "x", actor: actors.curator, payload: { loan_id: "L", slot_id: "s", reason: "risk_decision" } });
  check("无文保研判不得撤展", false, "应当拒绝但未拒绝");
} catch (err) {
  check("无文保研判不得撤展", err instanceof DomainError && err.code === "NO_REMOVAL_AUTHORIZATION", err.message);
}

// 6) 摄影师无权做风险研判。
try {
  log.append({
    event_id: "evt-forbidden-decision", event_type: "RISK_DECISION", aggregate_type: "risk_review",
    aggregate_id: humidityRisks[0].aggregate_id, occurred_at: "2026-10-01T00:00:00+08:00", version: 3,
    summary: "越权研判", actor: actors.photographer,
    payload: { decision: "remove_from_display", decided_by: actors.photographer, rationale: "test" },
  });
  check("撤展研判仅文保人员可提交", false, "摄影师提交成功");
} catch (err) {
  check("撤展研判仅文保人员可提交", err instanceof DomainError && err.code === "FORBIDDEN", err.message);
}

// 7) 紧急转移不能由同一人双签。
try {
  const ev = new EventLog();
  const base = { event_type: "EVACUATION_STARTED", aggregate_type: "emergency_evacuation", aggregate_id: "e1", occurred_at: "2026-10-08T02:00:00+08:00", version: 1, summary: "s", payload: { loan_id: "L", object_ids: ["o1"], from_location: "A", immediate_action: "转移" } };
  ev.append({ event_id: "e-s", ...base, actor: actors.borrowerCons });
  ev.append({ event_id: "e-c", event_type: "EVACUATION_CONFIRMED", aggregate_type: "emergency_evacuation", aggregate_id: "e1", occurred_at: "2026-10-08T03:00:00+08:00", version: 2, summary: "c", actor: actors.borrowerCons, payload: { second_person: actors.borrowerCons, to_location: "B" } });
  check("紧急转移双人确认不得为同一人", false, "同人确认成功");
} catch (err) {
  check("紧急转移双人确认不得为同一人", err instanceof DomainError && err.code === "SAME_PERSON_CONFIRMATION", err.message);
}

// 8) 箱件拆分/重组全程可逐件追溯。
const duringSplit = new LoanProjection(log, LOAN).caseContainment(Date.parse("2026-09-22T20:00:00+08:00"));
check("拆分后逐件归属正确（32–36 在 case-G，28–31 留 case-D）",
  ids(32, 36).every((o) => duringSplit.current.get(o) === "case-G") && ids(28, 31).every((o) => duringSplit.current.get(o) === "case-D"),
  `obj-032=${duringSplit.current.get("obj-032")}, obj-028=${duringSplit.current.get("obj-028")}`);
const afterMerge = new LoanProjection(log, LOAN).caseContainment();
check("返运重组后 28–36 全部回到 case-D", ids(28, 36).every((o) => afterMerge.current.get(o) === "case-D"), "");

// 9) 出借方远程看板：无未闭合异常（流程末端）。
const issues = proj.openIssues();
check("关账时无未闭合异常与待补双人确认",
  issues.anomalies_open.length === 0 && issues.evacuations_awaiting_second_confirmation.length === 0 && issues.risks_pending_decision.length === 0,
  JSON.stringify({ anomalies: issues.anomalies_open.length, evacuations: issues.evacuations_awaiting_second_confirmation.length, risks: issues.risks_pending_decision.length }));

// 10) 保险/审计损伤回看：F001-edge-crack → 站点、箱件、签收、环境曲线。
const trace = proj.damageTrace("obj-001", "F001-edge-crack", 72 * 3600_000);
check("损伤回看可定位首见站点、当时箱件、上一段签收与环境曲线",
  trace.found && trace.first_seen.stage === "开箱检查" && trace.case_at_time === "case-A"
  && trace.last_handoff_before_discovery.handoff_no === "H02"
  && trace.environment_curves.some((c) => c.metric === "relative_humidity" && c.readings.length >= 3),
  JSON.stringify({ stage: trace.first_seen?.stage, case: trace.case_at_time, handoff: trace.last_handoff_before_discovery?.handoff_no, curves: trace.environment_curves.map((c) => `${c.metric}:${c.readings.length}`) }));

// 11) 历史不可变：开箱报告仍保留首发裂纹原文。
const arrivalReport = log.byAggregate("obj-001").find((e) => e.event_type === "CONDITION_REPORTED" && e.payload.stage === "开箱检查");
check("前站签署的状况记录未被后续报告改写",
  arrivalReport.payload.findings.some((f) => f.code === "F001-edge-crack" && f.description.includes("开箱时首次发现")),
  "");

// 12) 许可控制：未许可的媒介/用途或超出期限的使用被拒。
{
  const m2 = new EventLog();
  m2.append({ event_id: "g", event_type: "MEDIA_GRANTED", aggregate_type: "media_grant", aggregate_id: "mg", occurred_at: "2026-09-24T12:00:00+08:00", version: 1, summary: "g", actor: actors.lenderCons, payload: { loan_id: LOAN, object_ids: ["obj-001"], media_types: ["photo"], purposes: ["展览图录"], valid_from: "2026-09-24T12:00:00+08:00", valid_to: "2026-10-20T17:00:00+08:00", granted_by: "p" } });
  const probes = [
    { at: "2026-09-28T10:00:00+08:00", media_type: "video", purpose: "展览图录", expect: "MEDIA_TYPE_NOT_LICENSED" },
    { at: "2026-09-28T10:00:00+08:00", media_type: "photo", purpose: "商业广告", expect: "MEDIA_PURPOSE_NOT_LICENSED" },
    { at: "2026-11-01T10:00:00+08:00", media_type: "photo", purpose: "展览图录", expect: "MEDIA_OUTSIDE_WINDOW" },
  ];
  const results = probes.map((probe) => {
    try {
      m2.append({ event_id: `u-${probe.expect}`, event_type: "MEDIA_USAGE_LOGGED", aggregate_type: "media_grant", aggregate_id: "mg", occurred_at: probe.at, version: m2.nextVersion("mg"), summary: "u", actor: actors.photographer, payload: { loan_id: LOAN, object_ids: ["obj-001"], media_type: probe.media_type, purpose: probe.purpose, used_at: probe.at, used_by: "x" } });
      return `${probe.expect}:未拒绝`;
    } catch (err) {
      return err.code === probe.expect ? `${probe.expect}:已拒绝` : `${probe.expect}:错误码=${err.code}`;
    }
  });
  check("超媒介/超用途/超期限使用分别被拒", results.every((r) => r.endsWith("已拒绝")), results.join("；"));
}

// 13) 返还数量不符不得关账。
{
  const c = new EventLog();
  c.append({ event_id: "r1", event_type: "OBJECT_REGISTERED", aggregate_type: "collection_object", aggregate_id: "o-x1", occurred_at: "2026-09-19T00:00:00+08:00", version: 1, summary: "登记一件", actor: actors.registrar, payload: { loan_id: "Lx", accession_no: "a", name: "n", material: "m" } });
  try {
    c.append({ event_id: "l1", event_type: "LOAN_CLOSED", aggregate_type: "loan", aggregate_id: "Lx", occurred_at: "2026-10-20T00:00:00+08:00", version: 1, summary: "c", actor: actors.registrar, payload: { returned_object_count: 0 } });
    check("返还数量与登记不符不得关账", false, "应当拒绝");
  } catch (err) {
    check("返还数量与登记不符不得关账", err instanceof DomainError && err.code === "COUNT_MISMATCH", err.message);
  }
}

// 14) 保管链序列与当前持有方。
const chain = proj.custodyChain();
check("保管链四段交接按时序完整", chain.handoffs.map((h) => h.handoff_no).join(",") === "H01,H02,H03,H04",
  chain.handoffs.map((h) => `${h.handoff_no}:${h.from_party}→${h.to_party}`).join(" | "));

await writeFile(new URL("../data/lifecycle-replay-report.json", import.meta.url), JSON.stringify(report, null, 2) + "\n", "utf8");

const failed = report.checks.filter((c) => !c.pass);
console.log(`事件流 ${log.size} 条，校验 ${report.checks.length} 项，失败 ${failed.length} 项`);
for (const c of report.checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
if (failed.length) process.exit(1);
