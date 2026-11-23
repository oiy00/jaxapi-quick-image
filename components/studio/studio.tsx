"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Download, ImagePlus, Loader2, LogOut, Plus, Trash2, X } from "lucide-react";
import { formatUsd } from "@/lib/money";
import { ASPECTS, FIXED_COUNT, MODELS, qualitiesFor, resolutionsFor } from "@/lib/models";
import type { UsageNumbers } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { ConnectionView, Draft, EstimateView, HistoryCard, KeyOption, RunView } from "./view";

type StudioProps = {
  email: string;
  balance: number | null;
  frozenBalance?: number | null;
  connection: ConnectionView;
  keys: KeyOption[];
  selectedKeyId: number | null;
  onSelectKey: (id: number) => void;
  onLogout: () => void;
  embedded?: boolean;
  showLogout?: boolean;
  history: HistoryCard[];
  selectedHistoryId: string | null;
  onSelectHistory: (id: string) => void;
  onDeleteHistory: (id: string) => void;
  onCreate: () => void;
  draft: Draft;
  onDraft: (patch: Partial<Draft>) => void;
  referenceName: string | null;
  referenceUrl: string | null;
  onPickReference: (file: File) => void;
  onClearReference: () => void;
  estimate: EstimateView | null;
  run: RunView;
  onGenerate: () => void;
  previewNote?: string;
  videoDesk?: ReactNode;
};

const STATUS_LABEL: Record<HistoryCard["status"], string> = {
  pending: "进行中",
  succeeded: "完成",
  failed: "失败",
  timeout: "超时",
};

export function Studio(props: StudioProps) {
  const [tab, setTab] = useState("compose");
  const [desk, setDesk] = useState<"image" | "video">("image");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const qualities = qualitiesFor(props.draft.model);
  const resolutions = resolutionsFor(props.draft.model);
  const blocked = props.connection.state === "blocked";

  useEffect(() => {
    const patch: Partial<Draft> = {};
    if (!qualities.includes(props.draft.quality)) patch.quality = "auto";
    if (!resolutions.includes(props.draft.resolution)) patch.resolution = resolutions[0] ?? "1K";
    if (props.draft.count !== FIXED_COUNT) patch.count = FIXED_COUNT;
    if (Object.keys(patch).length) props.onDraft(patch);
  }, [props, qualities, resolutions]);

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b bg-background/80 px-3 py-3 backdrop-blur md:px-5">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            {props.embedded ? null : (
              <span className="font-[family-name:var(--font-display)] text-lg tracking-tight">JaxApi</span>
            )}
            <span className="text-sm text-muted-foreground">媒体台</span>
          </div>
          {props.previewNote ? <p className="text-xs text-primary">{props.previewNote}</p> : null}
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant={desk === "image" ? "default" : "outline"} onClick={() => setDesk("image")}>生图</Button>
          <Button size="sm" variant={desk === "video" ? "default" : "outline"} onClick={() => setDesk("video")}>视频</Button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="hidden text-right sm:block">
            <p className="text-xs text-muted-foreground">余额</p>
            <p className="text-sm tabular-nums">{formatUsd(props.balance)}</p>
          </div>
          <Button variant="outline" size="sm" render={<a href="/keys" target={props.embedded ? "_parent" : "_blank"} rel="noreferrer" />}>
            密钥
          </Button>
          {props.showLogout === false ? (
            <span className="hidden text-xs text-muted-foreground sm:inline">{props.email}</span>
          ) : (
            <Button variant="ghost" size="sm" onClick={props.onLogout}>
              <LogOut />
              <span className="hidden sm:inline">{props.email}</span>
            </Button>
          )}
        </div>
      </header>

      {desk === "video" ? <div className="flex min-h-0 flex-1 flex-col">{props.videoDesk}</div> : null}
      <div className={`border-b px-3 py-2 lg:hidden ${desk === "video" ? "hidden" : ""}`}>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="history">历史</TabsTrigger>
            <TabsTrigger value="compose">生图</TabsTrigger>
            <TabsTrigger value="result">结果</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className={`grid min-h-0 flex-1 lg:grid-cols-[280px_minmax(0,1fr)_minmax(320px,380px)] ${desk === "video" ? "hidden" : ""}`}>
        <section className={paneClass(tab === "history")}>
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="text-sm font-medium">生成历史</h2>
            <Button size="sm" variant="outline" onClick={props.onCreate}>
              <Plus />
              新建
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-4">
            {props.history.length === 0 ? (
              <EmptyCopy title="还没有记录" body="写一段提示词开始。记录只留在这台浏览器里，换设备不会同步。" />
            ) : (
              props.history.map((item) => (
                <article
                  key={item.id}
                  className={`rounded-xl border p-2 ${props.selectedHistoryId === item.id ? "border-primary/60 bg-primary/10" : "bg-card/40"}`}
                >
                  <button
                    type="button"
                    className="flex w-full gap-2 text-left"
                    onClick={() => {
                      props.onSelectHistory(item.id);
                      setTab("result");
                    }}
                  >
                    <Thumb url={item.thumbUrl} />
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-sm">{item.prompt || "未填写提示词"}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                        <Badge variant="outline">{STATUS_LABEL[item.status]}</Badge>
                        {item.size}
                      </span>
                    </span>
                  </button>
                  <div className="mt-2 flex justify-end">
                    {confirmDelete === item.id ? (
                      <Button
                        size="xs"
                        variant="destructive"
                        onClick={() => {
                          props.onDeleteHistory(item.id);
                          setConfirmDelete(null);
                        }}
                      >
                        确认删除
                      </Button>
                    ) : (
                      <Button size="icon-xs" variant="ghost" onClick={() => setConfirmDelete(item.id)} aria-label="删除记录">
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        <section className={paneClass(tab === "compose", true)}>
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 md:px-6">
            <div>
              <h2 className="font-[family-name:var(--font-display)] text-2xl">描述要生成的画面</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                没有参考图时走文生图；放上参考图后改为按图编辑。价格以美元计，不换算。
              </p>
            </div>
            <Textarea
              value={props.draft.prompt}
              onChange={(event) => props.onDraft({ prompt: event.target.value.slice(0, 4000) })}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") props.onGenerate();
              }}
              placeholder="例如：清晨的上海弄堂，湿润的石板路，一盏还亮着的暖黄色窗。"
              className="min-h-40 resize-y text-base"
            />
            <p className="text-right text-xs text-muted-foreground">{props.draft.prompt.length}/4000</p>
            <ReferenceDrop
              name={props.referenceName}
              url={props.referenceUrl}
              onPick={props.onPickReference}
              onClear={props.onClearReference}
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="模型">
                <Select
                  value={props.draft.model}
                  onValueChange={(value) => value && props.onDraft({ model: value as Draft["model"] })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODELS.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="质量">
                <Select value={props.draft.quality} onValueChange={(value) => value && props.onDraft({ quality: value })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {qualities.map((quality) => (
                      <SelectItem key={quality} value={quality}>
                        {quality}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="张数">
                <div className="rounded-lg border bg-card/60 px-3 py-2 text-sm">
                  固定 1 张
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  当前上游不支持一次生成多张（传 n 会被忽略或直接报错），所以这里锁定为 1 张，请求里也不再带 n 参数。
                </p>
              </Field>
            </div>
            <Field label="分辨率">
              <div className="grid grid-cols-3 gap-2">
                {resolutions.map((resolution) => (
                  <Button
                    key={resolution}
                    type="button"
                    variant={props.draft.resolution === resolution ? "default" : "outline"}
                    onClick={() => props.onDraft({ resolution })}
                  >
                    {resolution}
                  </Button>
                ))}
              </div>
            </Field>
            <Field label="画面比例">
              <div className="flex flex-wrap gap-2">
                {ASPECTS.map((aspect) => (
                  <Button
                    key={aspect}
                    type="button"
                    size="sm"
                    variant={props.draft.aspect === aspect ? "default" : "outline"}
                    onClick={() => props.onDraft({ aspect })}
                  >
                    {aspect}
                  </Button>
                ))}
              </div>
            </Field>
            {props.keys.length > 1 && props.selectedKeyId != null ? (
              <Field label="使用的密钥">
                <Select
                  value={String(props.selectedKeyId)}
                  onValueChange={(value) => value && props.onSelectKey(Number(value))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {props.keys.map((key) => (
                      <SelectItem key={key.id} value={String(key.id)}>
                        {key.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <ConnectionNote embedded={props.embedded} connection={props.connection} />
            <EstimateCard estimate={props.estimate} />
            {props.frozenBalance ? (
              <p className="text-xs text-muted-foreground">其中冻结 {formatUsd(props.frozenBalance)}，暂不可用。</p>
            ) : null}
            <Button
              type="button"
              className="h-11"
              disabled={blocked || props.connection.state === "loading" || props.run.status === "pending" || !props.draft.prompt.trim()}
              onClick={props.onGenerate}
            >
              {props.run.status === "pending" ? <Loader2 className="animate-spin" /> : null}
              {props.referenceName ? "按参考图编辑" : "生成图片"}
            </Button>
            <p className="text-center text-xs text-muted-foreground">Ctrl 或 ⌘ + Enter 也可以提交。手机上从上方切换历史和结果。</p>
          </div>
        </section>

        <section className={paneClass(tab === "result")}>
          <div className="px-4 py-3">
            <h2 className="text-sm font-medium">生成结果</h2>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
            <ResultPane run={props.run} />
          </div>
        </section>
      </div>
    </div>
  );
}

function paneClass(visible: boolean, middle = false) {
  return `flex min-h-0 flex-col ${middle ? "" : "lg:border-r"} ${visible ? "" : "hidden"} lg:flex`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function EmptyCopy({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed px-3 py-6 text-center">
      <p className="text-sm">{title}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{body}</p>
    </div>
  );
}

function Thumb({ url }: { url?: string }) {
  if (!url) return <span className="size-14 shrink-0 rounded-lg bg-muted" />;
  return <img src={url} alt="" className="size-14 shrink-0 rounded-lg object-cover" />;
}

function ReferenceDrop({
  name,
  url,
  onPick,
  onClear,
}: {
  name: string | null;
  url: string | null;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  return (
    <div
      className="rounded-xl border border-dashed bg-card/40 p-3"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const file = event.dataTransfer.files?.[0];
        if (file) onPick(file);
      }}
    >
      {url && name ? (
        <div className="flex items-center gap-3">
          <img src={url} alt="" className="size-16 rounded-lg object-cover" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{name}</p>
            <p className="text-xs text-muted-foreground">将作为编辑参考图</p>
          </div>
          <Button type="button" size="icon-sm" variant="ghost" onClick={onClear} aria-label="移除参考图">
            <X />
          </Button>
        </div>
      ) : (
        <label className="flex cursor-pointer items-center gap-3 text-sm text-muted-foreground">
          <ImagePlus />
          <span>拖入或点击上传参考图，可按当前比例裁剪。支持 PNG、JPEG、WebP，不超过 12MB。</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) onPick(file);
            }}
          />
        </label>
      )}
    </div>
  );
}

function ConnectionNote({ connection, embedded }: { connection: ConnectionView; embedded?: boolean }) {
  if (connection.state === "loading") return <p className="text-sm text-muted-foreground">正在查找可用的图片密钥…</p>;
  if (connection.state === "ready") {
    return <p className="text-sm text-muted-foreground">当前连接：{connection.label}</p>;
  }
  return (
    <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm leading-6">
      <p>{connection.summary}</p>
      {connection.details.length > 0 ? (
        <ul className="mt-2 list-disc pl-4 text-xs text-muted-foreground">
          {connection.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      <a className="mt-2 inline-block text-primary underline" href="/keys" target={embedded ? "_parent" : "_blank"} rel="noreferrer">
        打开密钥页
      </a>
    </div>
  );
}

function EstimateCard({ estimate }: { estimate: EstimateView | null }) {
  if (!estimate) return null;
  const basis =
    `按 ${estimate.model ?? "当前模型"} ${estimate.resolution} 固定售价（上游成本 × 2），不叠加个人倍率`;
  return (
    <div className="rounded-xl border bg-card/70 p-3">
      <div className="flex justify-between gap-3 text-sm">
        <span>单张预估</span>
        <span className="tabular-nums">{formatUsd(estimate.unitUsd)}</span>
      </div>
      <div className="mt-1 flex justify-between gap-3 text-sm font-medium">
        <span>本次预估 · 1 张</span>
        <span className="tabular-nums">{formatUsd(estimate.totalUsd)}</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{basis}。结算以扣费后的余额为准，质量档不改变这套图片标价。每次只生成 1 张。</p>
    </div>
  );
}

function ResultPane({ run }: { run: RunView }) {
  if (run.status === "idle") {
    return <EmptyCopy title="结果会显示在这里" body="提交之后可以离开这个面板。生成通常要几十秒，有时会接近两分钟。" />;
  }
  if (run.status === "pending") return <PendingState startedAt={run.startedAt} editing={run.mode === "edit"} />;
  if (run.status === "error") {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm leading-6">
        <p>{run.message}</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="grid gap-2">
        {run.images.map((image) => (
          <figure key={image.url} className="overflow-hidden rounded-xl border bg-black/30">
            <img src={image.url} alt="生成结果" className="w-full" />
            <figcaption className="flex items-center justify-between px-2 py-1 text-xs text-muted-foreground">
              <span>
                {run.model} · {run.size}
              </span>
              <a href={image.url} download={image.name} className="inline-flex items-center gap-1 text-primary">
                <Download className="size-3" />
                下载
              </a>
            </figcaption>
          </figure>
        ))}
      </div>
      {run.revisedPrompt ? <p className="text-xs leading-5 text-muted-foreground">模型改写：{run.revisedPrompt}</p> : null}
      <dl className="space-y-1 text-sm">
        <Row label="预估" value={formatUsd(run.estimateUsd)} />
        <Row label="本次扣费" value={run.costUsd == null ? "接口未返回扣费差额" : formatUsd(run.costUsd)} />
        <Row label="剩余余额" value={formatUsd(run.balanceAfter)} />
      </dl>
      <UsageList usage={run.usage} />
    </div>
  );
}

function PendingState({ startedAt, editing }: { startedAt: number; editing: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  return (
    <div className="rounded-xl border bg-card/70 p-4">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="animate-spin" />
        {editing ? "正在按参考图编辑" : "正在生成"} · {seconds} 秒
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        图片请求常常要几十秒，复杂编辑可能超过一分钟。请留在此页；若中断，先核对「使用记录」和余额，不要立刻重复提交。
      </p>
    </div>
  );
}

function UsageList({ usage }: { usage: UsageNumbers | null }) {
  const entries = useMemo(() => Object.entries(usage ?? {}), [usage]);
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">这次响应没有附带用量明细。</p>;
  return (
    <div className="rounded-xl border p-3 text-xs text-muted-foreground">
      <p className="mb-1 text-foreground">用量</p>
      {entries.map(([key, value]) => (
        <p key={key} className="flex justify-between gap-3 tabular-nums">
          <span>{key}</span>
          <span>{value}</span>
        </p>
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </div>
  );
}
