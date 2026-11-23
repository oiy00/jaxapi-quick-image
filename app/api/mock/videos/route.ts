import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const body = {
  ok: false,
  mock: false,
  code: "mock_disabled",
  message: "视频模拟已关闭。生成失败时不会改用样片。",
};

export function POST() {
  return NextResponse.json(body, { status: 410 });
}

export function GET() {
  return NextResponse.json(body, { status: 410 });
}
