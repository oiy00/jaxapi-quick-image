"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { ChevronLeft, ChevronRight, Download, Image as ImageIcon, ImagePlus, KeyRound, Loader2, LogOut, Search, Trash2, X } from "lucide-react";
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
import { capChangeWarning, clipboardPasteKind, submitAfterUncertainFailure } from "@/lib/reference-images";
import { ImageViewer, collectViewerImages, type ViewerImage } from "./image-viewer";
import { Segmented, SettingRow, Stage, StageCopy, StageSweep, formatPixels, ratioOf } from "./stage";
import type { ConnectionView, Draft, EstimateView, HistoryCard, KeyOption, ReferenceView, RunView, ViewingRecord } from "./view";

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
  /** Return to the draft. Never clears it. */
  onCompose: () => void;
  /** Explicitly empty the draft prompt and its reference images. */
  onClearDraft: () => void;
  /** The past run being viewed read-only, or null while composing. */
  viewing: ViewingRecord | null;
  /** Copy a past run's prompt, settings and references into the draft. */
  onReuse: (id: string) => void;
  /** A paid request is still waiting on the upstream; a second one must not start. */
  inFlight: boolean;
  /** The last request ended without a clear answer, so the next submit needs an extra click. */
  resubmitGuard: boolean;
  draft: Draft;
  onDraft: (patch: Partial<Draft>) => void;
  references: ReferenceView[];
  referenceCap: number;
  referenceCapNote?: string;
  onAddReferences: (files: File[]) => void;
  onRemoveReference: (id: string) => void;
  onMoveReference: (id: string, direction: -1 | 1) => void;
  headerExtra?: ReactNode;
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
        {props.headerExtra}
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
  const viewing = props.viewing;
  const readOnly = viewing != null;
  const shown = viewing ?? props.draft;
  const qualities = qualitiesFor(props.draft.model);
  const resolutions = resolutionsFor(props.draft.model);
  const shownQualities = qualitiesFor(shown.model);
  const shownResolutions = resolutionsFor(shown.model);
  const blocked = props.connection.state === "blocked";
  const busy = props.inFlight;
  const canGenerate =
    !readOnly && !blocked && props.connection.state !== "loading" && !props.inFlight && Boolean(props.draft.prompt.trim());
  const nextSize = pixelSize(shown.resolution, shown.aspect);
  const gallery = useMemo(() => collectViewerImages(props.history, props.run), [props.history, props.run]);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [refViewer, setRefViewer] = useState<{ images: ViewerImage[]; index: number } | null>(null);
  const draftDirty = Boolean(props.draft.prompt.trim()) || props.references.length > 0;

  function openReferences(list: ReferenceView[], index: number) {
    if (list.length === 0) return;
    setRefViewer({
      index,
      images: list.map((item, i) => ({
        id: `ref:${item.id}`,
        url: item.url,
        name: item.name,
        model: `参考图 ${i + 1}/${list.length}`,
        size: item.width && item.height ? `${item.width}x${item.height}` : "",
      })),
    });
  }

  function openViewer() {
    if (props.run.status !== "success" || gallery.length === 0) return;
    const currentUrl = props.run.images[0]?.url;
    const bySelected = gallery.findIndex((item) => item.id === props.selectedHistoryId);
    const byUrl = currentUrl ? gallery.findIndex((item) => item.url === currentUrl) : -1;
    setViewerIndex(bySelected >= 0 ? bySelected : Math.max(0, byUrl));
  }

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
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_320px]">
      <main className="flex min-h-0 flex-col">
        <ImageStage
          ref={stageRef}
          run={props.run}
          nextSize={nextSize}
          draft={shown}
          waiting={!readOnly && props.inFlight}
          onView={openViewer}
        />
        <Filmstrip
          history={props.history}
          viewingId={viewing?.id ?? null}
          inFlightId={props.inFlight ? props.history.find((item) => item.status === "pending")?.id ?? null : null}
          draftPrompt={props.draft.prompt}
          draftThumb={props.references[0]?.url}
          draftReferenceCount={props.references.length}
          draftDirty={draftDirty}
          onSelect={(id) => {
            props.onSelectHistory(id);
            revealStage();
          }}
          onCompose={props.onCompose}
          onClearDraft={props.onClearDraft}
          onDelete={props.onDeleteHistory}
        />
        {viewing ? (
          <HistoryDock
            viewing={viewing}
            draftDirty={draftDirty}
            onViewReference={(index) => openReferences(viewing.references, index)}
            onReuse={() => props.onReuse(viewing.id)}
            onCompose={props.onCompose}
          />
        ) : (
          <PromptDock
            prompt={props.draft.prompt}
            onPrompt={(prompt) => props.onDraft({ prompt })}
            references={props.references}
            referenceCap={props.referenceCap}
            referenceCapNote={props.referenceCapNote}
            onAddReferences={props.onAddReferences}
            onRemoveReference={props.onRemoveReference}
            onMoveReference={props.onMoveReference}
            onViewReference={(index) => openReferences(props.references, index)}
            price={props.estimate ? formatUsd(props.estimate.totalUsd) : null}
            busy={busy}
            disabled={!canGenerate}
            uncertain={props.resubmitGuard}
            onGenerate={generate}
          />
        )}
      </main>

      <aside className="space-y-6 border-t bg-card px-4 py-5 lg:min-h-0 lg:overflow-y-auto lg:border-t-0 lg:border-l">
        {readOnly ? (
          <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
            这是一条历史记录，设置只能查看。点「待生成」回到草稿继续编辑。
          </p>
        ) : null}
        <SettingRow label="模型">
          <Select
            disabled={readOnly}
            value={shown.model}
            onValueChange={(value) => value && props.onDraft({ model: value as Draft["model"] })}
          >
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
          {shownQualities.length > 1 ? (
            <Select disabled={readOnly} value={shown.quality} onValueChange={(value) => value && props.onDraft({ quality: value })}>
              <SelectTrigger className="w-full" aria-label="质量">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {shownQualities.map((quality) => (
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
            disabled={readOnly}
            value={shown.resolution}
            onChange={(resolution) => props.onDraft({ resolution })}
            options={shownResolutions.map((resolution) => {
              const unit = mediaUnitPrice(shown.model, resolution);
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
                active={shown.aspect === aspect}
                disabled={readOnly}
                onClick={() => props.onDraft({ aspect })}
              />
            ))}
          </div>
        </SettingRow>

        <SettingRow label="张数" note="上游暂不支持一次生成多张，请求里不带 n。">
          <p className="text-sm">每次 1 张</p>
        </SettingRow>

        {!readOnly && props.keys.length > 1 && props.selectedKeyId != null ? (
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
        {viewing ? (
          <div className="border-t pt-5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm">这条记录的预估</span>
              <span className="text-xl font-medium tabular-nums">{formatUsd(viewing.estimateUsd)}</span>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">实际扣费见画布下方的结果栏。</p>
          </div>
        ) : (
          <EstimateBlock estimate={props.estimate} frozen={props.frozenBalance} />
        )}
      </aside>
      {viewerIndex != null && gallery.length > 0 ? (
        <ImageViewer
          images={gallery}
          index={viewerIndex}
          onIndex={setViewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      ) : null}
      {refViewer ? (
        <ImageViewer
          images={refViewer.images}
          index={refViewer.index}
          onIndex={(index) => setRefViewer((current) => (current ? { ...current, index } : current))}
          onClose={() => setRefViewer(null)}
        />
      ) : null}
    </div>
  );
}

function AspectTile({ aspect, active, disabled, onClick }: { aspect: string; active: boolean; disabled?: boolean; onClick: () => void }) {
  const ratio = ratioOf(aspect);
  const box = 22;
  const w = ratio >= 1 ? box : Math.round(box * ratio);
  const h = ratio >= 1 ? Math.round(box / ratio) : box;
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-14 flex-col items-center justify-center gap-1 rounded-md text-xs tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed ${
        active
          ? "bg-primary/8 text-primary ring-1 ring-primary"
          : disabled
            ? "text-muted-foreground/70 ring-1 ring-border"
            : "text-muted-foreground ring-1 ring-border hover:bg-accent hover:text-foreground"
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
  waiting,
  onView,
}: {
  ref: Ref<HTMLDivElement>;
  run: RunView;
  nextSize: string;
  draft: Pick<Draft, "resolution" | "aspect">;
  waiting: boolean;
  onView: () => void;
}) {
  if (run.status === "success") {
    const image = run.images[0];
    return (
      <>
        <Stage ref={ref} ratio={ratioOf(run.size, ratioOf(nextSize))} tone="filled">
          {image ? (
            <button
              type="button"
              className="group absolute inset-0 cursor-zoom-in outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              aria-label="查看大图"
              aria-haspopup="dialog"
              onClick={onView}
            >
              <img src={image.url} alt="生成结果" className="size-full object-contain" />
              <span className="pointer-events-none absolute right-3 bottom-3 inline-flex items-center gap-1 rounded-lg bg-black/70 px-2.5 py-1.5 text-xs text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <Search className="size-3.5" />
                查看大图
              </span>
            </button>
          ) : null}
        </Stage>
        <ResultBar run={run} onView={onView} />
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
          <p className="mt-2">
            {run.timeout || run.uncertain
              ? "先核对使用记录和余额，再决定是否重新生成。不要立刻再提交。"
              : "调整后可以重新生成。"}
          </p>
        </StageCopy>
      </Stage>
    );
  }
  return (
    <Stage ref={ref} ratio={ratioOf(nextSize)}>
      <StageCopy big={formatPixels(nextSize)}>
        {waiting
          ? "上一张还在生成，完成后才能提交下一张。草稿会一直保留。"
          : `${draft.resolution}，${draft.aspect}。在下方写好描述后生成，结果会出现在这个框里。`}
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

function ResultBar({ run, onView }: { run: Extract<RunView, { status: "success" }>; onView: () => void }) {
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
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" aria-haspopup="dialog" onClick={onView}>
              <Search />
              查看大图
            </Button>
            <Button size="sm" variant="outline" nativeButton={false} render={<a href={image.url} download={image.name} />}>
              <Download />
              下载
            </Button>
          </div>
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

const COMPOSE_DRAFT_ID = "compose-draft";

function Filmstrip({
  history,
  viewingId,
  inFlightId,
  draftPrompt,
  draftThumb,
  draftReferenceCount,
  draftDirty,
  onSelect,
  onCompose,
  onClearDraft,
  onDelete,
}: {
  history: HistoryCard[];
  viewingId: string | null;
  inFlightId: string | null;
  draftPrompt: string;
  draftThumb?: string;
  draftReferenceCount: number;
  draftDirty: boolean;
  onSelect: (id: string) => void;
  onCompose: () => void;
  onClearDraft: () => void;
  onDelete: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState<"delete" | "clear" | null>(null);
  useEffect(() => setConfirming(null), [viewingId]);
  const composing = viewingId == null;
  const selected = viewingId ? history.find((item) => item.id === viewingId) ?? null : null;

  return (
    <div className="flex items-center gap-3 border-t bg-background px-3 py-3 md:px-4">
      <button
        type="button"
        onClick={onCompose}
        title="回到待生成的草稿。草稿内容不会被清空。"
        className="flex h-[92px] w-[4.75rem] shrink-0 items-center justify-center self-center rounded-xl border border-dashed border-[#c5cad3] bg-card text-sm whitespace-nowrap text-muted-foreground outline-none hover:border-foreground/30 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        + 新建
      </button>
      <ol className="flex min-w-0 flex-1 items-center gap-2.5 overflow-x-auto px-1 py-1" aria-label="生成记录">
        <li className="shrink-0">
          <DraftCardButton
            selected={composing}
            prompt={draftPrompt}
            thumb={draftThumb}
            referenceCount={draftReferenceCount}
            onSelect={onCompose}
          />
        </li>
        {history.length === 0 ? (
          <li className="self-center px-2 text-xs text-muted-foreground">生成记录只保存在这台浏览器里，换设备不会同步。</li>
        ) : (
          history.map((item) => (
            <li key={item.id} className="shrink-0">
              <HistoryCardButton item={item} selected={item.id === viewingId} onSelect={onSelect} />
            </li>
          ))
        )}
      </ol>
      {composing ? (
        draftDirty ? (
          confirming === "clear" ? (
            <div className="flex shrink-0 gap-1">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  setConfirming(null);
                  onClearDraft();
                }}
              >
                确认清空
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                取消
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" aria-label="清空草稿" className="shrink-0 text-muted-foreground" onClick={() => setConfirming("clear")}>
              <X />
              <span className="hidden sm:inline">清空草稿</span>
            </Button>
          )
        ) : null
      ) : selected && selected.id !== inFlightId ? (
        confirming === "delete" ? (
          <div className="flex shrink-0 gap-1">
            <Button size="sm" variant="destructive" onClick={() => onDelete(selected.id)}>
              确认删除
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              取消
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" aria-label="删除这条" className="shrink-0 text-muted-foreground" onClick={() => setConfirming("delete")}>
            <Trash2 />
            <span className="hidden sm:inline">删除这条</span>
          </Button>
        )
      ) : null}
    </div>
  );
}

const CARD_CLASS =
  "flex h-[108px] w-[260px] shrink-0 items-center gap-2.5 rounded-xl p-2 text-left outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function DraftCardButton({
  selected,
  prompt,
  thumb,
  referenceCount,
  onSelect,
}: {
  selected: boolean;
  prompt: string;
  thumb?: string;
  referenceCount: number;
  onSelect: () => void;
}) {
  const summary = prompt.trim() || "写好描述后生成";
  return (
    <button
      type="button"
      onClick={onSelect}
      data-card={COMPOSE_DRAFT_ID}
      aria-current={selected ? "true" : undefined}
      aria-label={`待生成：${summary}${referenceCount ? `，${referenceCount} 张参考图` : ""}${selected ? "，当前" : ""}`}
      title={prompt.trim() || "写好描述后生成"}
      className={`${CARD_CLASS} ${selected ? "bg-primary/10 ring-2 ring-primary" : "bg-card ring-1 ring-border hover:ring-foreground/25"}`}
    >
      <span
        className={`relative grid size-[92px] shrink-0 place-items-center overflow-hidden rounded-lg border border-dashed ${
          selected ? "border-primary/45 bg-primary/10 text-primary" : "border-border bg-muted/70 text-muted-foreground"
        }`}
      >
        {thumb ? <img src={thumb} alt="" className="size-full object-cover opacity-80" /> : <ImageIcon className="size-6" strokeWidth={1.5} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13px] leading-5 font-medium ${selected ? "text-primary" : "text-foreground"}`}>待生成</span>
        <span className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground">{summary}</span>
        {referenceCount ? <span className="mt-0.5 block text-[11px] text-muted-foreground">{referenceCount} 张参考图</span> : null}
        {selected ? (
          <span className="mt-1 inline-flex h-5 items-center rounded-md bg-primary/15 px-1.5 text-[11px] font-medium text-primary">当前</span>
        ) : null}
      </span>
    </button>
  );
}

function HistoryCardButton({
  item,
  selected,
  onSelect,
}: {
  item: HistoryCard;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const refs = item.referenceCount ? `，${item.referenceCount} 张参考图` : "";
  const label = `${item.model}，${formatPixels(item.size)}${item.status === "succeeded" ? "" : `，${STATUS_LABEL[item.status]}`}${refs}${selected ? "，当前" : ""}`;
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-current={selected ? "true" : undefined}
      aria-label={label}
      title={item.prompt || "未填写提示词"}
      className={`${CARD_CLASS} ${selected ? "bg-primary/10 ring-2 ring-primary" : "bg-card ring-1 ring-border hover:ring-foreground/25"}`}
    >
      <span className="relative size-[92px] shrink-0 overflow-hidden rounded-lg bg-muted">
        {item.thumbUrl ? <img src={item.thumbUrl} alt="" className="size-full object-cover" /> : null}
        {item.status === "succeeded" ? null : (
          <span
            className={`absolute inset-x-0 bottom-0 py-0.5 text-center text-[11px] ${
              item.status === "pending" ? "bg-card/90 text-foreground" : "bg-destructive/85 text-white"
            }`}
          >
            {STATUS_LABEL[item.status]}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-5 font-medium text-foreground">{item.model}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground tabular-nums">{formatPixels(item.size)}</span>
        {item.referenceCount ? <span className="mt-0.5 block text-[11px] text-muted-foreground">{item.referenceCount} 张参考图</span> : null}
        {selected ? (
          <span className="mt-1 inline-flex h-5 items-center rounded-md bg-primary/15 px-1.5 text-[11px] font-medium text-primary">当前</span>
        ) : null}
      </span>
    </button>
  );
}

function ReferenceChip({
  item,
  index,
  onView,
  children,
}: {
  item: ReferenceView;
  index: number;
  onView: (index: number) => void;
  children?: ReactNode;
}) {
  return (
    <span className="flex max-w-56 items-center gap-1 rounded-md bg-accent py-1 pr-1 pl-1 text-xs">
      <button
        type="button"
        onClick={() => onView(index)}
        aria-haspopup="dialog"
        aria-label={`查看参考图 ${item.name}`}
        title="查看大图"
        className="flex min-w-0 cursor-zoom-in items-center gap-1.5 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img src={item.url} alt="" className="size-7 shrink-0 rounded object-cover" />
        <span className="min-w-0 truncate">{item.name}</span>
      </button>
      {children}
    </span>
  );
}

function HistoryDock({
  viewing,
  draftDirty,
  onViewReference,
  onReuse,
  onCompose,
}: {
  viewing: ViewingRecord;
  draftDirty: boolean;
  onViewReference: (index: number) => void;
  onReuse: () => void;
  onCompose: () => void;
}) {
  const [confirmReplace, setConfirmReplace] = useState(false);
  useEffect(() => setConfirmReplace(false), [viewing.id]);
  const missing = Math.max(0, viewing.referenceCount - viewing.references.length);
  const missingNote =
    viewing.references.length === 0 && viewing.mode === "edit" && viewing.referenceCount === 0
      ? "这条是按参考图编辑的旧记录，当时没有保存参考图。"
      : missing > 0
        ? viewing.referencesDropped
          ? `有 ${missing} 张参考图因为浏览器空间不足没有保存。`
          : `有 ${missing} 张参考图没有保存。`
        : null;
  return (
    <div className="border-t bg-background px-3 pt-1 pb-3 md:px-4">
      <div className="rounded-xl bg-muted/60 ring-1 ring-border">
        <label htmlFor="history-prompt" className="sr-only">
          这条记录的描述（只读）
        </label>
        <textarea
          id="history-prompt"
          readOnly
          aria-readonly="true"
          value={viewing.prompt}
          className="block field-sizing-content max-h-[32vh] min-h-20 w-full cursor-default resize-none bg-transparent px-3.5 pt-3 pb-1 text-base leading-7 text-foreground/85 outline-none md:text-[15px]"
        />
        <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
          {viewing.references.map((item, index) => (
            <ReferenceChip key={item.id} item={item} index={index} onView={onViewReference} />
          ))}
          {missingNote ? <span className="text-xs text-muted-foreground">{missingNote}</span> : null}
          <span className="text-xs text-muted-foreground">历史记录只能查看，不能修改。</span>
          <span className="ml-auto" />
          {confirmReplace ? (
            <>
              <span className="text-xs text-muted-foreground">会替换当前草稿的描述、设置和参考图。</span>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setConfirmReplace(false);
                  onReuse();
                }}
              >
                确认替换
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmReplace(false)}>
                取消
              </Button>
            </>
          ) : (
            <>
              <Button type="button" size="sm" variant="ghost" onClick={onCompose}>
                回到草稿
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                title="把这条的描述、设置和参考图带到草稿里，再自己决定是否生成"
                onClick={() => (draftDirty ? setConfirmReplace(true) : onReuse())}
              >
                复用到草稿
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function imageFilesFromList(files: Iterable<File | null>): File[] {
  const images: File[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!file || !file.type.startsWith("image/")) continue;
    const key = `${file.type}:${file.size}:${file.name}:${file.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    images.push(file);
  }
  return images;
}

function PromptDock({
  prompt,
  onPrompt,
  references,
  referenceCap,
  referenceCapNote,
  onAddReferences,
  onRemoveReference,
  onMoveReference,
  onViewReference,
  price,
  busy,
  disabled,
  uncertain,
  onGenerate,
}: {
  prompt: string;
  onPrompt: (value: string) => void;
  references: ReferenceView[];
  referenceCap: number;
  referenceCapNote?: string;
  onAddReferences: (files: File[]) => void;
  onRemoveReference: (id: string) => void;
  onMoveReference: (id: string, direction: -1 | 1) => void;
  onViewReference: (index: number) => void;
  price: string | null;
  busy: boolean;
  disabled: boolean;
  uncertain: boolean;
  onGenerate: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [confirmResubmit, setConfirmResubmit] = useState(false);
  useEffect(() => setConfirmResubmit(false), [uncertain, prompt]);
  function requestSubmit() {
    if (submitAfterUncertainFailure(uncertain, confirmResubmit) === "acknowledge") {
      setConfirmResubmit(true);
      return;
    }
    onGenerate();
  }
  const overCap = capChangeWarning(references.length, referenceCap);
  const showPicker = references.length < referenceCap;
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
          const images = imageFilesFromList(event.dataTransfer.files);
          if (images.length) onAddReferences(images);
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text/plain");
          const images = imageFilesFromList([
            ...[...event.clipboardData.items].map((item) => (item.kind === "file" ? item.getAsFile() : null)),
            ...event.clipboardData.files,
          ]);
          if (clipboardPasteKind({ text, imageCount: images.length }) !== "images") return;
          event.preventDefault();
          onAddReferences(images);
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
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              requestSubmit();
            }
          }}
          placeholder={
            dragging
              ? "松开以添加参考图"
              : "描述要生成的画面，例如：清晨的上海弄堂，湿润的石板路，一盏还亮着的暖黄色窗。"
          }
          className="block field-sizing-content max-h-[32vh] min-h-20 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-base leading-7 outline-none placeholder:text-muted-foreground md:text-[15px]"
        />
        <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
          {references.map((item, index) => (
            <ReferenceChip key={item.id} item={item} index={index} onView={onViewReference}>
              {references.length > 1 ? (
                <>
                  <Button type="button" size="icon-xs" variant="ghost" aria-label={`前移 ${item.name}`} disabled={index === 0} onClick={() => onMoveReference(item.id, -1)}>
                    <ChevronLeft />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`后移 ${item.name}`}
                    disabled={index === references.length - 1}
                    onClick={() => onMoveReference(item.id, 1)}
                  >
                    <ChevronRight />
                  </Button>
                </>
              ) : null}
              <Button type="button" size="icon-xs" variant="ghost" onClick={() => onRemoveReference(item.id)} aria-label={`移除参考图 ${item.name}`}>
                <X />
              </Button>
            </ReferenceChip>
          ))}
          {showPicker ? (
            <label
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring"
              title="PNG、JPEG、WebP，12MB 以内。可上传、拖入，或在描述框按 Ctrl 或 ⌘ + V 粘贴图片。上传后可按当前比例裁剪。"
            >
              <ImagePlus className="size-4" />
              参考图
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple={referenceCap > 1}
                className="sr-only"
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = "";
                  if (files.length) onAddReferences(files);
                }}
              />
            </label>
          ) : null}
          {overCap ? <span className="max-w-sm text-xs leading-5 text-destructive">{overCap}</span> : null}
          {referenceCapNote ? <span className="max-w-xs text-xs leading-5 text-muted-foreground">{referenceCapNote}</span> : null}
          <span className="text-xs text-muted-foreground tabular-nums">{prompt.length}/4000</span>
          <span className="hidden text-xs text-muted-foreground lg:inline">Ctrl 或 ⌘ + Enter 提交</span>
          <span className="ml-auto text-sm tabular-nums">{price}</span>
          <Button
            type="button"
            className="h-9 px-4"
            disabled={disabled}
            onClick={requestSubmit}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {busy
              ? "上一张生成中"
              : uncertain && !confirmResubmit
                ? "先核对记录"
                : uncertain
                  ? "确认再提交一次"
                  : references.length > 0
                    ? "按参考图编辑"
                    : "生成图片"}
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
