"use client";

import { useState } from "react";
import { CropDialog } from "@/components/studio/crop-dialog";
import { Studio } from "@/components/studio/studio";
import { useReferenceTray } from "@/components/studio/use-references";
import { VideoDesk } from "@/components/studio/video-desk";
import type { Draft, HistoryCard, ReferenceView, RunView, ViewingRecord } from "@/components/studio/view";
import {
  DEFAULT_ASPECT,
  DEFAULT_MODEL,
  DEFAULT_QUALITY,
  DEFAULT_RESOLUTION,
  FIXED_COUNT,
  aspectValue,
  pixelSize,
} from "@/lib/models";
import { estimateImageCost } from "@/lib/pricing";
import { MAX_CONCURRENT_IMAGES } from "@/lib/image-concurrency";

function scene(width: number, height: number, sky: string, ground: string, accent: string) {
  return (
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky}"/><stop offset="1" stop-color="#e8edf6"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#s)"/><circle cx="${Math.round(width * 0.72)}" cy="${Math.round(height * 0.28)}" r="${Math.round(height * 0.08)}" fill="${accent}"/><path d="M0 ${Math.round(height * 0.62)} L${Math.round(width * 0.28)} ${Math.round(height * 0.42)} L${Math.round(width * 0.5)} ${Math.round(height * 0.58)} L${Math.round(width * 0.7)} ${Math.round(height * 0.4)} L${width} ${Math.round(height * 0.6)} L${width} ${height} L0 ${height} Z" fill="${ground}"/></svg>`,
    )
  );
}

const night = scene(1024, 1024, "#243044", "#33456e", "#f4efe4");
const coast = scene(1024, 576, "#7eb0d4", "#c4a574", "#fff7e8");
const sketch = scene(800, 600, "#d9e2ef", "#8a9bb8", "#ffffff");

/** A mock result that carries its own prompt, so a mixed-up result is visible at a glance. */
function labelled(prompt: string, size: string) {
  const [w, h] = size.split("x").map(Number);
  const hue = [...prompt].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 360;
  const text = prompt.replace(/[<&>]/g, "").slice(0, 24);
  return (
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="hsl(${hue} 45% 72%)"/><text x="50%" y="50%" text-anchor="middle" font-size="${Math.round(h / 14)}" fill="#16181d" font-family="sans-serif">${text}</text></svg>`,
    )
  );
}

/** Preview-only details a real record keeps in IndexedDB. */
type PreviewDetail = Omit<ViewingRecord, "id" | "inFlight">;

const SEEDED: HistoryCard[] = [
  {
    id: "sample-night",
    createdAt: new Date().toISOString(),
    prompt: "雨后的弄堂，一扇半开的木门，暖光落在湿石板上。",
    model: "gpt-image-2.5-flare",
    size: "1024x1024",
    status: "succeeded",
    thumbUrl: night,
  },
  {
    id: "sample-coast",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    prompt: "清晨的海岸公路，低云压着灰蓝色的海。",
    model: "gpt-image-2",
    size: "1024x576",
    status: "succeeded",
    thumbUrl: coast,
    referenceCount: 1,
  },
];

const SEEDED_DETAIL: Record<string, PreviewDetail> = {
  "sample-night": {
    prompt: SEEDED[0].prompt,
    model: "gpt-image-2.5-flare",
    resolution: "1K",
    aspect: "1:1",
    quality: "auto",
    estimateUsd: 0.09,
    mode: "generate",
    references: [],
    referenceCount: 0,
    referencesDropped: false,
  },
  "sample-coast": {
    prompt: SEEDED[1].prompt,
    model: "gpt-image-2",
    resolution: "1K",
    aspect: "16:9",
    quality: "auto",
    estimateUsd: 0.09,
    mode: "edit",
    references: [{ id: "sample-coast:0", name: "海岸草图.png", url: sketch, width: 800, height: 600 }],
    referenceCount: 1,
    referencesDropped: false,
  },
};

function successRun(card: HistoryCard): RunView {
  return {
    status: "success",
    images: [{ url: card.thumbUrl ?? night, name: `${card.id}.svg` }],
    costUsd: 0.09,
    balanceAfter: 12.41,
    usage: { total_tokens: 1200 },
    estimateUsd: 0.09,
    size: card.size,
    model: card.model,
  };
}

export default function PreviewPage() {
  const [history, setHistory] = useState<HistoryCard[]>(SEEDED);
  const [details, setDetails] = useState<Record<string, PreviewDetail>>(SEEDED_DETAIL);
  const [selected, setSelected] = useState<string | null>(null);
  const [inFlightIds, setInFlightIds] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft>({
    prompt: "",
    model: DEFAULT_MODEL,
    resolution: DEFAULT_RESOLUTION,
    aspect: DEFAULT_ASPECT,
    quality: DEFAULT_QUALITY,
    count: 1,
  });
  const [mockCap, setMockCap] = useState<1 | 5 | undefined>(undefined);
  const references = useReferenceTray(draft.model, mockCap);

  const card = selected ? history.find((item) => item.id === selected) ?? null : null;
  const detail = card ? details[card.id] : undefined;
  const viewing: ViewingRecord | null =
    card && detail ? { ...detail, id: card.id, inFlight: inFlightIds.includes(card.id) } : null;
  const run: RunView = !card
    ? { status: "idle" }
    : card.status === "succeeded" && card.thumbUrl
      ? successRun(card)
      : card.status === "pending"
        ? { status: "pending", startedAt: Date.parse(card.createdAt) || Date.now(), mode: detail?.mode ?? "generate" }
        : { status: "error", message: "这次生成没有完成。", timeout: card.status === "timeout" };

  return (
    <>
    <Studio
      previewNote="界面预览，未连接账户，也不会发起计费请求。"
      headerExtra={
        <div className="hidden items-center gap-1 md:flex" role="group" aria-label="预览参考图上限">
          <span className="text-xs text-muted-foreground">上限</span>
          <button
            type="button"
            aria-pressed={mockCap == null}
            onClick={() => setMockCap(undefined)}
            className={`h-7 rounded-md px-2 text-xs ${mockCap == null ? "bg-primary text-primary-foreground" : "text-muted-foreground ring-1 ring-border"}`}
          >
            按模型
          </button>
          {([1, 5] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mockCap === value}
              onClick={() => setMockCap(value)}
              className={`h-7 rounded-md px-2 text-xs ${mockCap === value ? "bg-primary text-primary-foreground" : "text-muted-foreground ring-1 ring-border"}`}
            >
              {value} 张
            </button>
          ))}
        </div>
      }
      email="preview@jaxapi.top"
      balance={12.5}
      connection={{ state: "ready", label: "JaxApi 媒体台 · 媒体台" }}
      keys={[{ id: 1, label: "JaxApi 媒体台 · 媒体台" }]}
      selectedKeyId={1}
      onSelectKey={() => undefined}
      onLogout={() => undefined}
      history={history}
      selectedHistoryId={selected}
      onSelectHistory={(id) => {
        if (history.some((item) => item.id === id)) setSelected(id);
      }}
      onDeleteHistory={(id) => {
        if (inFlightIds.includes(id)) return;
        setHistory((current) => current.filter((item) => item.id !== id));
        if (selected === id) setSelected(null);
      }}
      onCompose={() => setSelected(null)}
      onClearDraft={() => {
        setDraft((current) => ({ ...current, prompt: "" }));
        references.clear();
      }}
      viewing={viewing}
      onReuse={(id) => {
        const source = details[id];
        if (!source) return;
        setDraft({ prompt: source.prompt, model: source.model, resolution: source.resolution, aspect: source.aspect, quality: source.quality, count: FIXED_COUNT });
        void Promise.all(
          source.references.map(async (ref) => {
            const blob = await (await fetch(ref.url)).blob();
            return new File([blob], ref.name, { type: blob.type || "image/svg+xml" });
          }),
        ).then((files) => references.load(files, source.model));
        setSelected(null);
      }}
      inFlightIds={inFlightIds}
      maxInFlight={MAX_CONCURRENT_IMAGES}
      resubmitGuard={false}
      draft={draft}
      onDraft={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      references={references.items.map((item) => ({ id: item.id, name: item.name, url: item.url }))}
      referenceCap={references.cap}
      referenceCapNote={
        mockCap == null
          ? "gpt-image-2.5-flare 已核对最多 5 张，字段重复为 image。其他模型仍是 1 张。"
          : "这个按钮只在预览里改上限，用来看超限提示，不改正式模型表。"
      }
      onAddReferences={references.addFiles}
      onRemoveReference={references.remove}
      onMoveReference={references.move}
      estimate={estimateImageCost({
        model: draft.model,
        resolution: draft.resolution,
        count: FIXED_COUNT,
      })}
      run={run}
      videoDesk={
        <VideoDesk
          accessToken=""
          userId="preview"
          accountBalance={12.5}
          enabled={false}
          blockedReason="预览页不发起视频请求，也不会扣费。"
        />
      }
      onGenerate={() => {
        const prompt = draft.prompt.trim();
        if (!prompt || selected || inFlightIds.length >= MAX_CONCURRENT_IMAGES) return;
        const id = crypto.randomUUID();
        const size = pixelSize(draft.resolution, draft.aspect);
        const refs: ReferenceView[] = references.items.map((item, index) => ({
          id: `${id}:${index}`,
          name: item.name,
          url: URL.createObjectURL(item.file),
        }));
        const pending: HistoryCard = {
          id,
          createdAt: new Date().toISOString(),
          prompt,
          model: draft.model,
          size,
          status: "pending",
          referenceCount: refs.length,
        };
        setDetails((current) => ({
          ...current,
          [id]: {
            prompt,
            model: draft.model,
            resolution: draft.resolution,
            aspect: draft.aspect,
            quality: draft.quality,
            estimateUsd: estimateImageCost({ model: draft.model, resolution: draft.resolution, count: FIXED_COUNT })?.totalUsd ?? null,
            mode: refs.length ? "edit" : "generate",
            references: refs,
            referenceCount: refs.length,
            referencesDropped: false,
          },
        }));
        setHistory((current) => [pending, ...current]);
        setSelected(id);
        setInFlightIds((current) => [...current, id]);
        setDraft((current) => ({ ...current, prompt: "" }));
        references.clear();
        // Later submissions finish sooner, so results arrive out of order on purpose.
        const delay = Math.max(800, 4000 - inFlightIds.length * 700);
        window.setTimeout(() => {
          setHistory((current) =>
            current.map((item) => (item.id === id ? { ...pending, status: "succeeded", thumbUrl: labelled(prompt, size) } : item)),
          );
          setInFlightIds((current) => current.filter((item) => item !== id));
        }, delay);
      }}
    />
    <CropDialog
      open={references.cropFile !== null}
      file={references.cropFile}
      aspect={aspectValue(draft.aspect)}
      onOpenChange={(open) => {
        if (!open) references.dismissCrop();
      }}
      onUseOriginal={references.accept}
      onUseCrop={references.accept}
    />
    </>
  );
}
