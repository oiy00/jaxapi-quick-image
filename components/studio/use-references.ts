"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  capChangeWarning,
  intakeNotice,
  planReferenceIntake,
  prepareReferenceFile,
  referenceCap,
} from "@/lib/reference-images";

export type ReferenceItem = {
  id: string;
  file: File;
  url: string;
  name: string;
};

export function useReferenceTray(model: string, capOverride?: number) {
  const cap = referenceCap(model, capOverride);
  const [items, setItems] = useState<ReferenceItem[]>([]);
  const [queue, setQueue] = useState<File[]>([]);
  const capRef = useRef(cap);
  const itemsRef = useRef(items);
  const skipDismiss = useRef(false);
  itemsRef.current = items;

  useEffect(() => {
    if (capRef.current === cap) return;
    capRef.current = cap;
    const warning = capChangeWarning(itemsRef.current.length, cap);
    if (warning) toast.message(warning);
  }, [cap]);

  useEffect(() => {
    return () => {
      itemsRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, []);

  function addFiles(list: File[]) {
    const prepared: File[] = [];
    const errors = new Set<string>();
    list.forEach((file, index) => {
      const plan = prepareReferenceFile({ type: file.type, size: file.size, name: file.name }, index);
      if (!plan.ok) {
        errors.add(plan.message);
        return;
      }
      prepared.push(new File([file], plan.name, { type: plan.type, lastModified: file.lastModified }));
    });
    errors.forEach((message) => toast.error(message));
    const held = itemsRef.current.length;
    if (held > cap) {
      const warning = capChangeWarning(held, cap);
      if (warning) toast.message(warning);
      return;
    }
    const intake = planReferenceIntake(held, prepared.length, cap);
    const notice = intakeNotice(intake, cap);
    if (notice) toast.message(notice);
    const accepted = prepared.slice(0, intake.accept);
    if (accepted.length === 0) return;
    setQueue((current) => (intake.replace ? accepted : [...current, ...accepted]));
  }

  function accept(file: File) {
    if (cap <= 1 && itemsRef.current.length > 1) {
      const warning = capChangeWarning(itemsRef.current.length, cap);
      if (warning) toast.message(warning);
      setQueue((current) => current.slice(1));
      return;
    }
    skipDismiss.current = true;
    queueMicrotask(() => {
      skipDismiss.current = false;
    });
    const replacing = cap <= 1;
    setItems((current) => {
      const next = { id: crypto.randomUUID(), file, url: URL.createObjectURL(file), name: file.name };
      if (replacing) {
        current.forEach((item) => URL.revokeObjectURL(item.url));
        return [next];
      }
      if (current.length >= cap) {
        URL.revokeObjectURL(next.url);
        return current;
      }
      return [...current, next];
    });
    setQueue((current) => current.slice(1));
  }

  function dismissCrop() {
    if (skipDismiss.current) return;
    setQueue((current) => current.slice(1));
  }

  function remove(id: string) {
    setItems((current) => {
      const target = current.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return current.filter((item) => item.id !== id);
    });
  }

  function move(id: string, direction: -1 | 1) {
    setItems((current) => {
      const index = current.findIndex((item) => item.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const copy = current.slice();
      const [item] = copy.splice(index, 1);
      copy.splice(nextIndex, 0, item);
      return copy;
    });
  }

  function clear() {
    setItems((current) => {
      current.forEach((item) => URL.revokeObjectURL(item.url));
      return [];
    });
    setQueue([]);
  }

  return {
    cap,
    items,
    cropFile: queue[0] ?? null,
    addFiles,
    accept,
    dismissCrop,
    remove,
    move,
    clear,
  };
}
