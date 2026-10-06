export class PermissionError extends Error {
  constructor(message) {
    super(message);
    this.name = "PermissionError";
    this.code = "PERMISSION";
  }
}

export class StateError extends Error {
  constructor(message) {
    super(message);
    this.name = "StateError";
    this.code = "STATE";
  }
}

export const ROLES = {
  REGISTRAR: "registrar",
  LENDER_CONSERVATOR: "lender_conservator",
  BORROWER_CONSERVATOR: "borrower_conservator",
  CARRIER: "carrier",
  DEVICE: "device",
  AUDITOR: "auditor",
};

export const CONSERVATOR_ROLES = [ROLES.LENDER_CONSERVATOR, ROLES.BORROWER_CONSERVATOR];

export function requireRole(actor, roles, action) {
  if (!actor || !roles.includes(actor.role)) {
    throw new PermissionError(`${action}需要角色：${roles.join(" 或 ")}`);
  }
}

// 是否撤展等关键决定只能由借展协议登记的 decision_makers 作出。
export function requireDecisionMaker(actor, loan, action) {
  const makers = loan?.payload?.decision_makers ?? [];
  if (!actor || !makers.includes(actor.id)) {
    throw new PermissionError(`${action}只能由借展协议授权的文保人员决定`);
  }
}

const INSURANCE_SENSITIVE_FIELDS = ["amount", "premium"];

// 个人、机构及商业敏感信息仅向履行职责所需的调用方开放。
export function redactInsurance(payload, role) {
  if ([ROLES.AUDITOR, ROLES.LENDER_CONSERVATOR, ROLES.REGISTRAR].includes(role)) return payload;
  const redacted = { ...payload };
  for (const field of INSURANCE_SENSITIVE_FIELDS) {
    if (field in redacted) redacted[field] = "（按角色隐藏）";
  }
  return redacted;
}

export function redactSignatures(signatures, role) {
  if ([ROLES.AUDITOR, ROLES.LENDER_CONSERVATOR, ROLES.BORROWER_CONSERVATOR, ROLES.REGISTRAR].includes(role)) {
    return signatures;
  }
  return signatures.map((s) => ({ ...s, signer_id: "（按角色隐藏）" }));
}
