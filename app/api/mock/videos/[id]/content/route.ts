import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { ok: false, mock: false, code: "mock_disabled", message: "没有样片可下载。" },
    { status: 410 },
  );
}
