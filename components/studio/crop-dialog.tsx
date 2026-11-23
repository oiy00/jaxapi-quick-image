"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";

type CropDialogProps = {
  file: File | null;
  aspect: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUseOriginal: (file: File) => void;
  onUseCrop: (file: File) => void;
};

export function CropDialog({ file, aspect, open, onOpenChange, onUseOriginal, onUseCrop }: CropDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [ready, setReady] = useState(false);
  const frame = frameSize(aspect);

  useEffect(() => {
    if (!file || !open) return;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      imageRef.current = image;
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      setReady(true);
    };
    image.src = url;
    return () => {
      URL.revokeObjectURL(url);
      imageRef.current = null;
      setReady(false);
    };
  }, [file, open]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !ready) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    paint(context, image, frame.width, frame.height, zoom, offset.x, offset.y);
  }, [frame.height, frame.width, offset.x, offset.y, ready, zoom]);

  async function confirmCrop() {
    const image = imageRef.current;
    if (!image || !file) return;
    const output = document.createElement("canvas");
    const longEdge = Math.min(2048, Math.max(image.naturalWidth, image.naturalHeight));
    if (aspect >= 1) {
      output.width = longEdge;
      output.height = Math.max(16, Math.round(longEdge / aspect));
    } else {
      output.height = longEdge;
      output.width = Math.max(16, Math.round(longEdge * aspect));
    }
    const context = output.getContext("2d");
    if (!context) return;
    const scale = output.width / frame.width;
    paint(context, image, output.width, output.height, zoom, offset.x * scale, offset.y * scale);
    const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, "image/png"));
    if (!blob) return;
    const cropped = new File([blob], file.name.replace(/\.\w+$/, "") + "-crop.png", { type: "image/png" });
    onUseCrop(cropped);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" showCloseButton>
        <DialogHeader>
          <DialogTitle>裁剪参考图</DialogTitle>
          <DialogDescription>按当前画面比例取景。也可以直接使用原图。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          <canvas
            ref={canvasRef}
            width={frame.width}
            height={frame.height}
            className="max-w-full cursor-grab rounded-lg bg-black/40 ring-1 ring-white/10 active:cursor-grabbing"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag) return;
              setOffset({
                x: drag.ox + event.clientX - drag.x,
                y: drag.oy + event.clientY - drag.y,
              });
            }}
            onPointerUp={() => {
              dragRef.current = null;
            }}
          />
          <div className="flex w-full items-center gap-3">
            <span className="text-xs text-muted-foreground">缩放</span>
            <Slider
              min={1}
              max={3}
              step={0.01}
              value={[zoom]}
              onValueChange={(value) => {
                const next = Array.isArray(value) ? value[0] : value;
                setZoom(next ?? 1);
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => file && onUseOriginal(file)}
          >
            使用原图
          </Button>
          <Button type="button" onClick={() => void confirmCrop()} disabled={!ready}>
            使用裁剪
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function frameSize(aspect: number) {
  const maxWidth = 460;
  const maxHeight = 360;
  let width = maxWidth;
  let height = width / aspect;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspect;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

function paint(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
  zoom: number,
  offsetX: number,
  offsetY: number,
) {
  const cover = Math.max(width / image.naturalWidth, height / image.naturalHeight) * zoom;
  const drawWidth = image.naturalWidth * cover;
  const drawHeight = image.naturalHeight * cover;
  context.clearRect(0, 0, width, height);
  context.drawImage(image, (width - drawWidth) / 2 + offsetX, (height - drawHeight) / 2 + offsetY, drawWidth, drawHeight);
}
