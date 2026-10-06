import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EVENT_AGGREGATE, PAYLOAD_REQUIRED } from "../src/event-types.js";

const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));

test("事件类型目录与 schema enum 一致，且每类事件都有 payload 分支", () => {
  const enumTypes = schema.$defs.eventType.enum;
  assert.deepEqual([...enumTypes].sort(), Object.keys(EVENT_AGGREGATE).sort());

  const branches = schema.oneOf.map((branch) => ({
    type: branch.properties.event_type.const,
    aggregate: branch.properties.aggregate_type.const,
    payloadRequired: branch.properties.payload.required ?? [],
  }));
  assert.equal(branches.length, enumTypes.length, "每类事件都应有独立 oneOf 分支");

  for (const b of branches) {
    assert.equal(EVENT_AGGREGATE[b.type], b.aggregate, `${b.type} 的聚合归属与 schema 不一致`);
    const codeRequired = PAYLOAD_REQUIRED[b.type] ?? [];
    assert.deepEqual([...b.payloadRequired].sort(), [...codeRequired].sort(), `${b.type} 的 payload 必填字段与 schema 不一致`);
  }
});

test("聚合类型与角色目录在 schema 与实现中一致", () => {
  const schemaAggregates = schema.$defs.aggregateType.enum;
  assert.deepEqual([...new Set(Object.values(EVENT_AGGREGATE))].sort(), [...schemaAggregates].sort());
});
