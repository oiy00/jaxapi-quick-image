"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { formatUsd } from "@/lib/money";
import { estimateVideoCost } from "@/lib/pricing";
import {
  DEFAULT_VIDEO_MODEL,
  VIDEO_MODELS,
  VIDEO_PIXEL_SIZE,
  defaultDuration,
  durationsFor,
  isVerifiedVideoRequest,
  videoSpec,
} from "@/lib/video-models";
import type { VideoModelId } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Segmented, SettingRow, Stage, StageCopy, StageSweep, formatPixels, ratioOf } from "./stage";

type VideoDeskProps = {
  accessToken: string;
  userId: string;
  accountBalance: number | null;
  enabled: boolean;
  blockedReason?: string;
  onBalance?: (balance: number) => void;
};

type SavedTask = {
  id?: string;
  idempotencyKey: string;
  prompt: string;
  model: VideoModelId;
  duration: number;
  status: string;
  progress: number;
  priceUsd: number | null;
  balanceAfter: number | null;
  error?: string;
  contentUrl?: string;
};

type VideoResponse = {
  ok?: boolean;
  code?: string;
  message?: string;
  balance?: number | null;
  job?: {
    id: string;
    status: string;
    progress: number;
    priceUsd: number;
    error?: string | null;
    model?: string;
    duration?: number;
  };
};

const POLL_MS = 3000;

/** MiniMax H3 variants share one price table shape; listing them as their own group keeps the 17-model menu scannable. */
const MODEL_GROUPS: { label: string; ids: VideoModelId[] }[] = [
  { label: "独立模型", ids: VIDEO_MODELS.filter((item) => !item.id.startsWith("minimax-h3-")).map((item) => item.id) },
  { label: "MiniMax H3 base", ids: VIDEO_MODELS.filter((item) => item.id.startsWith("minimax-h3-base-")).map((item) => item.id) },
  { label: "MiniMax H3 cinematic", ids: VIDEO_MODELS.filter((item) => item.id.startsWith("minimax-h3-cinematic-")).map((item) => item.id) },
  { label: "MiniMax H3 origin", ids: VIDEO_MODELS.filter((item) => item.id.startsWith("minimax-h3-origin-")).map((item) => item.id) },
];

export function VideoDesk(props: VideoDeskProps) {
  const storageKey = `jax.video.job.v1:${props.userId}`;
  const stageRef = useRef<HTMLDivElement>(null);
  const contentUrlRef = useRef<string | null>(null);
  const [model, setModel] = useState<VideoModelId>(DEFAULT_VIDEO_MODEL);
  const [duration, setDuration] = useState(defaultDuration(DEFAULT_VIDEO_MODEL));
  const [prompt, setPrompt] = useState("傍晚的河面，一盏船灯慢慢靠近。");
  const [task, setTask] = useState<SavedTask | null>(null);
  const [note, setNote] = useState("售价来自价表。提交时从余额扣入视频账本，完成不再扣第二次。");
  const [polling, setPolling] = useState(false);
  const spec = videoSpec(model);
  const estimate = useMemo(() => estimateVideoCost({ model, duration }), [duration, model]);
  const verified = isVerifiedVideoRequest(model, duration);
  const running = Boolean(task && !isTerminal(task.status));
  const canSubmit = props.enabled && Boolean(estimate) && verified && Boolean(prompt.trim()) && !running && Boolean(props.accessToken);
  const pixels = spec ? VIDEO_PIXEL_SIZE[spec.resolution] : VIDEO_PIXEL_SIZE["720p"];

  useEffect(() => {
    const allowed = durationsFor(model);
    if (!allowed.includes(duration)) setDuration(allowed[0] ?? defaultDuration(model));
  }, [duration, model]);

  useEffect(() => {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as SavedTask;
      setTask(saved);
      if (saved.id && !isTerminal(saved.status)) setPolling(true);
    } catch {
      window.localStorage.removeItem(storageKey);
    }
  }, [storageKey]);

  useEffect(() => {
    if (!task) return;
    const stored = { ...task, contentUrl: undefined };
    window.localStorage.setItem(storageKey, JSON.stringify(stored));
  }, [storageKey, task]);

  useEffect(() => {
    const urls = contentUrlRef;
    return () => {
      if (urls.current) URL.revokeObjectURL(urls.current);
    };
  }, []);

  const taskId = task?.id;
  const onBalanceRef = useRef(props.onBalance);
  onBalanceRef.current = props.onBalance;
  useEffect(() => {
    if (!polling || !taskId || !props.accessToken) return;
    let stopped = false;
    const tick = async () => {
      try {
        const body = await readTask(taskId, props.accessToken);
        if (stopped) return;
        if (typeof body.balance === "number") onBalanceRef.current?.(body.balance);
        if (!body.ok || !body.job) {
          setPolling(false);
          setTask((current) =>
            current
              ? { ...current, error: body.message || (body.code === "missing" ? "服务端没有这个任务，没有重新提交。" : "查询被拒绝。") }
              : current,
          );
          return;
        }
        const remote = body.job;
        const contentUrl = remote.status === "completed" ? await loadContent(remote.id, props.accessToken, contentUrlRef) : undefined;
        if (stopped) return;
        setTask((current) =>
          current
            ? {
                ...current,
                id: remote.id,
                status: remote.status,
                progress: remote.progress,
                priceUsd: remote.priceUsd,
                balanceAfter: typeof body.balance === "number" ? body.balance : current.balanceAfter,
                error: remote.error || undefined,
                contentUrl: contentUrl ?? current.contentUrl,
              }
            : current,
        );
        if (isTerminal(remote.status)) setPolling(false);
      } catch {
        if (!stopped) {
          setTask((current) => (current ? { ...current, error: "查询中断。可以继续查询，不会重新提交。" } : current));
        }
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [polling, props.accessToken, taskId]);

  function revealStage() {
    if (window.matchMedia("(min-width: 1024px)").matches) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    stageRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  }

  async function submit() {
    if (!canSubmit || !estimate) return;
    const idempotencyKey = crypto.randomUUID();
    const pending: SavedTask = {
      idempotencyKey,
      prompt: prompt.trim(),
      model,
      duration,
      status: "submitting",
      progress: 0,
      priceUsd: estimate.totalUsd,
      balanceAfter: null,
    };
    setTask(pending);
    revealStage();
    try {
      const response = await fetch(appPath("/api/videos"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${props.accessToken}` },
        body: JSON.stringify({ idempotencyKey, model, duration, prompt: prompt.trim() }),
      });
      const body = (await response.json()) as VideoResponse;
      if (typeof body.balance === "number") props.onBalance?.(body.balance);
      if (!body.ok || !body.job) {
        setNote(body.message || failureText(body.code));
        setTask({ ...pending, status: "failed", error: body.message || failureText(body.code) });
        return;
      }
      setNote(body.message || "已按价表处理。查询不会再次扣费。");
      setTask(await applyTask(pending, body, props.accessToken, contentUrlRef));
      if (!isTerminal(body.job.status)) setPolling(true);
    } catch {
      setTask({ ...pending, status: "upstream_unknown", error: "提交结果不确定。正在按同一个幂等键查询，没有自动重试。" });
      try {
        const recovered = await fetch(appPath(`/api/videos?idempotencyKey=${encodeURIComponent(idempotencyKey)}`), {
          headers: { authorization: `Bearer ${props.accessToken}` },
          cache: "no-store",
        });
        const body = (await recovered.json()) as VideoResponse;
        if (body.ok && body.job) {
          setTask(await applyTask(pending, body, props.accessToken, contentUrlRef));
          if (!isTerminal(body.job.status)) setPolling(true);
          return;
        }
      } catch {
        // The original request stays unresolved. Do not POST again.
      }
      setTask({ ...pending, status: "upstream_unknown", error: "没有确认任务是否建立。不要立刻再次提交同一条。" });
    }
  }

  const contentUrl = task?.status === "completed" ? task.contentUrl : undefined;
  const taskSpec = task ? videoSpec(task.model) : undefined;
  const stageRatio = ratioOf(taskSpec ? VIDEO_PIXEL_SIZE[taskSpec.resolution] : pixels, 16 / 9);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_320px]">
      <main className="flex min-h-0 flex-col">
        <Stage
          ref={stageRef}
          ratio={task ? stageRatio : ratioOf(pixels, 16 / 9)}
          tone={contentUrl ? "filled" : task?.error || task?.status === "failed" ? "error" : running ? "busy" : "idle"}
          tag={
            <span className="rounded-md bg-card px-2 py-1 text-xs text-primary ring-1 ring-primary/30">
              {verified ? "按价表先扣余额" : "这一档暂不提交"}
            </span>
          }
        >
          {contentUrl ? (
            <video className="absolute inset-0 size-full bg-black object-contain" controls src={contentUrl} />
          ) : task && running ? (
            <>
              <StageSweep />
              <StageCopy big={`${task.progress}%`}>
                <p role="status" className="flex items-center justify-center gap-2 text-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {statusLabel(task.status)}
                </p>
              </StageCopy>
              <div className="absolute inset-x-0 bottom-0 h-1 bg-muted">
                <div className="h-full bg-primary transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${task.progress}%` }} />
              </div>
            </>
          ) : task && (task.error || task.status === "failed" || task.status === "upstream_unknown" || task.status === "debit_unknown") ? (
            <StageCopy>
              <p className="text-foreground">{task.error ?? `任务${statusLabel(task.status)}。`}</p>
              {task.id ? (
                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setPolling(true)}>
                  继续查询
                </Button>
              ) : null}
            </StageCopy>
          ) : (
            <StageCopy big={formatPixels(pixels)}>
              {spec?.resolution}，{duration} 秒。{verified ? "提交后，进度会显示在这个框里。" : "这一档还不能生成。"}
            </StageCopy>
          )}
        </Stage>

        {contentUrl ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t bg-card px-4 py-2.5 text-sm">
            <span className="font-medium">{task?.model}</span>
            <span className="text-muted-foreground">{task?.duration} 秒</span>
            <span className="text-xs text-muted-foreground">{formatUsd(task?.priceUsd)}</span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              nativeButton={false}
              render={<a href={contentUrl} download="jaxapi-video.mp4" />}
            >
              <Download />
              下载
            </Button>
          </div>
        ) : null}

        <div className="flex items-center gap-3 border-t bg-background px-3 py-2.5 md:px-4">
          {task ? (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" title={task.prompt}>
                {task.prompt}
              </p>
              <p className="text-xs text-muted-foreground">
                {task.model}，{task.duration} 秒，{statusLabel(task.status)}
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">任务保存在服务端。刷新后可以继续查询，不会重新提交。</p>
          )}
        </div>

        <div className="border-t bg-background px-3 pt-1 pb-3 md:px-4">
          <div className="rounded-xl bg-card ring-1 ring-border focus-within:ring-ring">
            <label htmlFor="video-prompt" className="sr-only">
              描述要生成的视频
            </label>
            <textarea
              id="video-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value.slice(0, 2000))}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit();
              }}
              placeholder="描述要生成的视频，例如：傍晚的河面，一盏船灯慢慢靠近。"
              className="block field-sizing-content max-h-[32vh] min-h-20 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-base leading-7 outline-none placeholder:text-muted-foreground md:text-[15px]"
            />
            <div className="flex flex-wrap items-center gap-2 px-3 pb-2">
              <span className="text-xs text-muted-foreground tabular-nums">{prompt.length}/2000</span>
              <span className="ml-auto text-sm tabular-nums">{formatUsd(estimate?.totalUsd)}</span>
              <Button type="button" className="h-9 px-4" disabled={!canSubmit} onClick={() => void submit()}>
                {running ? <Loader2 className="animate-spin" /> : null}
                生成视频
              </Button>
            </div>
          </div>
        </div>
      </main>

      <aside className="space-y-6 border-t bg-card px-4 py-5 lg:min-h-0 lg:overflow-y-auto lg:border-t-0 lg:border-l">
        <SettingRow label={`模型（${VIDEO_MODELS.length} 个）`}>
          <Select value={model} onValueChange={(value) => value && setModel(value as VideoModelId)}>
            <SelectTrigger className="w-full" aria-label="视频模型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODEL_GROUPS.map((group) => (
                <SelectGroup key={group.label}>
                  <SelectLabel>{group.label}</SelectLabel>
                  {group.ids.map((id) => (
                    <SelectItem key={id} value={id}>
                      {videoSpec(id)?.label ?? id}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow label="时长">
          {spec && spec.durations.length > 1 ? (
            <Segmented
              label="时长"
              value={duration}
              onChange={setDuration}
              options={spec.durations.map((item) => ({
                value: item,
                label: `${item} 秒`,
                hint: `${spec.prices[item]?.toFixed(2) ?? "—"} USD`,
              }))}
            />
          ) : (
            <p className="text-sm">
              {duration} 秒<span className="ml-2 text-xs text-muted-foreground">这个模型只有这一档</span>
            </p>
          )}
        </SettingRow>

        <SettingRow label="分辨率" note="由模型决定。768p 提交时发送 1344×768。未核实的档位不会发送。">
          <p className="text-sm tabular-nums">
            {spec?.resolution}
            <span className="ml-2 text-muted-foreground">{formatPixels(pixels)}</span>
          </p>
        </SettingRow>

        {props.blockedReason ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm leading-6">{props.blockedReason}</p>
        ) : null}

        <div className="border-t pt-5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm">本次售价</span>
            <span className="text-xl font-medium tabular-nums">{formatUsd(estimate?.totalUsd)}</span>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {estimate?.tierLabel ? `${estimate.tierLabel}。` : null}
            {verified ? "价表上的绝对售价。明确失败退回这一笔；超时不退、也不重试。" : "价表里有这一档，但没有已完成的上游记录，按钮保持关闭。"}
          </p>
        </div>

        {task ? (
          <dl className="space-y-1.5 border-t pt-5 text-sm">
            <Line label="本单售价" value={formatUsd(task.priceUsd)} />
            <Line label="扣费后余额" value={formatUsd(task.balanceAfter)} />
            <Line label="账户余额" value={formatUsd(props.accountBalance)} />
          </dl>
        ) : null}
        <p className="text-xs leading-5 text-muted-foreground">{note}</p>
      </aside>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

async function applyTask(
  current: SavedTask,
  body: VideoResponse,
  accessToken: string,
  contentUrlRef: { current: string | null },
): Promise<SavedTask> {
  const remote = body.job;
  if (!remote) return current;
  let contentUrl = current.contentUrl;
  if (remote.status === "completed" && remote.id) {
    contentUrl = await loadContent(remote.id, accessToken, contentUrlRef);
  }
  return {
    ...current,
    id: remote.id,
    status: remote.status,
    progress: remote.progress,
    priceUsd: remote.priceUsd,
    balanceAfter: typeof body.balance === "number" ? body.balance : current.balanceAfter,
    error: remote.error || undefined,
    contentUrl,
  };
}

async function loadContent(id: string, accessToken: string, contentUrlRef: { current: string | null }): Promise<string | undefined> {
  const response = await fetch(appPath(`/api/videos/${id}/content`), {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok) return undefined;
  const blob = await response.blob();
  if (contentUrlRef.current) URL.revokeObjectURL(contentUrlRef.current);
  const url = URL.createObjectURL(blob);
  contentUrlRef.current = url;
  return url;
}

async function readTask(id: string, accessToken: string): Promise<VideoResponse> {
  const response = await fetch(appPath(`/api/videos/${id}`), {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  return (await response.json()) as VideoResponse;
}

function failureText(code?: string): string {
  if (code === "wrong_group") return "当前账户不在媒体台分组 11，没有建立任务。";
  if (code === "insufficient") return "余额不够支付这一档，没有向视频上游提交。";
  if (code === "unknown_price") return "这个模型或时长没有已配置的售价。";
  if (code === "unproven") return "这一档没有已完成的上游记录，没有提交。";
  if (code === "billing_unconfigured") return "账户扣费还没接上，没有向视频上游提交。";
  if (code === "forbidden") return "不能查看这个任务。";
  if (code === "unauthorized") return "登录已失效，没有提交。";
  return "任务没有建立。没有自动重试。";
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "debit_unknown" || status === "upstream_unknown";
}

function statusLabel(status: string): string {
  if (status === "queued") return "排队";
  if (status === "in_progress" || status === "held") return "生成中";
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  if (status === "upstream_unknown" || status === "debit_unknown") return "结果不明";
  if (status === "submitting" || status === "reserved") return "提交中";
  return status;
}

function appPath(path: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
  return `${base}${path}`;
}
