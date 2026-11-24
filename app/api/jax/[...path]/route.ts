import { NextRequest, NextResponse } from "next/server";
import { editRejection, inspectEditMultipart } from "@/lib/reference-images";
import { apiBaseUrl, isProxiedRequest, sanitizeQuery, timeoutFor } from "@/lib/proxy-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BODY = 20 * 1024 * 1024;

async function handle(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await context.params;
  const path = `/${parts.map((part) => decodeURIComponent(part)).join("/")}`;
  if (!isProxiedRequest(request.method, path)) {
    return NextResponse.json({ code: 404, message: "不支持的接口" }, { status: 404 });
  }

  let target: URL;
  try {
    target = new URL(apiBaseUrl() + path);
  } catch {
    return NextResponse.json({ code: 500, message: "API 地址配置无效" }, { status: 500 });
  }
  sanitizeQuery(request.nextUrl.searchParams).forEach((value, key) => {
    target.searchParams.append(key, value);
  });

  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const authorization = request.headers.get("authorization");
  if (authorization) headers.set("authorization", authorization);
  headers.set("accept", request.headers.get("accept") || "*/*");
  headers.set("accept-language", "zh-CN,zh;q=0.9,en;q=0.8");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutFor(path));
  try {
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers,
      signal: controller.signal,
      redirect: "manual",
    };
    let buffered: ArrayBuffer | undefined;
    if (request.method !== "GET" && request.method !== "HEAD") {
      buffered = await request.arrayBuffer();
      if (buffered.byteLength > MAX_BODY) {
        return NextResponse.json({ code: 413, message: "上传超过 20MB" }, { status: 413 });
      }
      init.body = buffered;
    }
    if (
      buffered &&
      request.method === "POST" &&
      path === "/v1/images/edits" &&
      contentType?.toLowerCase().includes("multipart/form-data")
    ) {
      const inspected = inspectEditMultipart(new Uint8Array(buffered), contentType);
      if (inspected.parsed) {
        const rejected = editRejection(inspected.model, inspected.imageCount);
        if (rejected) {
          return NextResponse.json({ code: 400, message: rejected }, { status: 400 });
        }
      }
    }
    const upstream = await fetch(target, init);
    const responseHeaders = new Headers();
    for (const name of ["content-type", "retry-after"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set("cache-control", "no-store");
    return new NextResponse(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return NextResponse.json(
      {
        code: aborted ? 504 : 502,
        message: aborted ? "等待上游超时" : "无法连接上游",
        reason: aborted ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNREACHABLE",
      },
      { status: aborted ? 504 : 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}

export const GET = handle;
export const POST = handle;
