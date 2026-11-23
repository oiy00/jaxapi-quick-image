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
  userId: string;
  groupName: string;
  accountBalance: number | null;
  enabled: boolean;
  blockedReason?: string;
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
  mockBalance: number | null;
  error?: string;
  contentUrl?: string;
};

type MockResponse = {
  mock?: boolean;
  note?: string;
  ok?: boolean;
  code?: string;
  balance?: number;
  task?: {
    id: string;
    status: string;
    progress: number;
    priceUsd: number;
    error?: string;
  };
};

const POLL_MS = 1000;

/** MiniMax H3 variants share one price table shape; listing them as their own group keeps the 17-model menu scannable. */
const MODEL_GROUPS: { label: string; ids: VideoModelId[] }[] = [
  { label: "独立模型", ids: VIDEO_MODELS.filter((item) => !item.id.startsWith("minimax-h3-")).map((item) => item.id) },
  { label: "MiniMax H3 base", ids: VIDEO_MODELS.filter((item) => item.id.startsWith("minimax-h3-base-")).map((item) => item.id) },
  { label: "MiniMax H3 cinematic", ids: VIDEO_MODELS.filter((item) => item.id.startsWith("minimax-h3-cinematic-")).map((item) => item.id) },
  { label: "MiniMax H3 origin", ids: VIDEO_MODELS.filter((item) => item.id.startsWith("minimax-h3-origin-")).map((item) => item.id) },
];

export function VideoDesk(props: VideoDeskProps) {
  const storageKey = `jax.video.mock.v1:${props.userId}`;
  const stageRef = useRef<HTMLDivElement>(null);
  const [model, setModel] = useState<VideoModelId>(DEFAULT_VIDEO_MODEL);
  const [duration, setDuration] = useState(defaultDuration(DEFAULT_VIDEO_MODEL));
  const [prompt, setPrompt] = useState("傍晚的河面，一盏船灯慢慢靠近。");
  const [task, setTask] = useState<SavedTask | null>(null);
  const [note, setNote] = useState("本地演示，未连接上游，不会改动账户余额。");
  const [polling, setPolling] = useState(false);
  const spec = videoSpec(model);
  const estimate = useMemo(() => estimateVideoCost({ model, duration }), [duration, model]);
  const running = Boolean(task && !isTerminal(task.status));
  const canSubmit = props.enabled && Boolean(estimate) && Boolean(prompt.trim()) && !running;
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
    window.localStorage.setItem(storageKey, JSON.stringify(task));
  }, [storageKey, task]);

  const taskId = task?.id;
  useEffect(() => {
    if (!polling || !taskId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const body = await readTask(taskId, props.userId);
        if (stopped) return;
        if (body.note) setNote(body.note);
        if (!body.ok || !body.task) {
          setPolling(false);
          setTask((current) =>
            current
              ? {
                  ...current,
                  error: body.code === "missing" ? "这次进程里已经没有该演示任务，没有重新提交。" : "查询被拒绝。",
                }
              : current,
          );
          return;
        }
        setTask((current) => (current ? applyTask(current, body, props.userId) : current));
        if (isTerminal(body.task.status)) setPolling(false);
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
  }, [polling, props.userId, taskId]);

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
      mockBalance: null,
    };
    setTask(pending);
    revealStage();
    try {
      const response = await fetch(appPath("/api/mock/videos"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: props.userId,
          groupName: props.groupName,
          idempotencyKey,
          model,
          duration,
          prompt: prompt.trim(),
          clientMultiplier: 0.26,
          openingBalance: props.accountBalance ?? 0,
        }),
      });
      const body = (await response.json()) as MockResponse;
      if (body.note) setNote(body.note);
      if (!response.ok || !body.ok || !body.task) {
        setTask({ ...pending, status: "failed", error: failureText(body.code) });
        return;
      }
      setTask(applyTask(pending, body, props.userId));
      if (!isTerminal(body.task.status)) setPolling(true);
    } catch {
      setTask({ ...pending, status: "failed", error: "演示服务没有收下这次提交。没有向中转站重试。" });
    }
  }

  const contentUrl = task?.id && task.status === "completed" ? task.contentUrl : undefined;
  const taskSpec = task ? videoSpec(task.model) : undefined;
  const stageRatio = ratioOf(taskSpec ? VIDEO_PIXEL_SIZE[taskSpec.resolution] : pixels, 16 / 9);

  return (
    <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_320px]">
      <main className="flex min-h-0 flex-col">
        <Stage
          ref={stageRef}
          ratio={task ? stageRatio : ratioOf(pixels, 16 / 9)}
          tone={contentUrl ? "filled" : task?.error || task?.status === "failed" || task?.status === "timeout" ? "error" : running ? "busy" : "idle"}
          tag={
            <span className="rounded-md bg-card px-2 py-1 text-xs text-primary ring-1 ring-primary/30">
              演示：不连接上游，不扣真实余额
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
          ) : task && (task.error || task.status === "failed" || task.status === "timeout") ? (
            <StageCopy>
              <p className="text-foreground">{task.error ?? `任务${statusLabel(task.status)}。`}</p>
              {task.id && task.error ? (
                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setPolling(true)}>
                  继续查询
                </Button>
              ) : null}
            </StageCopy>
          ) : (
            <StageCopy big={formatPixels(pixels)}>
              {spec?.resolution}，{duration} 秒。提交后，进度和演示样片会出现在这个框里。
            </StageCopy>
          )}
        </Stage>

        {contentUrl ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t bg-card px-4 py-2.5 text-sm">
            <span className="font-medium">{task?.model}</span>
            <span className="text-muted-foreground">{task?.duration} 秒</span>
            <span className="text-xs text-muted-foreground">这是本地生成的纯色样片，不是模型结果。</span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              nativeButton={false}
              render={<a href={contentUrl} download="jaxapi-mock.mp4" />}
            >
              <Download />
              下载样片
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
            <p className="text-xs text-muted-foreground">演示任务只保存在这台浏览器和这次本地进程里。</p>
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
              <span className="text-xs text-muted-foreground">
                写 [[fail]] 或 [[stall]] 可演示失败和超时
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">{prompt.length}/2000</span>
              <span className="ml-auto text-sm tabular-nums">{formatUsd(estimate?.totalUsd)}</span>
              <Button type="button" className="h-9 px-4" disabled={!canSubmit} onClick={() => void submit()}>
                {running ? <Loader2 className="animate-spin" /> : null}
                提交演示任务
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

        <SettingRow label="分辨率" note="由模型决定，不能单独修改。像素尺寸只用于显示，不会发送。">
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
            <span className="text-sm">本次预估</span>
            <span className="text-xl font-medium tabular-nums">{formatUsd(estimate?.totalUsd)}</span>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {estimate?.tierLabel ? `${estimate.tierLabel}。` : null}价表上的绝对价，个人折扣不改变它。
          </p>
        </div>

        {task ? (
          <dl className="space-y-1.5 border-t pt-5 text-sm">
            <Line label="演示预扣" value={formatUsd(task.priceUsd)} />
            <Line label="演示账本余额" value={formatUsd(task.mockBalance)} />
            <Line label="真实账户余额" value={formatUsd(props.accountBalance)} />
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

function applyTask(current: SavedTask, body: MockResponse, userId: string): SavedTask {
  const remote = body.task;
  if (!remote) return current;
  const completed = remote.status === "completed";
  return {
    ...current,
    id: remote.id,
    status: remote.status,
    progress: remote.progress,
    priceUsd: remote.priceUsd,
    mockBalance: typeof body.balance === "number" ? body.balance : current.mockBalance,
    error: remote.error,
    contentUrl: completed ? appPath(`/api/mock/videos/${remote.id}/content?userId=${encodeURIComponent(userId)}`) : undefined,
  };
}

async function readTask(id: string, userId: string): Promise<MockResponse> {
  const response = await fetch(appPath(`/api/mock/videos?id=${encodeURIComponent(id)}&userId=${encodeURIComponent(userId)}`), { cache: "no-store" });
  return (await response.json()) as MockResponse;
}

function failureText(code?: string): string {
  if (code === "wrong_group") return "当前密钥不在媒体台分组，演示任务没有建立。";
  if (code === "insufficient") return "演示账本余额不够支付这一档，没有建立任务。";
  if (code === "unknown_price") return "这个模型或时长不在 17 个视频档位里。";
  if (code === "forbidden") return "不能查看不属于当前用户的演示任务。";
  return "演示任务没有建立。";
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "timeout";
}

function statusLabel(status: string): string {
  if (status === "queued") return "排队";
  if (status === "in_progress") return "生成中";
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  if (status === "timeout") return "超时";
  if (status === "submitting") return "提交中";
  return status;
}

function appPath(path: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
  return `${base}${path}`;
}
