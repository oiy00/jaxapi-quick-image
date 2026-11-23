import { assertSuperGptBase } from "./supergpt-video.ts";

export type LiveVideoConfig = {
  supergptBase: string;
  supergptKey: string;
  billingUrl: string;
  billingToken: string;
  storePath: string;
  jaxapiBaseUrl: string;
};

export type VideoConfigResult = { ok: true; config: LiveVideoConfig } | { ok: false; code: "billing_unconfigured" | "upstream_unconfigured" };

export function readVideoConfig(env: NodeJS.ProcessEnv = process.env): VideoConfigResult {
  const adapter = (env.VIDEO_BILLING_ADAPTER || "off").trim().toLowerCase();
  const billingUrl = env.VIDEO_BILLING_URL?.trim() || "";
  const billingToken = env.VIDEO_BILLING_TOKEN?.trim() || "";
  const supergptKey = env.SUPERGPT_API_KEY?.trim() || "";
  // Stock Sub2API video prices and admin balance edits are not accepted adapters.
  if (adapter === "sql" || adapter === "database" || adapter === "sub2api" || adapter === "admin") {
    return { ok: false, code: "billing_unconfigured" };
  }
  if (adapter !== "http" || !billingUrl || !billingToken) return { ok: false, code: "billing_unconfigured" };
  if (!supergptKey) return { ok: false, code: "upstream_unconfigured" };
  let supergptBase = "https://api.supergpt.dev/v1";
  try {
    supergptBase = assertSuperGptBase(env.SUPERGPT_BASE_URL?.trim() || supergptBase);
  } catch {
    return { ok: false, code: "upstream_unconfigured" };
  }
  let billing: URL;
  try {
    billing = new URL(billingUrl);
  } catch {
    return { ok: false, code: "billing_unconfigured" };
  }
  if (billing.protocol !== "https:" && billing.hostname !== "127.0.0.1" && billing.hostname !== "localhost") {
    return { ok: false, code: "billing_unconfigured" };
  }
  const storePath = env.VIDEO_JOB_STORE?.trim() || "";
  if (!storePath.startsWith("/")) return { ok: false, code: "billing_unconfigured" };
  const jaxapiBaseUrl = (env.JAXAPI_BASE_URL?.trim() || "https://jaxapi.top").replace(/\/$/, "");
  return {
    ok: true,
    config: {
      supergptBase,
      supergptKey,
      billingUrl,
      billingToken,
      storePath,
      jaxapiBaseUrl,
    },
  };
}
