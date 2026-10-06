import { createServer } from "node:http";

import { redactInsurance, redactSignatures } from "../domain/policies.js";
import * as proj from "../projections/index.js";
import { LoanService } from "../services/loanService.js";
import { EventStore } from "../store/eventStore.js";

const COMMANDS = [
  "registerLoan",
  "registerObject",
  "setThresholds",
  "bindInsurance",
  "grantLicense",
  "assembleCase",
  "packObject",
  "splitCase",
  "recombineCase",
  "transferCustody",
  "inspect",
  "recordFinding",
  "signCondition",
  "ingestReadings",
  "resolveRisk",
  "openException",
  "emergencyMove",
  "confirmEmergency",
  "closeException",
  "rotateDisplay",
  "logMediaUsage",
  "acceptReturn",
];

function actorFrom(headers) {
  return {
    id: headers["x-actor-id"],
    role: headers["x-actor-role"],
    org: headers["x-actor-org"],
  };
}

function send(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function buildServer(store = new EventStore()) {
  const service = new LoanService(store);

  const routes = {
    "GET /health": async () => ({ status: "ok", events: store.all().length }),

    "POST /commands/:command": async ({ params, body }) => {
      const method = params.command;
      if (!COMMANDS.includes(method)) {
        const err = new Error(`未知命令：${method}`);
        err.status = 404;
        throw err;
      }
      const { actor, ...args } = body;
      return service[method](actor, args);
    },

    // 出借方远程查看：保管链与未闭合异常。
    "GET /loans/:loanId/custody-chain": async ({ query }) => {
      const objectId = query.get("object_id");
      if (!objectId) throw Object.assign(new Error("缺少 object_id"), { status: 400 });
      return proj.custodyChain(store, objectId);
    },
    "GET /loans/:loanId/open-items": async ({ params }) => proj.openItems(store, params.loanId),
    "GET /loans/:loanId/environment": async ({ query }) => {
      const caseIds = query.get("case_id")?.split(",").filter(Boolean);
      return proj.readingsOf(store, {
        caseIds: caseIds?.length ? caseIds : undefined,
        from: query.get("from") ?? undefined,
        to: query.get("to") ?? undefined,
      });
    },

    "GET /objects/:objectId/condition-history": async ({ params }) =>
      proj.conditionReports(store, params.objectId),
    "GET /objects/:objectId/trace": async ({ params }) => ({
      custody_chain: proj.custodyChain(store, params.objectId),
      case_lineage: proj.caseMembershipHistory(store, params.objectId),
    }),
    "GET /cases/:caseId/contents": async ({ params }) => {
      const { contents } = proj.caseContents(store);
      return { case_id: params.caseId, object_ids: [...(contents.get(params.caseId) ?? [])] };
    },

    // 保险/审计：从一处损伤回看箱件、环境曲线与签收证据。
    "GET /findings/:reportId/:findingId/trace": async ({ params, actor }) => {
      const trace = proj.traceFinding(store, params.reportId, params.findingId);
      if (!trace) throw Object.assign(new Error("报告不存在"), { status: 404 });
      return {
        ...trace,
        handoffs: trace.handoffs.map((h) => ({ ...h, signatures: redactSignatures(h.signatures, actor.role) })),
      };
    },
    "GET /policies/:policyId": async ({ params, actor }) => {
      const policy = proj.insuranceOf(store, params.policyId);
      if (!policy) throw Object.assign(new Error("保险单不存在"), { status: 404 });
      return redactInsurance(policy.payload, actor.role);
    },
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const segments = url.pathname.split("/").filter(Boolean);
      for (const [pattern, handler] of Object.entries(routes)) {
        const [method, ...pathParts] = pattern.split(" ");
        if (method !== req.method) continue;
        const patternSegments = pathParts.join(" ").split("/").filter(Boolean);
        if (patternSegments.length !== segments.length) continue;
        const params = {};
        const matched = patternSegments.every((seg, i) => {
          if (seg.startsWith(":")) {
            params[seg.slice(1)] = decodeURIComponent(segments[i]);
            return true;
          }
          return seg === segments[i];
        });
        if (!matched) continue;
        const body = req.method === "POST" ? await readBody(req) : {};
        const result = await handler({
          params,
          query: url.searchParams,
          body,
          actor: body.actor ?? actorFrom(req.headers),
        });
        return send(res, 200, result ?? {});
      }
      send(res, 404, { error: `未匹配路由：${req.method} ${url.pathname}` });
    } catch (err) {
      const status = err.status ?? (err.code === "PERMISSION" ? 403 : err.code === "CONFLICT" ? 409 : err.code ? 400 : 500);
      send(res, status, { error: err.message, code: err.code ?? "INTERNAL" });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  buildServer().listen(port, () => {
    console.log(`借展护送后端已启动：http://localhost:${port}`);
  });
}
