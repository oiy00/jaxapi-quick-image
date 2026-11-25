"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ensureImageKey,
  fetchAvailableGroups,
  fetchImageKeys,
  fetchMe,
  fetchPublicSettings,
  logoutSession,
  refreshSession,
  requestImage,
} from "@/lib/account";
import { JaxClientError } from "@/lib/jax-client";
import { deleteHistory, listHistory, saveHistory, settleStalePending } from "@/lib/history-db";
import { b64ToBlob, parseGenerationPayload } from "@/lib/images";
import { isMediaKey, keyBlockReason, keyLabel, pickImageKey } from "@/lib/keys";
import { DEFAULT_ASPECT, DEFAULT_MODEL, DEFAULT_QUALITY, DEFAULT_RESOLUTION, FIXED_COUNT, isImageModelId, pixelSize, resolutionsFor } from "@/lib/models";
import { chargeFromBalance, estimateImageCost } from "@/lib/pricing";
import { editRejection } from "@/lib/reference-images";
import { persistAttempts, snapshotReference } from "@/lib/reference-snapshot";
import { BalanceSequencer, ImageRequestTracker, MAX_CONCURRENT_IMAGES, OVERLAP_COST_NOTE } from "@/lib/image-concurrency";
import { clearSession, isEmbedded, readPreferredKeyId, readSession, stripSensitiveQueryInPlace, writePreferredKeyId, writeSession } from "@/lib/session";
import { aspectValue } from "@/lib/models";
import type { ApiKeyRecord, HistoryRecord, HistoryReference, PublicSettings, PublicUser, StoredSession } from "@/lib/types";
import { LoginScreen } from "@/components/auth/login-screen";
import { CropDialog } from "@/components/studio/crop-dialog";
import { Studio } from "@/components/studio/studio";
import { useReferenceTray } from "@/components/studio/use-references";
import { VideoDesk } from "@/components/studio/video-desk";
import type { ConnectionView, Draft, HistoryCard, ReferenceView, RunView, ViewingRecord } from "@/components/studio/view";

type LiveRecord = HistoryRecord & { urls: string[]; refs: ReferenceView[] };

const EMPTY_DRAFT: Draft = {
  prompt: "",
  model: DEFAULT_MODEL,
  resolution: DEFAULT_RESOLUTION,
  aspect: DEFAULT_ASPECT,
  quality: DEFAULT_QUALITY,
  count: 1,
};

export function AppShell() {
  const [booting, setBooting] = useState(true);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [session, setSession] = useState<StoredSession | null>(null);
  const [user, setUser] = useState<PublicUser | null>(null);
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const references = useReferenceTray(draft.model);
  const [history, setHistory] = useState<LiveRecord[]>([]);
  /** The history record being viewed read-only. null means the draft is shown. */
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  /** Paid requests still waiting on the upstream, at most MAX_CONCURRENT_IMAGES. Each owns its own history record. */
  const trackerRef = useRef(new ImageRequestTracker(MAX_CONCURRENT_IMAGES));
  const balanceSeqRef = useRef(new BalanceSequencer());
  const [inFlightIds, setInFlightIds] = useState<string[]>([]);
  const balanceRef = useRef<number | null>(null);
  balanceRef.current = user?.balance ?? null;
  const [resubmitGuard, setResubmitGuard] = useState(false);
  const urlsRef = useRef<string[]>([]);
  const historyRef = useRef<LiveRecord[]>([]);
  historyRef.current = history;

  const replaceHistory = useCallback((records: HistoryRecord[]) => {
    urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    const live = records.map((record) => ({
      ...record,
      urls: record.images.flatMap((image) => (image.blob ? [URL.createObjectURL(image.blob)] : [])),
      refs: (record.references ?? []).map((ref, index) => ({
        id: `${record.id}:${index}`,
        name: ref.name,
        url: URL.createObjectURL(ref.blob),
        width: ref.width,
        height: ref.height,
      })),
    }));
    urlsRef.current = live.flatMap((record) => [...record.urls, ...record.refs.map((ref) => ref.url)]);
    historyRef.current = live;
    setHistory(live);
    return live;
  }, []);

  /** Rebuild the strip from the latest records, swapping one in. Reads a ref so late async callers don't revive deleted rows. */
  const upsertHistory = useCallback(
    (record: HistoryRecord) =>
      replaceHistory([record, ...historyRef.current.filter((item) => item.id !== record.id).map(stripUrls)]),
    [replaceHistory],
  );

  const hydrate = useCallback(
    async (nextSession: StoredSession) => {
      const freshUser = (await fetchMe(nextSession.accessToken)) ?? nextSession.user;
      const stored = { ...nextSession, user: freshUser };
      writeSession(stored);
      setSession(stored);
      setUser(freshUser);
      const [loadedKeysInitial, availableGroups] = await Promise.all([
        fetchImageKeys(stored.accessToken),
        fetchAvailableGroups(stored.accessToken).catch(() => []),
      ]);
      let loadedKeys = loadedKeysInitial;
      let picked = pickImageKey(loadedKeys, readPreferredKeyId(freshUser.id));
      if (!picked) {
        try {
          const groups = availableGroups.length
            ? availableGroups
            : loadedKeys.map((key) => key.group).filter((group): group is NonNullable<typeof group> => !!group);
          const ensured = await ensureImageKey(stored.accessToken, loadedKeys, groups);
          if (ensured) {
            loadedKeys = ensured;
            picked = pickImageKey(loadedKeys, readPreferredKeyId(freshUser.id));
          }
        } catch {
          // leave loadedKeys as-is; connection view will explain
        }
      }
      setKeys(loadedKeys);
      setSelectedId(picked?.id ?? null);
      if (picked) writePreferredKeyId(freshUser.id, picked.id);
      const rows = settleStalePending(await listHistory(freshUser.id));
      await Promise.all(rows.filter((row) => row.status === "failed" && row.error?.includes("页面关闭")).map((row) => saveHistory(row)));
      replaceHistory(rows);
    },
    [replaceHistory],
  );

  useEffect(() => {
    stripSensitiveQueryInPlace();
    let cancelled = false;
    (async () => {
      try {
        const publicSettings = await fetchPublicSettings();
        if (!cancelled) setSettings(publicSettings);
      } catch (error) {
        if (!cancelled) {
          setSettingsError(error instanceof Error ? error.message : "无法读取站点设置");
        }
      }
      const existing = readSession();
      if (!existing) {
        if (!cancelled) setBooting(false);
        return;
      }
      try {
        const usable =
          existing.expiresAt && existing.expiresAt - Date.now() < 60_000
            ? (await refreshSession(existing)) ?? existing
            : existing;
        if (!cancelled) await hydrate(usable);
      } catch {
        clearSession();
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

  useEffect(() => {
    return () => {
      urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const selectedKey = keys.find((key) => key.id === selectedId) ?? null;

  const estimate = useMemo(() => {
    if (!selectedKey) return null;
    return estimateImageCost({
      model: draft.model,
      resolution: draft.resolution,
      count: draft.count,
    });
  }, [draft.count, draft.model, draft.resolution, selectedKey]);

  const connection: ConnectionView = useMemo(() => {
    if (!user) return { state: "loading" };
    if (selectedKey) return { state: "ready", label: keyLabel(selectedKey) };
    if (keys.length === 0) {
      return {
        state: "blocked",
        summary: "这个账户还没有可用的「媒体台」密钥，自动创建也没有成功。请到密钥页确认账户可以使用「媒体台」分组，或联系站长开通。",
        details: [],
      };
    }
    return {
      state: "blocked",
      summary: "现有密钥都不在「媒体台」分组。本页只走媒体台专用上游，不会再用「ChatGPT 生图」的快速生图钥匙。",
      details: keys.map((key) => `${key.name?.trim() || `密钥 #${key.id}`}：${keyBlockReason(key) ?? "不可用"}`),
    };
  }, [keys, selectedKey, user]);

  /** Saves the fullest form the browser will accept and returns what was actually stored. */
  async function persist(record: HistoryRecord): Promise<HistoryRecord> {
    const attempts = persistAttempts(record);
    for (const attempt of attempts) {
      try {
        await saveHistory(attempt);
        return attempt;
      } catch {
        // try a leaner copy
      }
    }
    return attempts[attempts.length - 1];
  }

  const viewed = selectedHistoryId ? history.find((item) => item.id === selectedHistoryId) ?? null : null;
  const run: RunView = viewed ? recordToRun(viewed) : { status: "idle" };
  const viewing: ViewingRecord | null = viewed
    ? {
        id: viewed.id,
        prompt: viewed.prompt,
        model: isImageModelId(viewed.model) ? viewed.model : DEFAULT_MODEL,
        resolution: viewed.resolution,
        aspect: viewed.aspect,
        quality: viewed.quality,
        estimateUsd: viewed.estimateUsd,
        mode: viewed.mode,
        references: viewed.refs,
        referenceCount: viewed.referenceCount ?? viewed.refs.length,
        referencesDropped: Boolean(viewed.referencesDropped),
        inFlight: inFlightIds.includes(viewed.id),
      }
    : null;

  function reuseRecord(id: string) {
    const record = history.find((item) => item.id === id);
    if (!record) return;
    const model = isImageModelId(record.model) ? record.model : DEFAULT_MODEL;
    const allowed = resolutionsFor(model);
    setDraft({
      prompt: record.prompt,
      model,
      resolution: allowed.includes(record.resolution) ? record.resolution : (allowed[0] ?? DEFAULT_RESOLUTION),
      aspect: record.aspect,
      quality: record.quality,
      count: FIXED_COUNT,
    });
    const files = (record.references ?? []).map(
      (ref) => new File([ref.blob], ref.name, { type: ref.mime || ref.blob.type || "image/webp" }),
    );
    references.load(files, model);
    setSelectedHistoryId(null);
    const missing = (record.referenceCount ?? files.length) - files.length;
    if (missing > 0) toast.message(`这条记录有 ${missing} 张参考图没有保存，需要重新添加。`);
  }

  async function onGenerate() {
    if (!session || !user || !selectedKey || selectedHistoryId || !trackerRef.current.canStart()) return;
    const prompt = draft.prompt.trim();
    if (!prompt) return;
    const files = references.items.map((item) => item.file);
    const rejected = editRejection(draft.model, files.length);
    if (rejected) {
      toast.error(rejected);
      return;
    }
    const size = pixelSize(draft.resolution, draft.aspect);
    const mode = files.length > 0 ? "edit" : "generate";
    const id = crypto.randomUUID();
    if (!trackerRef.current.start(id)) return;
    setInFlightIds(trackerRef.current.ids());
    setResubmitGuard(false);
    // Read once at submit; later requests change the live balance.
    const balanceBefore = balanceRef.current;
    const activeSession = session;
    let kept: HistoryReference[] = [];
    try {
      kept = (await Promise.all(files.map((file) => snapshotReference(file).catch(() => null)))).filter(
        (item): item is HistoryReference => item !== null,
      );
    } catch {
      kept = [];
    }
    const createdAt = new Date().toISOString();
    const pending: HistoryRecord = {
      id,
      userId: user.id,
      createdAt,
      prompt,
      model: draft.model,
      resolution: draft.resolution,
      aspect: draft.aspect,
      size,
      quality: draft.quality,
      count: FIXED_COUNT,
      mode,
      status: "pending",
      estimateUsd: estimate?.totalUsd ?? null,
      costUsd: null,
      balanceAfter: null,
      usage: null,
      images: [],
      references: kept,
      referenceCount: files.length,
      referencesDropped: kept.length < files.length,
    };
    // Keep the stored copy: it carries any references that survived the quota check.
    let base: HistoryRecord;
    try {
      base = await persist(pending);
      upsertHistory(base);
      setSelectedHistoryId(id);
    } catch {
      // Nothing was sent upstream yet, so releasing the slot is safe.
      trackerRef.current.finish(id);
      setInFlightIds(trackerRef.current.ids());
      toast.error("没能在这台浏览器建立记录，请求没有发出。");
      return;
    }

    const attempt = async (apiKey: string) =>
      requestImage({
        apiKey,
        mode,
        model: draft.model,
        prompt,
        size,
        quality: draft.quality,
        count: FIXED_COUNT,
        files,
      });

    try {
      let payload: unknown;
      try {
        payload = await attempt(selectedKey.key);
      } catch (error) {
        if (error instanceof JaxClientError && error.invalidKey) {
          const fallback = keys.find((key) => key.id !== selectedKey.id && !keyBlockReason(key));
          if (!fallback) throw error;
          setSelectedId(fallback.id);
          writePreferredKeyId(user.id, fallback.id);
          payload = await attempt(fallback.key);
        } else {
          throw error;
        }
      }
      const parsed = parseGenerationPayload(payload);
      const images = await Promise.all(parsed.images.map((image) => toHistoryImage(image)));
      if (images.length === 0) throw new Error("上游没有返回图片");
      const refreshed = await readBalance(activeSession);
      const { overlapped } = trackerRef.current.finish(id);
      const done: HistoryRecord = {
        ...base,
        status: "succeeded",
        images,
        usage: parsed.usage,
        costUsd: overlapped ? null : chargeFromBalance(balanceBefore, refreshed?.balance ?? null),
        costNote: overlapped ? OVERLAP_COST_NOTE : undefined,
        balanceAfter: refreshed?.balance ?? null,
        revisedPrompt: parsed.images.find((image) => image.revised)?.revised,
      };
      base = await persist(done);
      if (historyRef.current.some((item) => item.id === id)) upsertHistory(base);
      // The person may have gone back to the draft meanwhile; announce instead of switching the view.
      toast.success("图片生成好了");
    } catch (error) {
      const timeout = error instanceof JaxClientError && error.timeout;
      const uncertain = error instanceof JaxClientError && error.status === 0;
      let message = error instanceof Error ? error.message : "生成失败";
      const refreshed = await readBalance(activeSession);
      const { overlapped } = trackerRef.current.finish(id);
      const charged = refreshed ? chargeFromBalance(balanceBefore, refreshed.balance) : null;
      if (charged && charged > 0 && !message.includes("使用记录")) {
        message += overlapped
          ? " 这段时间还有其他请求，无法判断这一张是否扣费，请到「使用记录」核对，不要立刻重复提交。"
          : ` 账户余额已减少约 ${charged.toFixed(4)} USD，请到「使用记录」核对，不要立刻重复提交。`;
      }
      const failed: HistoryRecord = {
        ...base,
        status: timeout ? "timeout" : "failed",
        error: message,
        costUsd: overlapped ? null : refreshed ? charged : pending.costUsd,
        costNote: overlapped ? OVERLAP_COST_NOTE : undefined,
        balanceAfter: refreshed?.balance ?? null,
        uncertain: Boolean(uncertain || timeout),
      };
      const stored = await persist(failed);
      if (historyRef.current.some((item) => item.id === id)) upsertHistory(stored);
      if (uncertain || timeout) setResubmitGuard(true);
      toast.error("这次生成没有完成，详情见记录。");
    } finally {
      // finish() is idempotent; this also covers a throw before either branch reached it.
      trackerRef.current.finish(id);
      setInFlightIds(trackerRef.current.ids());
    }
  }

  /** Reads the balance and applies it only if no newer read has landed first. */
  async function readBalance(activeSession: StoredSession): Promise<PublicUser | null> {
    const ticket = balanceSeqRef.current.ticket();
    const refreshed = await fetchMe(activeSession.accessToken).catch(() => null);
    if (refreshed && balanceSeqRef.current.accept(ticket)) {
      setUser(refreshed);
      writeSession({ ...activeSession, user: refreshed });
    }
    return refreshed;
  }

  if (booting) {
    return <main className="grid min-h-screen place-items-center text-sm text-muted-foreground">正在恢复登录状态…</main>;
  }
  if (!session || !user) {
    return (
      <LoginScreen
        settings={settings}
        settingsError={settingsError}
        onLoggedIn={(next) => {
          setBooting(true);
          void hydrate(next).finally(() => setBooting(false));
        }}
      />
    );
  }

  const cards: HistoryCard[] = history.map((item) => ({
    id: item.id,
    createdAt: item.createdAt,
    prompt: item.prompt,
    model: item.model,
    size: item.size,
    status: item.status,
    thumbUrl: item.urls[0] || item.images.find((image) => image.remoteUrl)?.remoteUrl,
    referenceCount: item.referenceCount ?? item.refs.length,
  }));

  return (
    <>
      <Studio
        email={user.email}
        balance={user.balance}
        frozenBalance={user.frozen_balance}
        connection={connection}
        keys={keys.filter((key) => !keyBlockReason(key)).map((key) => ({ id: key.id, label: keyLabel(key) }))}
        selectedKeyId={selectedId}
        onSelectKey={(id) => {
          setSelectedId(id);
          writePreferredKeyId(user.id, id);
        }}
        onLogout={() => {
          if (session.source === "host" || isEmbedded()) return;
          void logoutSession(session);
          clearSession();
          setSession(null);
          setUser(null);
        }}
        embedded={isEmbedded()}
        showLogout={session.source !== "host" && !isEmbedded()}
        history={cards}
        selectedHistoryId={selectedHistoryId}
        onSelectHistory={(id) => {
          if (history.some((item) => item.id === id)) setSelectedHistoryId(id);
        }}
        onDeleteHistory={(id) => {
          if (inFlightIds.includes(id)) return;
          void deleteHistory(id);
          replaceHistory(historyRef.current.filter((item) => item.id !== id).map(stripUrls));
          if (selectedHistoryId === id) setSelectedHistoryId(null);
        }}
        onCompose={() => setSelectedHistoryId(null)}
        onClearDraft={() => {
          setDraft((current) => ({ ...current, prompt: "" }));
          references.clear();
        }}
        viewing={viewing}
        onReuse={reuseRecord}
        inFlightIds={inFlightIds}
        maxInFlight={MAX_CONCURRENT_IMAGES}
        resubmitGuard={resubmitGuard}
        draft={draft}
        onDraft={(patch) => setDraft((current) => ({ ...current, ...patch, count: FIXED_COUNT }))}
        references={references.items.map((item) => ({ id: item.id, name: item.name, url: item.url }))}
        referenceCap={references.cap}
        onAddReferences={references.addFiles}
        onRemoveReference={references.remove}
        onMoveReference={references.move}
        estimate={estimate}
        run={run}
        onGenerate={() => void onGenerate()}
        videoDesk={
          <VideoDesk
            accessToken={session.accessToken}
            userId={String(user.id)}
            accountBalance={user.balance}
            enabled={Boolean(selectedKey && isMediaKey(selectedKey))}
            blockedReason={connection.state === "blocked" ? connection.summary : undefined}
            onBalance={(balance) => {
              // A video charge moves the balance under any running image request.
              trackerRef.current.markBalanceMoved();
              balanceSeqRef.current.accept(balanceSeqRef.current.ticket());
              setUser((current) => (current ? { ...current, balance } : current));
            }}
          />
        }
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

function stripUrls(record: LiveRecord | HistoryRecord): HistoryRecord {
  const { urls, refs, ...rest } = record as LiveRecord;
  void urls;
  void refs;
  return rest;
}

async function toHistoryImage(image: { b64?: string; url?: string }): Promise<HistoryRecord["images"][number]> {
  if (image.b64) return { blob: b64ToBlob(image.b64), mime: "image/png" };
  if (image.url) {
    try {
      const response = await fetch(image.url);
      if (response.ok) {
        const blob = await response.blob();
        return { blob, mime: blob.type || "image/png", remoteUrl: image.url };
      }
    } catch {
      // The browser can still display a remote URL even when it cannot read the bytes.
    }
    return { mime: "image/png", remoteUrl: image.url };
  }
  return { mime: "image/png" };
}

function recordToRun(record: LiveRecord): RunView {
  if (record.status === "pending") {
    return { status: "pending", startedAt: Date.parse(record.createdAt) || Date.now(), mode: record.mode };
  }
  if (record.status === "succeeded") {
    return {
      status: "success",
      images: [
        ...record.urls.map((url, index) => ({ url, name: `jaxapi-${record.id}-${index + 1}.png` })),
        ...record.images.flatMap((image, index) =>
          image.remoteUrl && !image.blob ? [{ url: image.remoteUrl, name: `jaxapi-${record.id}-remote-${index + 1}.png` }] : [],
        ),
      ],
      revisedPrompt: record.revisedPrompt,
      costUsd: record.costUsd,
      costNote: record.costNote,
      balanceAfter: record.balanceAfter,
      usage: record.usage,
      estimateUsd: record.estimateUsd,
      size: record.size,
      model: record.model,
    };
  }
  return {
    status: "error",
    message: record.error || "这次生成没有完成。",
    timeout: record.status === "timeout",
    uncertain: Boolean(record.uncertain),
  };
}
