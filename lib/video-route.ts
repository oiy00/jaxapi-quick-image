import { fetchRelayMediaGrant, type RelayGrant } from "./relay-account.ts";
import { readVideoConfig, type LiveVideoConfig } from "./video-config.ts";
import { HttpBilling } from "./video-billing-port.ts";
import { VideoFlow, superGptUpstream, type FlowResult } from "./video-flow.ts";
import { FileJobStore } from "./video-store.ts";

export type VideoHttpDeps = {
  authenticate(token: string): Promise<RelayGrant>;
  flow: VideoFlow | null;
  unconfiguredCode?: "billing_unconfigured" | "upstream_unconfigured";
};

const MESSAGES = {
  billing_unconfigured: "视频扣费还没有接到已核实的账户余额接口，或持久任务目录未配置。已拒绝提交，没有调用视频上游。",
  upstream_unconfigured: "视频上游密钥未配置，已拒绝提交。",
  unauthorized: "登录已失效，没有提交。",
} as const;

export async function videoPost(request: Request, deps: VideoHttpDeps): Promise<Response> {
  const token = bearer(request);
  if (!token) return json({ ok: false, code: "unauthorized", message: MESSAGES.unauthorized }, 401);
  const grant = await deps.authenticate(token);
  if (!grant.ok) {
    const status = grant.code === "wrong_group" ? 403 : grant.code === "unauthorized" ? 401 : 504;
    const message =
      grant.code === "wrong_group"
        ? "当前账户没有媒体台分组 11 的可用密钥。不会使用分组 7。"
        : grant.code === "unauthorized"
          ? MESSAGES.unauthorized
          : "无法确认登录账户。没有向视频上游提交。";
    return json({ ok: false, code: grant.code, message }, status);
  }
  if (!deps.flow) {
    const code = deps.unconfiguredCode ?? "billing_unconfigured";
    return json({ ok: false, code, message: MESSAGES[code] }, 503);
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ ok: false, code: "forbidden", message: "请求无效，没有提交。" }, 400);
  const result = await deps.flow.submit({
    caller: { userId: grant.userId, groupId: grant.groupId, groupName: grant.groupName },
    idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
    model: typeof body.model === "string" ? body.model : "",
    duration: Number(body.duration),
    prompt: typeof body.prompt === "string" ? body.prompt : "",
    clientPriceUsd: typeof body.priceUsd === "number" ? body.priceUsd : undefined,
  });
  return json(result, result.http);
}

export async function videoStatus(request: Request, deps: VideoHttpDeps, jobId: string): Promise<Response> {
  const gate = await gateFlow(request, deps);
  if (gate instanceof Response) return gate;
  return json(await gate.flow.status(jobId, gate.userId), 200);
}

export async function videoByKey(request: Request, deps: VideoHttpDeps): Promise<Response> {
  const gate = await gateFlow(request, deps);
  if (gate instanceof Response) return gate;
  const key = new URL(request.url).searchParams.get("idempotencyKey") || "";
  const result = await gate.flow.statusByIdempotency(key, gate.userId);
  return json(result, result.http);
}

export async function videoContent(request: Request, deps: VideoHttpDeps, jobId: string): Promise<Response> {
  const gate = await gateFlow(request, deps);
  if (gate instanceof Response) return gate;
  const { result, payload } = await gate.flow.content(jobId, gate.userId);
  if (!result.ok || payload?.kind !== "ready") return json(result, result.http);
  return new Response(Buffer.from(payload.body), {
    status: 200,
    headers: {
      "content-type": payload.contentType || "video/mp4",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function liveVideoDeps(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): VideoHttpDeps {
  const config = readVideoConfig(env);
  return {
    authenticate: (token) =>
      fetchRelayMediaGrant({
        baseUrl: config.ok ? config.config.jaxapiBaseUrl : env.JAXAPI_BASE_URL?.trim() || "https://jaxapi.top",
        token,
        fetchImpl,
      }),
    flow: config.ok ? createLiveFlow(config.config, fetchImpl) : null,
    unconfiguredCode: config.ok ? undefined : config.code,
  };
}

export function createLiveFlow(config: LiveVideoConfig, fetchImpl: typeof fetch = fetch): VideoFlow {
  return new VideoFlow(
    new FileJobStore(config.storePath),
    new HttpBilling(config.billingUrl, config.billingToken, fetchImpl),
    superGptUpstream({ baseUrl: config.supergptBase, apiKey: config.supergptKey, fetchImpl }),
  );
}

async function gateFlow(request: Request, deps: VideoHttpDeps): Promise<Response | { flow: VideoFlow; userId: number }> {
  const token = bearer(request);
  if (!token) return json({ ok: false, code: "unauthorized", message: MESSAGES.unauthorized }, 401);
  const grant = await deps.authenticate(token);
  if (!grant.ok) return json({ ok: false, code: grant.code, message: "没有找到这个任务。" }, grant.code === "unauthorized" ? 401 : 404);
  if (!deps.flow) {
    const code = deps.unconfiguredCode ?? "billing_unconfigured";
    return json({ ok: false, code, message: MESSAGES[code] }, 503);
  }
  return { flow: deps.flow, userId: grant.userId };
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match?.[1]?.trim() || "";
}

function json(body: FlowResult | Record<string, unknown>, status: number): Response {
  const record = body as Record<string, unknown>;
  const http = typeof record.http === "number" ? record.http : status;
  const payload = { ...record };
  delete payload.http;
  return Response.json(payload, { status: http, headers: { "cache-control": "no-store" } });
}
