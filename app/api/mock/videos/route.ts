import { NextRequest, NextResponse } from "next/server";
import { readMockVideo, submitMockVideo } from "@/lib/mock-video-store";
import type { LedgerResult } from "@/lib/video-ledger";

export const dynamic = "force-dynamic";

const MOCK_NOTE = "本地模拟。未连接 SuperGPT，也未向 jaxapi.top 提交或扣费。";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ mock: true, ok: false, code: "forbidden", note: MOCK_NOTE }, { status: 400 });
  const result = submitMockVideo({
    userId: stringField(body.userId),
    groupName: stringField(body.groupName),
    idempotencyKey: stringField(body.idempotencyKey),
    model: stringField(body.model),
    duration: Number(body.duration),
    prompt: stringField(body.prompt),
    clientMultiplier: typeof body.clientMultiplier === "number" ? body.clientMultiplier : undefined,
    openingBalance: typeof body.openingBalance === "number" ? body.openingBalance : undefined,
  });
  return jsonResult(result);
}

export async function GET(request: NextRequest) {
  const taskId = request.nextUrl.searchParams.get("id") || "";
  const userId = request.nextUrl.searchParams.get("userId") || "";
  return jsonResult(readMockVideo(taskId, userId));
}

function jsonResult(result: LedgerResult) {
  const status = result.ok ? 200 : result.code === "forbidden" ? 403 : result.code === "insufficient" ? 402 : 400;
  return NextResponse.json({ mock: true, upstreamVerified: false, note: MOCK_NOTE, ...result }, { status });
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}
