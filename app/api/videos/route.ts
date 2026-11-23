import { liveVideoDeps, videoByKey, videoPost } from "@/lib/video-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const deps = () => liveVideoDeps();

export function POST(request: Request) {
  return videoPost(request, deps());
}

export function GET(request: Request) {
  return videoByKey(request, deps());
}
