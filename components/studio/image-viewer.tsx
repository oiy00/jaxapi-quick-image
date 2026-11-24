"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from "lucide-react";
import type { HistoryCard, RunView } from "./view";
import { formatPixels } from "./stage";

export type ViewerImage = {
  id: string;
  url: string;
  name: string;
  model: string;
  size: string;
};

const MIN_ZOOM = 1;
const ZOOM_WHEEL = 0.002;

/** Succeeded history images, newest first, plus any current result not yet in the strip. */
export function collectViewerImages(history: HistoryCard[], run: RunView): ViewerImage[] {
  const names = new Map<string, string>();
  if (run.status === "success") {
    for (const image of run.images) names.set(image.url, image.name);
  }
  const items: ViewerImage[] = [];
  for (const item of history) {
    if (item.status !== "succeeded" || !item.thumbUrl) continue;
    items.push({
      id: item.id,
      url: item.thumbUrl,
      name: names.get(item.thumbUrl) ?? `jaxapi-${item.id}.png`,
      model: item.model,
      size: item.size,
    });
  }
  if (run.status === "success") {
    for (const image of run.images) {
      if (items.some((item) => item.url === image.url)) continue;
      items.unshift({
        id: `run:${image.name}`,
        url: image.url,
        name: image.name,
        model: run.model,
        size: run.size,
      });
    }
  }
  return items;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

type Size = { w: number; h: number };
type Point = { x: number; y: number };

export function ImageViewer({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: ViewerImage[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const safeIndex = images.length === 0 ? 0 : clamp(index, 0, images.length - 1);
  const image = images[safeIndex];
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const scaleRef = useRef(1);
  const panRef = useRef<Point>({ x: 0, y: 0 });
  const naturalRef = useRef<Size | null>(null);
  const frameSizeRef = useRef<Size>({ w: 0, h: 0 });
  const maxZoomRef = useRef(4);
  const pointers = useRef(new Map<number, Point>());
  const emptyPointer = useRef(false);
  const pinchRef = useRef<{ dist: number; scale: number; cx: number; cy: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const navRef = useRef({ onClose, onIndex, index: safeIndex, count: images.length });
  navRef.current = { onClose, onIndex, index: safeIndex, count: images.length };

  const [natural, setNatural] = useState<Size | null>(null);
  const [frameSize, setFrameSize] = useState<Size>({ w: 0, h: 0 });
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [grabbing, setGrabbing] = useState(false);
  const [trackedUrl, setTrackedUrl] = useState(image?.url);

  if (image && trackedUrl !== image.url) {
    scaleRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    naturalRef.current = null;
    setTrackedUrl(image.url);
    setNatural(null);
    setScale(1);
    setPan({ x: 0, y: 0 });
  }

  const ready = Boolean(natural && frameSize.w > 0 && frameSize.h > 0);
  const fit = ready && natural ? Math.min(frameSize.w / natural.w, frameSize.h / natural.h) : 1;
  maxZoomRef.current = Math.max(4, fit > 0 ? 1 / fit : 4);
  const dispW = ready && natural ? natural.w * fit * scale : 0;
  const dispH = ready && natural ? natural.h * fit * scale : 0;

  function commit(nextScale: number, nextPan: Point) {
    const zoom = clamp(nextScale, MIN_ZOOM, maxZoomRef.current);
    const panNext = clampPan(zoom === MIN_ZOOM ? { x: 0, y: 0 } : nextPan, zoom);
    scaleRef.current = zoom;
    panRef.current = panNext;
    setScale(zoom);
    setPan(panNext);
  }

  function clampPan(next: Point, zoom: number): Point {
    const nat = naturalRef.current;
    const box = frameSizeRef.current;
    if (!nat || box.w <= 0 || box.h <= 0) return next;
    const fitted = Math.min(box.w / nat.w, box.h / nat.h);
    const maxX = Math.max(0, (nat.w * fitted * zoom - box.w) / 2);
    const maxY = Math.max(0, (nat.h * fitted * zoom - box.h) / 2);
    return { x: clamp(next.x, -maxX, maxX), y: clamp(next.y, -maxY, maxY) };
  }

  function zoomAround(clientX: number, clientY: number, nextScale: number) {
    const frame = frameRef.current?.getBoundingClientRect();
    if (!frame) return;
    const prev = scaleRef.current || 1;
    const zoom = clamp(nextScale, MIN_ZOOM, maxZoomRef.current);
    const cx = clientX - (frame.left + frame.width / 2);
    const cy = clientY - (frame.top + frame.height / 2);
    const ratio = zoom / prev;
    const current = panRef.current;
    commit(zoom, {
      x: cx - (cx - current.x) * ratio,
      y: cy - (cy - current.y) * ratio,
    });
  }

  const zoomAroundRef = useRef(zoomAround);
  zoomAroundRef.current = zoomAround;

  useEffect(() => {
    const root = rootRef.current;
    const frame = frameRef.current;
    if (!root || !frame) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const measure = () => {
      const style = getComputedStyle(frame);
      const padX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const padY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      const size = {
        w: Math.max(0, frame.clientWidth - padX),
        h: Math.max(0, frame.clientHeight - padY),
      };
      frameSizeRef.current = size;
      setFrameSize(size);
      setPan((current) => {
        const next = clampPan(current, scaleRef.current);
        panRef.current = next;
        return next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const raw = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const factor = Math.exp(-raw * ZOOM_WHEEL);
      zoomAroundRef.current(event.clientX, event.clientY, scaleRef.current * factor);
    };
    root.addEventListener("wheel", onWheel, { passive: false });

    const focusable = () =>
      [...root.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")].filter(
        (node) => !node.hasAttribute("disabled"),
      );

    const onKey = (event: KeyboardEvent) => {
      const nav = navRef.current;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        nav.onClose();
        return;
      }
      if (event.key === "ArrowLeft" && nav.count > 1) {
        event.preventDefault();
        nav.onIndex(Math.max(0, nav.index - 1));
        return;
      }
      if (event.key === "ArrowRight" && nav.count > 1) {
        event.preventDefault();
        nav.onIndex(Math.min(nav.count - 1, nav.index + 1));
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && items.includes(active);
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);

    return () => {
      observer.disconnect();
      root.removeEventListener("wheel", onWheel);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, []);

  if (!image) return null;

  const several = images.length > 1;
  const chrome =
    "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/10 px-3 text-sm whitespace-nowrap text-white transition-colors hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("[data-viewer-control]")) {
      emptyPointer.current = false;
      return;
    }
    emptyPointer.current = event.target === event.currentTarget;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length >= 2) {
      pinchRef.current = {
        dist: Math.max(12, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
        scale: scaleRef.current,
        cx: (pts[0].x + pts[1].x) / 2,
        cy: (pts[0].y + pts[1].y) / 2,
      };
      dragRef.current = null;
      return;
    }
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      panX: panRef.current.x,
      panY: panRef.current.y,
      moved: false,
    };
    if (scaleRef.current > 1) setGrabbing(true);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pts = [...pointers.current.values()];
    const pinch = pinchRef.current;
    if (pts.length >= 2 && pinch) {
      const dist = Math.max(12, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      zoomAround(midX, midY, pinch.scale * (dist / pinch.dist));
      suppressClick.current = true;
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 6) drag.moved = true;
    if (!drag.moved || scaleRef.current <= 1) return;
    suppressClick.current = true;
    commit(scaleRef.current, { x: drag.panX + dx, y: drag.panY + dy });
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinchRef.current = null;
    if (pointers.current.size === 0) {
      if (dragRef.current?.moved) suppressClick.current = true;
      dragRef.current = null;
      setGrabbing(false);
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
    }
  }

  function onFrameClick() {
    const closeFromEmpty = emptyPointer.current;
    emptyPointer.current = false;
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (closeFromEmpty) onClose();
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="viewer-caption"
      tabIndex={-1}
      className="fixed inset-0 z-[80] flex flex-col bg-[#0c0e12] text-white outline-none"
    >
      <div className="flex items-center gap-2 px-3 pt-3 sm:justify-end" data-viewer-control>
        <div className="ml-auto flex items-center gap-2 sm:ml-0">
          <a className={chrome} href={image.url} download={image.name}>
            <Download className="size-4" />
            下载
          </a>
          <a className={chrome} href={image.url} target="_blank" rel="noreferrer">
            <ExternalLink className="size-4" />
            在新窗口打开原图
          </a>
        </div>
        <button
          type="button"
          className={`${chrome} order-first size-9 px-0 sm:order-none`}
          aria-label="关闭"
          title="关闭"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </div>

      <div
        ref={frameRef}
        className="relative grid min-h-0 flex-1 place-items-center overflow-hidden p-4 sm:p-8"
        style={{ touchAction: "none", cursor: grabbing ? "grabbing" : scale > 1 ? "grab" : "zoom-in" }}
        onClick={onFrameClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {several ? (
          <button
            type="button"
            data-viewer-control
            className="absolute top-1/2 left-2 z-10 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white ring-1 ring-white/20 hover:bg-black/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white disabled:opacity-30"
            aria-label="上一张"
            title="上一张"
            disabled={safeIndex <= 0}
            onClick={() => onIndex(safeIndex - 1)}
          >
            <ChevronLeft className="size-5" />
          </button>
        ) : null}
        <img
          ref={imgRef}
          key={image.url}
          src={image.url}
          alt={`${image.model}，${formatPixels(image.size)}`}
          draggable={false}
          onLoad={(event) => {
            const next = { w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight };
            if (!next.w || !next.h) return;
            naturalRef.current = next;
            setNatural(next);
          }}
          onDragStart={(event) => event.preventDefault()}
          className={ready ? "max-w-none select-none" : "max-h-full max-w-full select-none object-contain"}
          style={
            ready
              ? {
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: dispW,
                  height: dispH,
                  transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
                }
              : undefined
          }
        />
        {several ? (
          <button
            type="button"
            data-viewer-control
            className="absolute top-1/2 right-2 z-10 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white ring-1 ring-white/20 hover:bg-black/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white disabled:opacity-30"
            aria-label="下一张"
            title="下一张"
            disabled={safeIndex >= images.length - 1}
            onClick={() => onIndex(safeIndex + 1)}
          >
            <ChevronRight className="size-5" />
          </button>
        ) : null}
      </div>

      <div className="px-4 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-center" data-viewer-control>
        <p id="viewer-caption" className="text-sm text-white/90" aria-live="polite">
          <span className="font-medium">{image.model}</span>
          <span className="px-1.5 text-white/40">·</span>
          <span className="tabular-nums">{formatPixels(image.size)}</span>
        </p>
        <p className="mt-1 text-xs text-white/55 sm:hidden">双指开合缩放，轻点空白处关闭</p>
        <p className="mt-1 hidden text-xs text-white/55 sm:block">Esc 或点击空白处关闭，可滚轮缩放</p>
      </div>
    </div>
  );
}
