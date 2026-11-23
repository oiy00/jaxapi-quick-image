"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { Download, ImagePlus, KeyRound, Loader2, LogOut, Plus, Trash2, X } from "lucide-react";
import { formatUsd } from "@/lib/money";
import { ASPECTS, FIXED_COUNT, MODELS, pixelSize, qualitiesFor, resolutionsFor } from "@/lib/models";
import { mediaUnitPrice } from "@/lib/pricing";
import type { UsageNumbers } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Segmented, SettingRow, Stage, StageCopy, StageSweep, formatPixels, ratioOf } from "./stage";
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
  const [desk, setDesk] = useState<"image" | "video">("image");

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:min-h-0">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-3 md:gap-5 md:px-5">
        {props.embedded ? null : (
          <span className="font-[family-name:var(--font-display)] text-lg font-medium tracking-tight">JaxApi</span>
        )}
        <div className="w-36">
          <Segmented
            label="工作台"
            size="sm"
            value={desk}
            onChange={setDesk}
            options={[
              { value: "image", label: "生图" },
              { value: "video", label: "视频" },
            ]}
          />
        </div>
        {props.previewNote ? (
          <p className="hidden text-xs text-primary md:block">{props.previewNote}</p>
        ) : null}
        <div className="ml-auto flex items-center gap-1 md:gap-3">
          <p className="text-right text-sm whitespace-nowrap tabular-nums">
            <span className="mr-1.5 hidden text-xs text-muted-foreground sm:inline">余额</span>
            {formatUsd(props.balance)}
          </p>
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={<a href="/keys" target={props.embedded ? "_parent" : "_blank"} rel="noreferrer" />}
          >
            <KeyRound />
            <span className="hidden sm:inline">密钥</span>
          </Button>
          {props.showLogout === false ? (
            <span className="hidden text-xs text-muted-foreground lg:inline">{props.email}</span>
          ) : (
            <Button variant="ghost" size="sm" onClick={props.onLogout} aria-label={`退出 ${props.email}`} title="退出登录">
              <LogOut />
              <span className="hidden lg:inline">{props.email}</span>
            </Button>
          )}
        </div>
      </header>
      {props.previewNote ? (
        <p className="border-b bg-primary/10 px-3 py-1.5 text-xs text-primary md:hidden">{props.previewNote}</p>
      ) : null}

      {desk === "video" ? <div className="flex min-h-0 flex-1 flex-col">{props.videoDesk}</div> : <ImageDesk {...props} />}
    </div>
  );
}

function ImageDesk(props: StudioProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const qualities = qualitiesFor(props.draft.model);
  const resolutions = resolutionsFor(props.draft.model);
  const blocked = props.connection.state === "blocked";
  const busy = props.run.status === "pending";
  const canGenerate = !blocked && props.connection.state !== "loading" && !busy && Boolean(props.draft.prompt.trim());
  const nextSize = pixelSize(props.draft.resolution, props.draft.aspect);

  useEffect(() => {
    const patch: Partial<Draft> = {};
    if (!qualities.includes(props.draft.quality)) patch.quality = "auto";
    if (!resolutions.includes(props.draft.resolution)) patch.resolution = resolutions[0] ?? "1K";
    if (props.draft.count !== FIXED_COUNT) patch.count = FIXED_COUNT;
    if (Object.keys(patch).length) props.onDraft(patch);
  }, [props, qualities, resolutions]);

  function revealStage() {
    if (window.matchMedia("(min-width: 1024px)").matches) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    stageRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  }

  function generate() {
    if (!canGenerate) return;
    props.onGenerate();
    revealStage();
  }

  return (
    <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_320px]">
      <main className="flex min-h-0 flex-col">
        <ImageStage ref={stageRef} run={props.run} nextSize={nextSize} draft={props.draft} />
        <Filmstrip
          history={props.history}
          selectedId={props.selectedHistoryId}
          onSelect={(id) => {
            props.onSelectHistory(id);
            revealStage();
          }}
          onDelete={props.onDeleteHistory}
          onCreate={props.onCreate}
        />
        <PromptDock
          prompt={props.draft.prompt}
          onPrompt={(prompt) => props.onDraft({ prompt })}
          referenceName={props.referenceName}
          referenceUrl={props.referenceUrl}
          onPickReference={props.onPickReference}
          onClearReference={props.onClearReference}
          price={props.estimate ? formatUsd(props.estimate.totalUsd) : null}
          busy={busy}
          disabled={!canGenerate}
          onGenerate={generate}
        />
      </main>

      <aside className="space-y-6 border-t bg-card px-4 py-5 lg:min-h-0 lg:overflow-y-auto lg:border-t-0 lg:border-l">
        <SettingRow label="模型">
          <Select value={props.draft.model} onValueChange={(value) => value && props.onDraft({ model: value as Draft["model"] })}>
            <SelectTrigger className="w-full" aria-label="模型">
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
        </SettingRow>

        <SettingRow label="质量">
          {qualities.length > 1 ? (
            <Select value={props.draft.quality} onValueChange={(value) => value && props.onDraft({ quality: value })}>
              <SelectTrigger className="w-full" aria-label="质量">
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
          ) : (
            <p className="text-sm">auto<span className="ml-2 text-xs text-muted-foreground">这个模型不能调质量</span></p>
          )}
        </SettingRow>

        <SettingRow label="分辨率">
          <Segmented
            label="分辨率"
            value={props.draft.resolution}
            onChange={(resolution) => props.onDraft({ resolution })}
            options={resolutions.map((resolution) => {
              const unit = mediaUnitPrice(props.draft.model, resolution);
              return { value: resolution, label: resolution, hint: unit == null ? "—" : `${unit.toFixed(2)} USD` };
            })}
          />
        </SettingRow>

        <SettingRow label="画面比例">
          <div role="group" aria-label="画面比例" className="grid grid-cols-3 gap-1.5">
            {ASPECTS.map((aspect) => (
              <AspectTile
                key={aspect}
                aspect={aspect}
                active={props.draft.aspect === aspect}
                onClick={() => props.onDraft({ aspect })}
              />
            ))}
          </div>
        </SettingRow>

        <SettingRow label="张数" note="上游暂不支持一次生成多张，请求里不带 n。">
          <p className="text-sm">每次 1 张</p>
        </SettingRow>

        {props.keys.length > 1 && props.selectedKeyId != null ? (
          <SettingRow label="使用的密钥">
            <Select value={String(props.selectedKeyId)} onValueChange={(value) => value && props.onSelectKey(Number(value))}>
              <SelectTrigger className="w-full" aria-label="使用的密钥">
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
          </SettingRow>
        ) : null}

        <ConnectionNote embedded={props.embedded} connection={props.connection} />
        <EstimateBlock estimate={props.estimate} frozen={props.frozenBalance} />
      </aside>
    </div>
  );
}

function AspectTile({ aspect, active, onClick }: { aspect: string; active: boolean; onClick: () => void }) {
  const ratio = ratioOf(aspect);
  const box = 22;
  const w = ratio >= 1 ? box : Math.round(box * ratio);
  const h = ratio >= 1 ? Math.round(box / ratio) : box;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex h-14 flex-col items-center justify-center gap-1 rounded-md text-xs tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
        active ? "bg-primary/8 text-primary ring-1 ring-primary" : "text-muted-foreground ring-1 ring-border hover:bg-accent hover:text-foreground"
      }`}
    >
      <span aria-hidden className="grid size-6 place-items-center">
        <span
          className={`block rounded-[2px] border ${active ? "border-primary bg-primary/20" : "border-current"}`}
          style={{ width: w, height: h }}
        />
      </span>
      {aspect}
    </button>
  );
}

function ImageStage({
  ref,
  run,
  nextSize,
  draft,
}: {
  ref: Ref<HTMLDivElement>;
  run: RunView;
  nextSize: string;
  draft: Draft;
}) {
  if (run.status === "success") {
    const image = run.images[0];
    return (
      <>
        <Stage ref={ref} ratio={ratioOf(run.size, ratioOf(nextSize))} tone="filled">
          {image ? <img src={image.url} alt="生成结果" className="absolute inset-0 size-full object-contain" /> : null}
        </Stage>
        <ResultBar run={run} />
      </>
    );
  }
  if (run.status === "pending") {
    return (
      <Stage ref={ref} ratio={ratioOf(nextSize)} tone="busy">
        <StageSweep />
        <PendingCopy startedAt={run.startedAt} editing={run.mode === "edit"} />
      </Stage>
    );
  }
  if (run.status === "error") {
    return (
      <Stage ref={ref} ratio={ratioOf(nextSize)} tone="error">
        <StageCopy>
          <p className="text-foreground">{run.message}</p>
          <p className="mt-2">{run.timeout ? "先核对使用记录和余额，再决定是否重新生成。" : "调整后可以重新生成。"}</p>
        </StageCopy>
      </Stage>
    );
  }
  return (
    <Stage ref={ref} ratio={ratioOf(nextSize)}>
      <StageCopy big={formatPixels(nextSize)}>
        {draft.resolution}，{draft.aspect}。在下方写好描述后生成，结果会出现在这个框里。
      </StageCopy>
    </Stage>
  );
}

function PendingCopy({ startedAt, editing }: { startedAt: number; editing: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  return (
    <StageCopy big={`${seconds} 秒`}>
      <p role="status" className="flex items-center justify-center gap-2 text-foreground">
        <Loader2 className="size-4 animate-spin" />
        {editing ? "正在按参考图编辑" : "正在生成"}
      </p>
      <p className="mt-2">通常要几十秒，复杂编辑可能超过一分钟。请留在此页；如果中断，先核对使用记录和余额，不要马上重复提交。</p>
    </StageCopy>
  );
}

function ResultBar({ run }: { run: Extract<RunView, { status: "success" }> }) {
  const image = run.images[0];
  return (
    <div className="border-t bg-card px-4 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="font-medium">{run.model}</span>
        <span className="text-muted-foreground tabular-nums">{formatPixels(run.size)}</span>
        <Figure label="预估" value={formatUsd(run.estimateUsd)} />
        <Figure label="扣费" value={run.costUsd == null ? "接口未返回" : formatUsd(run.costUsd)} />
        <Figure label="余额" value={formatUsd(run.balanceAfter)} />
        {image ? (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            nativeButton={false}
            render={<a href={image.url} download={image.name} />}
          >
            <Download />
            下载
          </Button>
        ) : null}
      </div>
      {run.revisedPrompt ? <p className="mt-1.5 text-xs leading-5 text-muted-foreground">模型改写后的描述：{run.revisedPrompt}</p> : null}
      <UsageDetails usage={run.usage} />
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <span className="tabular-nums">
      <span className="mr-1.5 text-xs text-muted-foreground">{label}</span>
      {value}
    </span>
  );
}

function UsageDetails({ usage }: { usage: UsageNumbers | null }) {
  const entries = useMemo(() => Object.entries(usage ?? {}), [usage]);
  if (entries.length === 0) return null;
  return (
    <details className="mt-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none hover:text-foreground">用量明细</summary>
      <dl className="mt-1 grid max-w-xs grid-cols-[1fr_auto] gap-x-4 tabular-nums">
        {entries.map(([key, value]) => (
          <div key={key} className="contents">
            <dt>{key}</dt>
            <dd className="text-right">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function Filmstrip({
  history,
  selectedId,
  onSelect,
  onDelete,
  onCreate,
}: {
  history: HistoryCard[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [selectedId]);
  const selected = history.find((item) => item.id === selectedId);

  return (
    <div className="flex items-center gap-3 border-t bg-background px-3 py-2.5 md:px-4">
      <button
        type="button"
        onClick={onCreate}
        aria-label="新建"
        title="新建：清空描述和结果"
        className="grid size-12 shrink-0 place-items-center rounded-md text-muted-foreground ring-1 ring-border outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus className="size-5" />
      </button>
      <ol className="flex min-w-0 flex-1 gap-2 overflow-x-auto py-0.5" aria-label="生成记录">
        {history.length === 0 ? (
          <li className="self-center text-xs text-muted-foreground">生成记录只保存在这台浏览器里，换设备不会同步。</li>
        ) : (
          history.map((item) => (
            <li key={item.id} className="shrink-0">
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                aria-current={item.id === selectedId}
                title={item.prompt || "未填写提示词"}
                className={`relative block size-12 overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  item.id === selectedId ? "ring-2 ring-primary" : "ring-1 ring-border hover:ring-foreground/40"
                }`}
              >
                {item.thumbUrl ? <img src={item.thumbUrl} alt="" className="size-full object-cover" /> : null}
                {item.status === "succeeded" ? null : (
                  <span className={`absolute inset-x-0 bottom-0 py-px text-center text-[10px] ${item.status === "pending" ? "bg-card/90" : "bg-destructive/85 text-white"}`}>
                    {STATUS_LABEL[item.status]}
                  </span>
                )}
                <span className="sr-only">{item.prompt || "未填写提示词"}</span>
              </button>
            </li>
          ))
        )}
      </ol>
      {selected ? (
        confirming ? (
          <div className="flex shrink-0 gap-1">
            <Button size="sm" variant="destructive" onClick={() => onDelete(selected.id)}>
              确认删除
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              取消
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" className="shrink-0 text-muted-foreground" onClick={() => setConfirming(true)}>
            <Trash2 />
            <span className="hidden sm:inline">删除这条</span>
          </Button>
        )
      ) : null}
    </div>
  );
}

function PromptDock({
  prompt,
  onPrompt,
  referenceName,
  referenceUrl,
  onPickReference,
  onClearReference,
  price,
  busy,
  disabled,
  onGenerate,
}: {
  prompt: string;
  onPrompt: (value: string) => void;
  referenceName: string | null;
  referenceUrl: string | null;
  onPickReference: (file: File) => void;
  onClearReference: () => void;
  price: string | null;
  busy: boolean;
  disabled: boolean;
  onGenerate: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div className="border-t bg-background px-3 pt-1 pb-3 md:px-4">
      <div
        className={`rounded-xl bg-card ring-1 transition-shadow focus-within:ring-ring ${dragging ? "ring-2 ring-primary" : "ring-border"}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files?.[0];
          if (file) onPickReference(file);
        }}
      >
        <label htmlFor="image-prompt" className="sr-only">
          描述要生成的画面
        </label>
        <textarea
          id="image-prompt"
          value={prompt}
          onChange={(event) => onPrompt(event.target.value.slice(0, 4000))}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") onGenerate();
          }}
          placeholder={
            dragging
              ? "松开以添加参考图"
              : "描述要生成的画面，例如：清晨的上海弄堂，湿润的石板路，一盏还亮着的暖黄色窗。"
          }
          className="block field-sizing-content max-h-[32vh] min-h-20 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-base leading-7 outline-none placeholder:text-muted-foreground md:text-[15px]"
        />
        <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
          {referenceUrl && referenceName ? (
            <span className="flex max-w-56 items-center gap-2 rounded-md bg-accent py-1 pr-1 pl-1 text-xs">
              <img src={referenceUrl} alt="" className="size-7 rounded object-cover" />
              <span className="min-w-0 truncate" title={referenceName}>
                {referenceName}
              </span>
              <Button type="button" size="icon-xs" variant="ghost" onClick={onClearReference} aria-label="移除参考图">
                <X />
              </Button>
            </span>
          ) : (
            <label
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring"
              title="PNG、JPEG、WebP，12MB 以内。上传后可按当前比例裁剪。也可以直接拖进来。"
            >
              <ImagePlus className="size-4" />
              参考图
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) onPickReference(file);
                }}
              />
            </label>
          )}
          <span className="text-xs text-muted-foreground tabular-nums">{prompt.length}/4000</span>
          <span className="hidden text-xs text-muted-foreground lg:inline">Ctrl 或 ⌘ + Enter 提交</span>
          <span className="ml-auto text-sm tabular-nums">{price}</span>
          <Button type="button" className="h-9 px-4" disabled={disabled} onClick={onGenerate}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {referenceName ? "按参考图编辑" : "生成图片"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConnectionNote({ connection, embedded }: { connection: ConnectionView; embedded?: boolean }) {
  if (connection.state === "loading") return <p className="text-sm text-muted-foreground">正在查找可用的图片密钥…</p>;
  if (connection.state === "ready") {
    return (
      <SettingRow label="当前密钥">
        <p className="text-sm">{connection.label}</p>
      </SettingRow>
    );
  }
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm leading-6">
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

function EstimateBlock({ estimate, frozen }: { estimate: EstimateView | null; frozen?: number | null }) {
  return (
    <div className="border-t pt-5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm">本次预估</span>
        <span className="text-xl font-medium tabular-nums">{estimate ? formatUsd(estimate.totalUsd) : "—"}</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        {estimate
          ? `${estimate.model ?? "当前模型"} ${estimate.resolution} 的固定售价，不乘个人倍率，质量档不影响价格。`
          : "这个组合没有标价。"}
        实际以扣费后的余额为准。
      </p>
      {frozen ? <p className="mt-2 text-xs text-muted-foreground">余额中有 {formatUsd(frozen)} 被冻结，暂不可用。</p> : null}
    </div>
  );
}
