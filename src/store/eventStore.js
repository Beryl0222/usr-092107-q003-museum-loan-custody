import { validateEvent } from "../validator.js";

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

// 递归排序键，得到与键序无关的规范化串，用于识别"同一事件重复上传"。
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function toInstant(timestamp) {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) throw new StoreError("VALIDATION", `无法解析时间：${timestamp}`);
  return new Date(ms).toISOString();
}

/**
 * 追加式事件存储：记录一经接收，标识、发生时间与版本不得原地改写。
 * - event_id 相同且内容一致的重传按幂等成功处理，内容不同则冲突；
 * - idempotency_key 命中历史记录时直接返回原记录，不产生新事件；
 * - version 在同一聚合流内必须严格递增；
 * - occurred_at 归一化为 UTC 的 occurred_instant，时区差异不影响排序与判重。
 */
export class EventStore {
  #events = [];
  #byId = new Map();
  #fingerprints = new Map();
  #byIdempotencyKey = new Map();
  #streamHeads = new Map();

  append(raw) {
    const errors = validateEvent(raw);
    if (errors.length > 0) throw new StoreError("VALIDATION", errors.join("；"));

    const instant = toInstant(raw.occurred_at);
    // 指纹只含调用方字段，发生时间按 UTC 归一，不同时区写法视为同一事件。
    const fingerprint = canonical({ ...raw, occurred_at: instant });

    const existing = this.#byId.get(raw.event_id);
    if (existing) {
      if (this.#fingerprints.get(raw.event_id) === fingerprint) {
        return { event: existing, deduplicated: true };
      }
      throw new StoreError("CONFLICT", `event_id 已存在且内容不同：${raw.event_id}`);
    }

    if (raw.idempotency_key) {
      const prior = this.#byIdempotencyKey.get(raw.idempotency_key);
      if (prior) return { event: prior, deduplicated: true };
    }

    const streamKey = `${raw.aggregate_type}:${raw.aggregate_id}`;
    const head = this.#streamHeads.get(streamKey) ?? 0;
    if (raw.version !== head + 1) {
      throw new StoreError("CONFLICT", `聚合 ${streamKey} 期望 version=${head + 1}，收到 ${raw.version}`);
    }

    const event = { ...raw, occurred_instant: instant, seq: this.#events.length + 1 };
    this.#events.push(event);
    this.#byId.set(event.event_id, event);
    this.#fingerprints.set(event.event_id, fingerprint);
    if (event.idempotency_key) this.#byIdempotencyKey.set(event.idempotency_key, event);
    this.#streamHeads.set(streamKey, event.version);
    return { event, deduplicated: false };
  }

  nextVersion(aggregateType, aggregateId) {
    return (this.#streamHeads.get(`${aggregateType}:${aggregateId}`) ?? 0) + 1;
  }

  findByIdempotencyKey(key) {
    return this.#byIdempotencyKey.get(key);
  }

  stream(aggregateType, aggregateId) {
    return this.#events
      .filter((e) => e.aggregate_type === aggregateType && e.aggregate_id === aggregateId)
      .sort((a, b) => a.version - b.version);
  }

  all() {
    return [...this.#events].sort((a, b) => a.seq - b.seq);
  }

  ofType(eventType) {
    return this.all().filter((e) => e.event_type === eventType);
  }

  ofLoan(loanId) {
    return this.all().filter((e) => e.loan_id === loanId || e.payload?.loan_id === loanId);
  }

  find(eventType, predicate) {
    return this.ofType(eventType).filter(predicate);
  }

  latest(eventType, predicate) {
    const matches = this.find(eventType, predicate);
    return matches[matches.length - 1];
  }
}
