# 跨馆木雕借展护送台

绩溪县博物馆把徽州木雕借往外地展出时，两馆文保部门在**运输、布展、开放、返还**之间连续交接实物。本仓库是这套“借展护送后端”的领域内核：藏品身份、历史状况、包装层级、环境阈值、保险范围、承运交接、开箱检查、展位轮换、图文视频使用许可、异常处置与返还验收，全部以**仅追加的领域事件**作为跨机构交换的最小约定。

- `contracts/domain.schema.json`：事件信封、聚合、角色、28 类事件及其 payload 最小约定（JSON Schema 2020-12）。
- `src/event-types.js`：事件目录与信封/时间戳结构校验。
- `src/model.js`：仅追加事件日志（版本、幂等、角色权限、跨事件规则）与读模型投影。
- `data/sample.json`：单条信封样例；`data/lifecycle.json`：51 件木雕赴山东借展的全流程事件流。
- `data/lifecycle-replay-report.json`：对全流程事件流重放后得到的 16 项不变量校验报告。
- `scripts/build-lifecycle.js`：生成全流程数据并自检。
- `tests/`：契约、schema 同步与业务不变量测试（共 20 项）。

## 核心原则

1. **事件不可变。** 记录一经接收，`event_id`、`occurred_at`、`version` 以及前一站已签署的状况一律不得原地改写；更正只能追加带 `correction_of` 的后继记录。状况检查可以补充新发现（旧修补痕迹、新损伤用稳定的 finding code 跨站引用），但不改写前站文本。
2. **箱件谱系逐件可追。** 外箱/内匣/缓冲层包装、开箱、拆分（split）、并箱（merge）、重装（repack）都逐件挂到具体藏品；任何时刻可回放“某件在哪个箱里、封签号是多少”。
3. **时间必须带时区。** `occurred_at` 与传感器 `observed_at` 只接受带偏移的 RFC3339（`Z` 或 `±HH:MM`），按统一瞬时排序，山东与安徽或 `Z` 写法混用时不错序。
4. **断网补报不制造事故。** 传感器以 `observed_at`（采集时刻）归位，`recorded_at`（接收时刻）仅用于标识补报；同测点同瞬时读数（含两种时区写法）去重；同一交接单/数据包重复上传按 `idempotency_key` 只生效一次。
5. **超阈值 ≠ 事故。** 越限只生成 `EXCURSION_REPORTED`（状态恒为 `pending_review`）；是否撤展必须由出借方或承借方**文保人员**通过 `RISK_DECISION` 决定，系统不自动撤展。
6. **紧急转移先实物后手续。** `EVACUATION_STARTED` 记录值班人员的先期处置，`EVACUATION_CONFIRMED` 事后补齐双人确认；确认人不得是发起人本人。未闭合的“待补确认”在出借方看板上挂起。
7. **权责按交接段界定。** 每次 `CUSTODY_TRANSFERRED` 记录段、地点、封签与双方签收；保管链按时序串联。
8. **许可与保险钉到件、钉到期。** 图文视频使用受媒介类型、用途、对象清单、有效期与撤销约束；保险理赔必须落在保单清单、保障期间内并关联已立案异常。
9. **返还关账必须账实相符。** `RETURN_ACCEPTED` 须双方会签，凡 `new_discrepancy` 逐条确认；登记数与返还数一致才允许 `LOAN_CLOSED`。

个人信息（签署人）与商业敏感信息（保额、理赔金额）仅向履行职责所需的调用方开放；事件本身只承担最小交换约定。

## 事件目录

| 聚合 | 事件 |
| --- | --- |
| `loan` | `LOAN_AGREED`、`EXHIBITION_OPENED`、`LOAN_CLOSED` |
| `collection_object` | `OBJECT_REGISTERED`、`CONDITION_REPORTED`、`OBJECT_REMOVED_FROM_DISPLAY` |
| `shipping_case` | `OBJECT_PACKED`、`OBJECT_UNPACKED`、`CASE_RECOMPOSED` |
| `custody_handoff` | `CUSTODY_TRANSFERRED` |
| `environment_monitor` | `THRESHOLD_SET`、`SENSOR_READING` |
| `risk_review` | `EXCURSION_REPORTED`、`RISK_DECISION` |
| `condition_anomaly` | `ANOMALY_OPENED`、`ANOMALY_NOTE`、`ANOMALY_CLOSED` |
| `emergency_evacuation` | `EVACUATION_STARTED`、`EVACUATION_CONFIRMED` |
| `exhibition_slot` | `OBJECT_INSTALLED`、`SLOT_ROTATED` |
| `media_grant` | `MEDIA_GRANTED`、`MEDIA_USAGE_LOGGED`、`MEDIA_REVOKED` |
| `insurance_policy` | `INSURANCE_BOUND`、`CLAIM_FILED` |
| `return_acceptance` | `RETURN_ACCEPTED` |

信封统一字段：`event_id`、`event_type`、`aggregate_type`、`aggregate_id`、`occurred_at`、`recorded_at?`、`version`（聚合内严格递增）、`summary`、`actor`（含机构与角色）、`idempotency_key?`、`correction_of?`、`payload`。

角色：`LENDER_CONSERVATOR`、`BORROWER_CONSERVATOR`、`COURIER`、`CARRIER`、`REGISTRAR`、`CURATOR`、`PHOTOGRAPHER`、`INSURANCE_AUDITOR`、`SYSTEM`、`ADMIN`。各事件类型允许的提交角色见 `src/model.js` 的 `ROLE_MATRIX`（例如撤展研判仅两类文保人员，传感器读数仅 `SYSTEM`）。

## 读模型视图

`LoanProjection` 从事件流重放，面向三类调用方：

- **出借方（远程）**：`custodyChain()` 保管链与当前持有方；`openIssues()` 未闭合异常、待补双人确认、待研判风险；`conditionTimeline(objectId)` 各站签署状况。
- **承借方（现场）**：`caseContainment(at?)` 箱件归属与谱系；`mediaGrants()` 许可范围与已使用记录；`risks()` 风险与研判结论。
- **保险/审计**：`damageTrace(objectId, findingCode)` 从一处损伤回看首见站点、当时所在箱件与开箱状态、前一段交接签收证据、同时段环境曲线；`insurance()` 保单与理赔。

## 全流程样例

`data/lifecycle.json`（311 条事件）覆盖：协议与保险 → 51 件登记与出库点交（obj-001 带 1990 年代旧修补基线）→ 六箱包装与发运 → 运输湿度断网补报（`Z` 与 `+08:00` 混写，短时 64%RH）→ 抵馆签收、case-D 因货梯限界拆出 case-G、开箱会签（obj-001 旧修旁新发裂纹）→ 异常立案、可逆加固、理赔、风险研判（继续观察）→ 图片许可与图录拍摄 → 布展开放、展柜升温、文保人员决定撤出 obj-002、展位补位 → 凌晨漏水紧急转移 obj-007（先转移、后补双人确认）→ 撤展、case-G 并回 case-D、回运 → 返还双方会签、唯一新差异逐条确认、51/51 关账。

## 本地检查

```bash
node --test            # 契约 + 20 项不变量
npm run build:data     # 重新生成全流程事件流与重放报告（含 16 项自检）
```
