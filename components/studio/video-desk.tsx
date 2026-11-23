"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { formatUsd } from "@/lib/money";
import { estimateVideoCost } from "@/lib/pricing";
import { DEFAULT_VIDEO_MODEL, VIDEO_MODELS, defaultDuration, durationsFor, videoSpec } from "@/lib/video-models";
import type { VideoModelId } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

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

export function VideoDesk(props: VideoDeskProps) {
  const storageKey = `jax.video.mock.v1:${props.userId}`;
  const [model, setModel] = useState<VideoModelId>(DEFAULT_VIDEO_MODEL);
  const [duration, setDuration] = useState(defaultDuration(DEFAULT_VIDEO_MODEL));
  const [prompt, setPrompt] = useState("傍晚的河面，一盏船灯慢慢靠近。");
  const [task, setTask] = useState<SavedTask | null>(null);
  const [note, setNote] = useState("本地模拟。未连接上游，不会改动账户余额。");
  const [polling, setPolling] = useState(false);
  const [tab, setTab] = useState("compose");
  const spec = videoSpec(model);
  const estimate = useMemo(() => estimateVideoCost({ model, duration }), [duration, model]);

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
                  error: body.code === "missing" ? "这次进程里已经没有该模拟任务，没有重新提交。" : "查询被拒绝。",
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

  async function submit() {
    if (!props.enabled || !estimate || !prompt.trim() || (task && !isTerminal(task.status))) return;
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
    setTab("result");
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
      setTask({ ...pending, status: "failed", error: "模拟服务没有收下这次提交。没有向中转站重试。" });
    }
  }

  const contentUrl = task?.id && task.status === "completed" ? task.contentUrl : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-3 py-2 lg:hidden">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="history">任务</TabsTrigger>
            <TabsTrigger value="compose">视频</TabsTrigger>
            <TabsTrigger value="result">播放</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    <div className="grid min-h-0 flex-1 lg:grid-cols-[280px_minmax(0,1fr)_minmax(320px,380px)]">
      <section className={pane(tab === "history")}>
        <div className="px-4 py-3">
          <h2 className="text-sm font-medium">视频任务</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">只保存在这台浏览器和这次本地进程里。</p>
        </div>
        <div className="px-3 pb-4">
          {task ? (
            <button type="button" className="w-full rounded-xl border bg-card/50 p-3 text-left" onClick={() => setTab("result")}>
              <span className="line-clamp-2 text-sm">{task.prompt}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {task.model} · {task.duration} 秒 · {statusLabel(task.status)}
              </span>
            </button>
          ) : (
            <p className="rounded-xl border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">还没有模拟任务。</p>
          )}
        </div>
      </section>
      <section className={pane(tab === "compose", true)}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 overflow-y-auto px-4 py-4 md:px-6">
          <div className="rounded-xl border border-primary/40 bg-primary/10 p-3 text-sm leading-6">
            本地模拟，协议未验证。不会向 jaxapi.top 或 SuperGPT 提交，也不会扣真实余额。个人折扣不会改变价表。
          </div>
          <h2 className="font-[family-name:var(--font-display)] text-2xl">描述要生成的视频</h2>
          <Textarea value={prompt} onChange={(event) => setPrompt(event.target.value.slice(0, 2000))} className="min-h-32 text-base" />
          <p className="text-xs text-muted-foreground">在提示词里写 [[fail]] 或 [[stall]] 可演示失败和超时。普通提示词约两秒后给出一段本地样片。</p>
          <label className="space-y-2">
            <span className="text-xs text-muted-foreground">视频模型（{VIDEO_MODELS.length} 个）</span>
            <Select value={model} onValueChange={(value) => value && setModel(value as VideoModelId)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VIDEO_MODELS.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div>
            <p className="text-xs text-muted-foreground">时长</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(spec?.durations ?? []).map((item) => (
                <Button key={item} type="button" size="sm" variant={item === duration ? "default" : "outline"} onClick={() => setDuration(item)}>
                  {item} 秒
                </Button>
              ))}
            </div>
          </div>
          <p className="text-sm text-muted-foreground">分辨率档位 {spec?.resolution}，由模型决定，不能改成别的档。</p>
          <div className="rounded-xl border bg-card/70 p-3 text-sm">
            <div className="flex justify-between"><span>单次售价</span><span className="tabular-nums">{formatUsd(estimate?.totalUsd)}</span></div>
            <div className="mt-1 flex justify-between font-medium"><span>本次预估</span><span className="tabular-nums">{formatUsd(estimate?.totalUsd)}</span></div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{estimate?.tierLabel}。这是成本×2 的绝对价，倍率固定为 1。</p>
          </div>
          {props.blockedReason ? <p className="text-sm text-destructive">{props.blockedReason}</p> : null}
          <Button type="button" className="h-11" disabled={!props.enabled || !estimate || !prompt.trim() || Boolean(task && !isTerminal(task.status))} onClick={() => void submit()}>
            {task && !isTerminal(task.status) ? <Loader2 className="animate-spin" /> : null}
            提交模拟任务
          </Button>
        </div>
      </section>
      <section className={pane(tab === "result")}>
        <div className="px-4 py-3">
          <h2 className="text-sm font-medium">视频结果</h2>
        </div>
        <div className="space-y-3 overflow-y-auto px-4 pb-5">
          <p className="text-xs leading-5 text-muted-foreground">{note}</p>
          {!task ? <p className="text-sm text-muted-foreground">提交后，进度和样片会出现在这里。</p> : null}
          {task && !isTerminal(task.status) ? (
            <div className="rounded-xl border p-3">
              <div className="flex items-center gap-2 text-sm"><Loader2 className="animate-spin" />{statusLabel(task.status)} · {task.progress}%</div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${task.progress}%` }} /></div>
            </div>
          ) : null}
          {task?.error ? <p className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm leading-6">{task.error}</p> : null}
          {contentUrl ? (
            <div className="space-y-2">
              <video className="w-full rounded-xl bg-black" controls src={contentUrl} />
              <a className="text-sm text-primary underline" href={contentUrl} download="jaxapi-mock.mp4">下载样片</a>
              <p className="text-xs text-muted-foreground">样片是本地纯色短片，不是模型生成结果。</p>
            </div>
          ) : null}
          {task ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">模拟预扣</dt><dd className="tabular-nums">{formatUsd(task.priceUsd)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">模拟余额</dt><dd className="tabular-nums">{formatUsd(task.mockBalance)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">账户余额</dt><dd className="tabular-nums">{formatUsd(props.accountBalance)}</dd></div>
            </dl>
          ) : null}
          {task?.id && task.error ? (
            <Button type="button" variant="outline" onClick={() => setPolling(true)}>继续查询</Button>
          ) : null}
        </div>
      </section>
    </div>
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
  if (code === "wrong_group") return "当前密钥不在媒体台分组，模拟任务没有建立。";
  if (code === "insufficient") return "模拟账本余额不够支付这一档，没有建立任务。";
  if (code === "unknown_price") return "这个模型或时长不在 17 个视频档位里。";
  if (code === "forbidden") return "不能查看不属于当前用户的模拟任务。";
  return "模拟任务没有建立。";
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

function pane(visible: boolean, middle = false): string {
  return `flex min-h-0 flex-col ${middle ? "" : "lg:border-r"} ${visible ? "" : "hidden"} lg:flex`;
}

function appPath(path: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
  return `${base}${path}`;
}
