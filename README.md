# 跨馆木雕借展护送台

两馆文保部门共用的借展护送后端：以绩溪县博物馆 51 件徽州木雕借往山东展出为蓝本，覆盖运输、布展、开放和返还之间的连续实物交接。仓库里的事件字段是跨机构交换的最小约定——任何一方的系统只要能产出、消费这些事件，就能同另一方对账。

## 覆盖范围

藏品身份与历史状况、包装层级、环境阈值、保险范围、承运交接、开箱检查、展位轮换、图文视频使用许可、异常处置、返还验收。

## 资料结构

- `contracts/domain.schema.json`：事件信封（必填字段、事件类型与聚合类型枚举）。
- `contracts/events/<EVENT_TYPE>.json`：逐事件的最小 payload 字段约定，共 25 类事件。
- `src/validator.js`：按契约校验事件信封与 payload。
- `src/store/eventStore.js`：追加式事件存储。
- `src/services/loanService.js`：全部业务命令（规则在这里强制执行）。
- `src/projections/index.js`：读模型——保管链、未闭合异常、状况史、箱件谱系、损伤回溯。
- `src/http/server.js`：HTTP 接口（`POST /commands/:命令`，只读 GET 端点）。
- `scripts/demo.js`：绩溪 → 山东 51 件木雕的端到端演示。
- `tests/`：逐条业务规则的行为测试。

## 关键规则与落点

- **记录不可改写**：事件一经接收，`event_id`、`occurred_at`、`version` 不得原地改写；更正只能以后继事件表达。同一聚合流内 `version` 严格递增。
- **状况只增不改**：检查报告签署后冻结，补充新发现只能写进新报告（`FINDING_RECORDED` 对已签署报告直接拒绝）。
- **箱件守恒**：拆分必须恰好划分原箱内容，重组必须等于来源之并集；任何时刻每件藏品都能追到具体箱件及其驻留历史。
- **不制造虚假事故**：交接单按 `handoff:{交接单号}` 幂等，重复上传返回原记录；传感器读数按（传感器, 指标, UTC 时刻）去重，断网补报归位到 `measured_at`；`occurred_at` 归一化为 UTC，时区写法不同不判为两笔。补报导致超阈值窗口合并时，失效风险以 `superseded_by_backfill` 标注而非留存。
- **阈值只生待研判风险**：超阈值仅产生 `RISK_RAISED(PENDING)`，系统不自动立案、不自动撤展；`RISK_RESOLVED` / `DEINSTALL_ORDERED` 只能由借展协议登记的 `decision_makers` 作出。
- **紧急转移先实物后手续**：单人即可记录 `EMERGENCY_MOVED`，异常保持"待双人确认"；两名不同人员（至少一人非执行人）补齐 `EMERGENCY_CONFIRMED` 前，异常不能闭合。
- **按许可展陈与拍摄**：`DISPLAY_ROTATED` / `MEDIA_USAGE_LOGGED` 校验许可的藏品范围、用途与有效期；已撤展藏品拒绝轮换。
- **返还验收**：验收依据必须是已签署的 `pre_return`/`return` 报告；报告中的新发现自动成为差异并立案 `EXCEPTION_OPENED(damage)`。
- **敏感信息按需开放**：保额、保费对承运方脱敏，签署人标识对非履职角色脱敏（`src/domain/policies.js`）。

## 角色

`registrar`（登记）、`lender_conservator` / `borrower_conservator`（双方文保）、`carrier`（承运）、`device`（传感器）、`auditor`（保险/审计，只读）。撤展等关键决定只认协议里的 `decision_makers`。

## 本地检查与演示

```bash
node --test      # 37 个行为测试
npm run demo     # 51 件木雕借展全程演示
npm start        # 启动 HTTP 服务（默认 :8080）
```

## HTTP 接口速览

- `POST /commands/:command`：业务命令，body 为 `{ actor: {id, role, org}, ...参数 }`，命令名同 `LoanService` 方法（如 `transferCustody`、`ingestReadings`、`acceptReturn`）。
- `GET /loans/:loanId/custody-chain?object_id=`：保管链（出借方远程可见）。
- `GET /loans/:loanId/open-items`：未闭合异常与待研判风险。
- `GET /loans/:loanId/environment?case_id=&from=&to=`：环境曲线。
- `GET /objects/:objectId/condition-history`：各站签署状况。
- `GET /findings/:reportId/:findingId/trace`：从一处损伤回看箱件、环境曲线与签收证据（保险/审计）。
- `GET /policies/:policyId`：保险单（按角色脱敏）。
