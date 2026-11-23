import { liveVideoDeps, videoContent } from "@/lib/video-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => videoContent(request, liveVideoDeps(), id));
}
