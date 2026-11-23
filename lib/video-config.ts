import { assertSuperGptBase } from "./supergpt-video.ts";

export type LiveVideoConfig = {
  adapter: "postgres";
  databaseUrl: string;
  supergptBase: string;
  supergptKey: string;
  storePath: string;
  jaxapiBaseUrl: string;
};

export type VideoConfigResult = { ok: true; config: LiveVideoConfig } | { ok: false; code: "billing_unconfigured" | "upstream_unconfigured" };

export function readVideoConfig(env: NodeJS.ProcessEnv = process.env): VideoConfigResult {
  const adapter = (env.VIDEO_BILLING_ADAPTER || "off").trim().toLowerCase();
  const supergptKey = env.SUPERGPT_API_KEY?.trim() || "";
  if (adapter === "sub2api" || adapter === "admin" || adapter === "off" || adapter === "http") {
    return { ok: false, code: "billing_unconfigured" };
  }
  if (adapter !== "postgres" && adapter !== "sql" && adapter !== "database") {
    return { ok: false, code: "billing_unconfigured" };
  }
  const databaseUrl = env.VIDEO_DATABASE_URL?.trim() || "";
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) return { ok: false, code: "billing_unconfigured" };
  if (!supergptKey) return { ok: false, code: "upstream_unconfigured" };
  let supergptBase = "https://api.supergpt.dev/v1";
  try {
    supergptBase = assertSuperGptBase(env.SUPERGPT_BASE_URL?.trim() || supergptBase);
  } catch {
    return { ok: false, code: "upstream_unconfigured" };
  }
  const storePath = env.VIDEO_JOB_STORE?.trim() || "";
  if (!storePath.startsWith("/")) return { ok: false, code: "billing_unconfigured" };
  const jaxapiBaseUrl = (env.JAXAPI_BASE_URL?.trim() || "https://jaxapi.top").replace(/\/$/, "");
  return {
    ok: true,
    config: { adapter: "postgres", databaseUrl, supergptBase, supergptKey, storePath, jaxapiBaseUrl },
  };
}
