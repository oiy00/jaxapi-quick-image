import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { readMockVideo } from "@/lib/mock-video-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const userId = request.nextUrl.searchParams.get("userId") || "";
  const result = readMockVideo(id, userId);
  if (!result.ok) {
    const status = result.code === "forbidden" ? 403 : 404;
    return NextResponse.json({ mock: true, ok: false, code: result.code }, { status });
  }
  if (result.task.status !== "completed") {
    return NextResponse.json({ mock: true, ok: false, code: "not_ready" }, { status: 409 });
  }
  const file = await readFile(path.join(process.cwd(), "public", "mock-clip.mp4"));
  return new NextResponse(file, {
    status: 200,
    headers: {
      "content-type": "video/mp4",
      "cache-control": "no-store",
      "x-mock-video": "unverified-upstream",
    },
  });
}
