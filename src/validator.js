import { readFileSync, readdirSync } from "node:fs";

// 逐事件最小字段约定来自 contracts/events/，仓库即跨机构交换的合同。
const contractsDir = new URL("../contracts/events/", import.meta.url);
const contracts = new Map();
for (const file of readdirSync(contractsDir)) {
  if (!file.endsWith(".json")) continue;
  const contract = JSON.parse(readFileSync(new URL(file, contractsDir), "utf8"));
  contracts.set(contract.event_type, contract);
}

const ENVELOPE_REQUIRED = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export const EVENT_TYPES = [...contracts.keys()];

export function contractFor(eventType) {
  return contracts.get(eventType);
}

export function validateEvent(record) {
  const errors = [];
  for (const name of ENVELOPE_REQUIRED) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 不是可解析的时间");
  }
  const contract = contracts.get(record.event_type);
  if (!contract) {
    if ("event_type" in record) errors.push(`未知事件类型：${record.event_type}`);
    return errors;
  }
  if (record.aggregate_type && record.aggregate_type !== contract.aggregate_type) {
    errors.push(`事件 ${record.event_type} 的 aggregate_type 应为 ${contract.aggregate_type}`);
  }
  const payload = record.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    errors.push("payload 必须是对象");
  } else {
    for (const field of contract.payload_required) {
      if (!(field in payload) || payload[field] === null || payload[field] === undefined) {
        errors.push(`payload 缺少字段：${field}`);
      }
    }
  }
  return errors;
}
