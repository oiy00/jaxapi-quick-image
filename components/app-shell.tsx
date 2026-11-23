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
import { clearSession, isEmbedded, readPreferredKeyId, readSession, stripSensitiveQueryInPlace, writePreferredKeyId, writeSession } from "@/lib/session";
import { aspectValue } from "@/lib/models";
import type { ApiKeyRecord, HistoryRecord, PublicSettings, PublicUser, StoredSession } from "@/lib/types";
import { LoginScreen } from "@/components/auth/login-screen";
import { CropDialog } from "@/components/studio/crop-dialog";
import { Studio } from "@/components/studio/studio";
import { VideoDesk } from "@/components/studio/video-desk";
import type { ConnectionView, Draft, HistoryCard, RunView } from "@/components/studio/view";

type LiveRecord = HistoryRecord & { urls: string[] };

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
  const [reference, setReference] = useState<{ file: File; url: string } | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [history, setHistory] = useState<LiveRecord[]>([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [run, setRun] = useState<RunView>({ status: "idle" });
  const urlsRef = useRef<string[]>([]);

  const replaceHistory = useCallback((records: HistoryRecord[]) => {
    urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    const live = records.map((record) => ({
      ...record,
      urls: record.images.flatMap((image) => (image.blob ? [URL.createObjectURL(image.blob)] : [])),
    }));
    urlsRef.current = live.flatMap((record) => record.urls);
    setHistory(live);
    return live;
  }, []);

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

  function acceptReference(file: File) {
    if (!file.type.startsWith("image/")) {
      toast.error("请上传 PNG、JPEG 或 WebP 图片。");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      toast.error("参考图超过 12MB。");
      return;
    }
    setReference((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return { file, url: URL.createObjectURL(file) };
    });
    setCropFile(null);
  }

  async function persist(record: HistoryRecord) {
    try {
      await saveHistory(record);
    } catch {
      await saveHistory({
        ...record,
        images: [],
        error: [record.error, "图片太大，未能保存在这台浏览器。"].filter(Boolean).join(" "),
      });
    }
  }

  function showRecord(record: HistoryRecord) {
    setSelectedHistoryId(record.id);
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
    if (record.status === "pending") {
      setRun({ status: "pending", startedAt: Date.parse(record.createdAt), mode: record.mode });
      return;
    }
    if (record.status === "succeeded") {
      const live = history.find((item) => item.id === record.id);
      const images = [
        ...(live?.urls.map((url, index) => ({ url, name: `jaxapi-${record.id}-${index + 1}.png` })) ?? []),
        ...record.images
          .filter((image) => image.remoteUrl)
          .map((image, index) => ({ url: image.remoteUrl as string, name: `jaxapi-${record.id}-remote-${index + 1}.png` })),
      ];
      setRun({
        status: "success",
        images,
        costUsd: record.costUsd,
        balanceAfter: record.balanceAfter,
        usage: record.usage,
        estimateUsd: record.estimateUsd,
        size: record.size,
        model: record.model,
      });
      return;
    }
    setRun({ status: "error", message: record.error || "这次生成没有完成。", timeout: record.status === "timeout" });
  }

  async function onGenerate() {
    if (!session || !user || !selectedKey || run.status === "pending") return;
    const prompt = draft.prompt.trim();
    if (!prompt) return;
    const size = pixelSize(draft.resolution, draft.aspect);
    const mode = reference ? "edit" : "generate";
    const id = crypto.randomUUID();
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
    };
    await persist(pending);
    replaceHistory([pending, ...history.filter((item) => item.id !== id).map(stripUrls)]);
    setSelectedHistoryId(id);
    setRun({ status: "pending", startedAt: Date.now(), mode });

    const attempt = async (apiKey: string) =>
      requestImage({
        apiKey,
        mode,
        model: draft.model,
        prompt,
        size,
        quality: draft.quality,
        count: FIXED_COUNT,
        file: reference?.file,
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
      const refreshed = await fetchMe(session.accessToken).catch(() => null);
      if (refreshed) {
        setUser(refreshed);
        writeSession({ ...session, user: refreshed });
      }
      const done: HistoryRecord = {
        ...pending,
        status: "succeeded",
        images,
        usage: parsed.usage,
        costUsd: chargeFromBalance(user.balance, refreshed?.balance ?? null),
        balanceAfter: refreshed?.balance ?? null,
      };
      await persist(done);
      const live = replaceHistory([done, ...history.filter((item) => item.id !== id).map(stripUrls)]);
      const current = live.find((item) => item.id === id);
      setRun({
        status: "success",
        images: [
          ...(current?.urls.map((url, index) => ({ url, name: `jaxapi-${id}-${index + 1}.png` })) ?? []),
          ...done.images.flatMap((image, index) =>
            image.remoteUrl && !image.blob ? [{ url: image.remoteUrl, name: `jaxapi-${id}-remote-${index + 1}.png` }] : [],
          ),
        ],
        revisedPrompt: parsed.images.find((image) => image.revised)?.revised,
        costUsd: done.costUsd,
        balanceAfter: done.balanceAfter,
        usage: done.usage,
        estimateUsd: done.estimateUsd,
        size,
        model: draft.model,
      });
    } catch (error) {
      const timeout = error instanceof JaxClientError && error.timeout;
      let message = error instanceof Error ? error.message : "生成失败";
      const refreshed = await fetchMe(session.accessToken).catch(() => null);
      if (refreshed) {
        const charged = chargeFromBalance(user.balance, refreshed.balance);
        setUser(refreshed);
        writeSession({ ...session, user: refreshed });
        if (charged && charged > 0 && !message.includes("使用记录")) {
          message += ` 账户余额已减少约 ${charged.toFixed(4)} USD，请到「使用记录」核对，不要立刻重复提交。`;
        }
      }
      const failed: HistoryRecord = {
        ...pending,
        status: timeout ? "timeout" : "failed",
        error: message,
        costUsd: refreshed ? chargeFromBalance(user.balance, refreshed.balance) : pending.costUsd,
        balanceAfter: refreshed?.balance ?? null,
      };
      await persist(failed);
      replaceHistory([failed, ...history.filter((item) => item.id !== id).map(stripUrls)]);
      setRun({ status: "error", message, timeout });
    }
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
          const record = history.find((item) => item.id === id);
          if (record) showRecord(stripUrls(record));
        }}
        onDeleteHistory={(id) => {
          void deleteHistory(id);
          const next = history.filter((item) => item.id !== id);
          replaceHistory(next.map(stripUrls));
          if (selectedHistoryId === id) {
            setSelectedHistoryId(null);
            setRun({ status: "idle" });
          }
        }}
        onCreate={() => {
          setDraft(EMPTY_DRAFT);
          setReference((current) => {
            if (current) URL.revokeObjectURL(current.url);
            return null;
          });
          setSelectedHistoryId(null);
          setRun({ status: "idle" });
        }}
        draft={draft}
        onDraft={(patch) => setDraft((current) => ({ ...current, ...patch, count: FIXED_COUNT }))}
        referenceName={reference?.file.name ?? null}
        referenceUrl={reference?.url ?? null}
        onPickReference={(file) => setCropFile(file)}
        onClearReference={() =>
          setReference((current) => {
            if (current) URL.revokeObjectURL(current.url);
            return null;
          })
        }
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
            onBalance={(balance) => setUser((current) => (current ? { ...current, balance } : current))}
          />
        }
      />
      <CropDialog
        open={cropFile !== null}
        file={cropFile}
        aspect={aspectValue(draft.aspect)}
        onOpenChange={(open) => {
          if (!open) setCropFile(null);
        }}
        onUseOriginal={acceptReference}
        onUseCrop={acceptReference}
      />
    </>
  );
}

function stripUrls(record: LiveRecord | HistoryRecord): HistoryRecord {
  const { urls, ...rest } = record as LiveRecord;
  void urls;
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
