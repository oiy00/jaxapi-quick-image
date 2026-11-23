"use client";

import { useState } from "react";
import { Studio } from "@/components/studio/studio";
import { VideoDesk } from "@/components/studio/video-desk";
import type { Draft, RunView } from "@/components/studio/view";
import { DEFAULT_ASPECT, DEFAULT_MODEL, DEFAULT_QUALITY, DEFAULT_RESOLUTION, FIXED_COUNT } from "@/lib/models";
import { estimateImageCost } from "@/lib/pricing";

const sample =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="100%" height="100%" fill="#1a1612"/><circle cx="400" cy="340" r="140" fill="#e0b15a"/><rect x="160" y="520" width="480" height="16" rx="8" fill="#8a7350"/></svg>`,
  );

export default function PreviewPage() {
  const [draft, setDraft] = useState<Draft>({
    prompt: "雨后的弄堂，一扇半开的木门，暖光落在湿石板上。",
    model: DEFAULT_MODEL,
    resolution: DEFAULT_RESOLUTION,
    aspect: DEFAULT_ASPECT,
    quality: DEFAULT_QUALITY,
    count: 1,
  });
  const [run, setRun] = useState<RunView>({ status: "idle" });
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <Studio
      previewNote="界面预览，未连接账户，也不会发起计费请求。"
      email="preview@jaxapi.top"
      balance={12.5}
      connection={{ state: "ready", label: "JaxApi 媒体台 · 媒体台" }}
      keys={[{ id: 1, label: "JaxApi 媒体台 · 媒体台" }]}
      selectedKeyId={1}
      onSelectKey={() => undefined}
      onLogout={() => undefined}
      history={[
        {
          id: "sample",
          createdAt: new Date().toISOString(),
          prompt: "雨后的弄堂，一扇半开的木门。",
          model: "gpt-image-2",
          size: "1024x1024",
          status: "succeeded",
          thumbUrl: sample,
        },
      ]}
      selectedHistoryId={selected}
      onSelectHistory={() => {
        setSelected("sample");
        setRun({
          status: "success",
          images: [{ url: sample, name: "preview.svg" }],
          costUsd: 0.09,
          balanceAfter: 12.41,
          usage: { total_tokens: 1200 },
          estimateUsd: 0.09,
          size: "1024x1024",
          model: "gpt-image-2",
        });
      }}
      onDeleteHistory={() => setSelected(null)}
      onCreate={() => {
        setDraft((current) => ({ ...current, prompt: "" }));
        setSelected(null);
        setRun({ status: "idle" });
      }}
      draft={draft}
      onDraft={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      referenceName={null}
      referenceUrl={null}
      onPickReference={() => undefined}
      onClearReference={() => undefined}
      estimate={estimateImageCost({
        model: draft.model,
        resolution: draft.resolution,
        count: FIXED_COUNT,
      })}
      run={run}
      videoDesk={<VideoDesk userId="preview" groupName="媒体台" accountBalance={12.5} enabled />}
      onGenerate={() => {
        if (!draft.prompt.trim()) return;
        const startedAt = Date.now();
        setRun({ status: "pending", startedAt, mode: "generate" });
        window.setTimeout(() => {
          setRun({
            status: "success",
            images: [{ url: sample, name: "preview.svg" }],
            costUsd: null,
            balanceAfter: 12.5,
            usage: null,
            estimateUsd: estimateImageCost({ model: draft.model, resolution: draft.resolution, count: FIXED_COUNT })?.totalUsd ?? 0,
            size: "1024x1024",
            model: draft.model,
          });
        }, 900);
      }}
    />
  );
}
