import type { HistoryRecord } from "./types";

const DB_NAME = "jaxapi-quick-image";
const STORE = "runs";
const MAX_RUNS = 40;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("byUser", "userId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function listHistory(userId: number): Promise<HistoryRecord[]> {
  const db = await openDb();
  try {
    const rows = await new Promise<HistoryRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const index = tx.objectStore(STORE).index("byUser");
      const request = index.getAll(userId);
      request.onsuccess = () => resolve((request.result as HistoryRecord[]) ?? []);
      request.onerror = () => reject(request.error);
    });
    return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } finally {
    db.close();
  }
}

export async function saveHistory(record: HistoryRecord): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const all = await listHistory(record.userId);
    const extra = all.slice(MAX_RUNS);
    if (extra.length === 0) return;
    const cleanup = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = cleanup.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        for (const row of extra) store.delete(row.id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      cleanup.close();
    }
  } finally {
    db.close();
  }
}

export async function deleteHistory(id: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function settleStalePending(records: HistoryRecord[], now = Date.now()): HistoryRecord[] {
  const limit = 5 * 60 * 1000;
  return records.map((record) => {
    if (record.status !== "pending") return record;
    if (now - Date.parse(record.createdAt) < limit) return record;
    return {
      ...record,
      status: "failed",
      error: "页面关闭时请求仍在进行，结果没有保存到这台浏览器。请先核对余额，再决定要不要重试。",
    };
  });
}
