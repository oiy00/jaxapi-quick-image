import { VideoLedger, type LedgerResult } from "./video-ledger.ts";

const globalStore = globalThis as typeof globalThis & { __jaxMockVideoLedger?: VideoLedger };

export function mockVideoLedger(): VideoLedger {
  if (!globalStore.__jaxMockVideoLedger) globalStore.__jaxMockVideoLedger = new VideoLedger();
  return globalStore.__jaxMockVideoLedger;
}

export function resetMockVideoLedger(opening: Record<string, number> = {}): VideoLedger {
  const ledger = new VideoLedger(opening);
  globalStore.__jaxMockVideoLedger = ledger;
  return ledger;
}

export function submitMockVideo(input: {
  userId: string;
  groupName: string;
  idempotencyKey: string;
  model: string;
  duration: number;
  prompt: string;
  clientMultiplier?: number;
  openingBalance?: number;
}): LedgerResult {
  const ledger = mockVideoLedger();
  if (typeof input.openingBalance === "number") ledger.ensureOpening(input.userId, input.openingBalance);
  return ledger.submit(input);
}

export function readMockVideo(taskId: string, userId: string, now = Date.now()): LedgerResult {
  return mockVideoLedger().read(taskId, userId, now);
}
