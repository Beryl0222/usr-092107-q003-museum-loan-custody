import { LoanService } from "../src/services/loanService.js";
import { EventStore } from "../src/store/eventStore.js";

export const LOAN_ID = "loan-jx-sd-2026";
export const ORGS = {
  lender: "jixi-museum",
  borrower: "shandong-museum",
  carrier: "anyun-logistics",
};

export function makeContext() {
  const store = new EventStore();
  const service = new LoanService(store);
  const actors = {
    registrar: { id: "reg-01", role: "registrar", org: ORGS.lender },
    lender: { id: "wen-01", role: "lender_conservator", org: ORGS.lender },
    lender2: { id: "wen-02", role: "lender_conservator", org: ORGS.lender },
    lead: { id: "wen-lead", role: "lender_conservator", org: ORGS.lender },
    borrower: { id: "bao-01", role: "borrower_conservator", org: ORGS.borrower },
    borrower2: { id: "bao-02", role: "borrower_conservator", org: ORGS.borrower },
    carrier: { id: "yun-01", role: "carrier", org: ORGS.carrier },
    device: { id: "dev-01", role: "device", org: "sensor-hub" },
    auditor: { id: "shen-01", role: "auditor", org: "insurer-audit" },
  };
  return { store, service, actors };
}

export function bootstrapLoan(service, actors, { objectIds = ["obj-001"] } = {}) {
  service.registerLoan(actors.registrar, {
    loan_id: LOAN_ID,
    lender_org: ORGS.lender,
    borrower_org: ORGS.borrower,
    object_ids: objectIds,
    period: { start: "2026-09-01T00:00:00+08:00", end: "2027-03-01T00:00:00+08:00" },
    venue: "山东博物馆特展厅",
    decision_makers: ["wen-lead"],
    at: "2026-08-20T09:00:00+08:00",
  });
  for (const objectId of objectIds) {
    service.registerObject(actors.registrar, {
      loan_id: LOAN_ID,
      object_id: objectId,
      name: `徽州木雕·${objectId}`,
      category: "徽州木雕",
      historical_condition: [{ part: "边框", description: "民国年间补配雕花一角", severity: "stable" }],
      at: "2026-08-21T09:00:00+08:00",
    });
  }
  service.setThresholds(actors.lender, {
    loan_id: LOAN_ID,
    rules: [
      { metric: "humidity", min: 45, max: 60, unit: "%RH" },
      { metric: "temperature", min: 16, max: 24, unit: "°C" },
    ],
    at: "2026-08-22T09:00:00+08:00",
  });
  service.grantLicense(actors.lender, {
    license_id: "lic-01",
    loan_id: LOAN_ID,
    licensor_org: ORGS.lender,
    licensee_org: ORGS.borrower,
    object_ids: objectIds,
    allowed_uses: ["display", "photo"],
    valid_period: { start: "2026-09-01T00:00:00+08:00", end: "2027-03-01T00:00:00+08:00" },
    restrictions: ["no_flash"],
    at: "2026-08-23T09:00:00+08:00",
  });
  return LOAN_ID;
}

// 装箱并完成 出借方→承运→承借方 的两段交接。
export function packAndShip(service, actors, { objectIds, caseId = "case-01" }) {
  service.assembleCase(actors.lender, {
    loan_id: LOAN_ID,
    case_id: caseId,
    case_type: "outer",
    object_ids: [],
    at: "2026-09-01T09:00:00+08:00",
  });
  for (const objectId of objectIds) {
    service.packObject(actors.lender, {
      loan_id: LOAN_ID,
      object_id: objectId,
      case_id: caseId,
      at: "2026-09-01T10:00:00+08:00",
    });
  }
  const sign = (a, b) => [
    { signer_id: a.id, signer_org: a.org, role: a.role, signed_at: "2026-09-02T09:00:00+08:00" },
    { signer_id: b.id, signer_org: b.org, role: b.role, signed_at: "2026-09-02T09:05:00+08:00" },
  ];
  service.transferCustody(actors.carrier, {
    handoff_id: "ho-01",
    loan_id: LOAN_ID,
    from_org: ORGS.lender,
    to_org: ORGS.carrier,
    object_ids: objectIds,
    case_ids: [caseId],
    location: "绩溪县博物馆库房",
    signatures: sign(actors.lender, actors.carrier),
    at: "2026-09-02T09:00:00+08:00",
  });
  service.transferCustody(actors.carrier, {
    handoff_id: "ho-02",
    loan_id: LOAN_ID,
    from_org: ORGS.carrier,
    to_org: ORGS.borrower,
    object_ids: objectIds,
    case_ids: [caseId],
    location: "山东博物馆卸货区",
    signatures: sign(actors.carrier, actors.borrower),
    at: "2026-09-04T10:00:00+08:00",
  });
  return caseId;
}
