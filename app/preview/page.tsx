"use client";

import { useRef, useState } from "react";
import { CropDialog } from "@/components/studio/crop-dialog";
import { Studio } from "@/components/studio/studio";
import { useReferenceTray } from "@/components/studio/use-references";
import { VideoDesk } from "@/components/studio/video-desk";
import type { Draft, HistoryCard, RunView } from "@/components/studio/view";
import {
  DEFAULT_ASPECT,
  DEFAULT_MODEL,
  DEFAULT_QUALITY,
  DEFAULT_RESOLUTION,
  FIXED_COUNT,
  aspectValue,
  isImageModelId,
  pixelSize,
} from "@/lib/models";
import { estimateImageCost } from "@/lib/pricing";

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
  },
];

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
  const [selected, setSelected] = useState<string | null>(SEEDED[0].id);
  const [draft, setDraft] = useState<Draft>({
    prompt: SEEDED[0].prompt,
    model: DEFAULT_MODEL,
    resolution: DEFAULT_RESOLUTION,
    aspect: DEFAULT_ASPECT,
    quality: DEFAULT_QUALITY,
    count: 1,
  });
  const [run, setRun] = useState<RunView>(successRun(SEEDED[0]));
  const [mockCap, setMockCap] = useState<1 | 5 | undefined>(undefined);
  const references = useReferenceTray(draft.model, mockCap);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const generation = useRef(0);

  function showCard(card: HistoryCard) {
    setSelected(card.id);
    setDraft((current) => ({
      ...current,
      prompt: card.prompt,
      model: isImageModelId(card.model) ? card.model : current.model,
    }));
    if (card.status === "succeeded" && card.thumbUrl) {
      setRun(successRun(card));
      return;
    }
    if (card.status === "pending") {
      setRun({ status: "pending", startedAt: Date.parse(card.createdAt) || Date.now(), mode: "generate" });
      return;
    }
    setRun({ status: "error", message: "这次生成没有完成。", timeout: card.status === "timeout" });
  }

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
        const card = history.find((item) => item.id === id);
        if (card) showCard(card);
      }}
      onDeleteHistory={(id) => {
        setHistory((current) => current.filter((item) => item.id !== id));
        if (selectedRef.current === id) {
          selectedRef.current = null;
          setSelected(null);
          setRun({ status: "idle" });
        }
      }}
      onCreate={() => {
        setDraft((current) => ({ ...current, prompt: "" }));
        references.clear();
        setSelected(null);
        setRun({ status: "idle" });
      }}
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
        if (!prompt) return;
        const token = ++generation.current;
        const id = crypto.randomUUID();
        const size = pixelSize(draft.resolution, draft.aspect);
        const model = draft.model;
        const createdAt = new Date().toISOString();
        const pending: HistoryCard = {
          id,
          createdAt,
          prompt,
          model,
          size,
          status: "pending",
        };
        setHistory((current) => [pending, ...current.filter((item) => item.id !== id)]);
        setSelected(id);
        selectedRef.current = id;
        setRun({ status: "pending", startedAt: Date.now(), mode: "generate" });
        window.setTimeout(() => {
          const done: HistoryCard = { ...pending, status: "succeeded", thumbUrl: night };
          setHistory((current) => current.map((item) => (item.id === id ? done : item)));
          if (generation.current === token && selectedRef.current === id) setRun(successRun(done));
        }, 900);
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
