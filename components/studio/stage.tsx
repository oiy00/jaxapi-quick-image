"use client";

import { forwardRef, type CSSProperties, type ReactNode } from "react";

/** Parses "1024x576" or "16:9" into a width / height ratio. */
export function ratioOf(value: string | undefined, fallback = 1): number {
  if (!value) return fallback;
  const [w, h] = value.split(/[x×:]/).map(Number);
  if (!w || !h) return fallback;
  return w / h;
}

export function formatPixels(size: string): string {
  return size.replace("x", " × ");
}

type StageProps = {
  ratio: number;
  tone?: "idle" | "busy" | "error" | "filled";
  /** Small persistent tag in the top-left corner, e.g. the video demo marker. */
  tag?: ReactNode;
  children: ReactNode;
};

/**
 * The canvas. A neutral grey surface with a frame drawn at the exact ratio of
 * the next request, so the empty state already shows what will come back.
 */
export const Stage = forwardRef<HTMLDivElement, StageProps>(function Stage({ ratio, tone = "idle", tag, children }, ref) {
  const frameTone =
    tone === "error"
      ? "border border-destructive/50 bg-destructive/10"
      : tone === "filled"
        ? "bg-black/20"
        : tone === "busy"
          ? "bg-background/30"
          : "bg-background/15";
  return (
    <div ref={ref} className="relative flex h-[58vh] min-h-72 flex-col bg-stage lg:h-auto lg:min-h-0 lg:flex-1">
      {tag ? <div className="px-4 pt-3">{tag}</div> : null}
      <div className={`stage-fit min-h-0 flex-1 p-6 md:p-10 ${tag ? "pt-3 md:pt-4" : ""}`}>
        <div className="grid h-full w-full place-items-center">
          <div
            className={`stage-frame relative overflow-hidden rounded-sm ${frameTone}`}
            style={{ "--ratio": ratio } as CSSProperties}
          >
            {tone === "filled" ? null : <CropMarks />}
            {children}
          </div>
        </div>
      </div>
    </div>
  );
});

function CropMarks() {
  const mark = "pointer-events-none absolute size-4 border-foreground/45";
  return (
    <>
      <span aria-hidden className={`${mark} top-0 left-0 border-t border-l`} />
      <span aria-hidden className={`${mark} top-0 right-0 border-t border-r`} />
      <span aria-hidden className={`${mark} bottom-0 left-0 border-b border-l`} />
      <span aria-hidden className={`${mark} right-0 bottom-0 border-r border-b`} />
    </>
  );
}

/** Centered copy inside the frame. */
export function StageCopy({ big, children }: { big?: ReactNode; children?: ReactNode }) {
  return (
    <div className="absolute inset-0 grid place-items-center p-4 text-center">
      <div className="max-w-sm">
        {big ? (
          <p className="font-[family-name:var(--font-display)] text-3xl font-light tracking-tight text-foreground/85 tabular-nums md:text-5xl">
            {big}
          </p>
        ) : null}
        {children ? <div className="mt-3 text-sm leading-6 text-muted-foreground">{children}</div> : null}
      </div>
    </div>
  );
}

export function StageSweep() {
  return (
    <span
      aria-hidden
      className="stage-sweep pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-primary/10 to-transparent"
    />
  );
}

/** Segmented control used for the desk switch, resolution and duration. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  size = "md",
}: {
  value: T;
  options: { value: T; label: ReactNode; hint?: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="group" aria-label={label} className="flex gap-0.5 rounded-lg bg-background/60 p-0.5 ring-1 ring-border">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`flex flex-1 flex-col items-center justify-center rounded-md px-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
              size === "sm" ? "h-7 text-[0.8rem]" : option.hint ? "h-12" : "h-9 text-sm"
            } ${active ? "bg-primary text-primary-foreground" : "text-foreground/75 hover:bg-accent hover:text-foreground"}`}
          >
            <span className="font-medium">{option.label}</span>
            {option.hint ? (
              <span className={`text-[11px] tabular-nums ${active ? "text-primary-foreground/75" : "text-muted-foreground"}`}>
                {option.hint}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function SettingRow({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      {children}
      {note ? <p className="text-xs leading-5 text-muted-foreground">{note}</p> : null}
    </div>
  );
}
