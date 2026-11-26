import type { ReaderApi, SaveReadingStateParams } from "../ipc/client";

export const SAVE_DEBOUNCE_MS = 400;

interface PendingSaveEntry {
  timer: ReturnType<typeof setTimeout> | null;
  payload: SaveReadingStateParams;
}

export interface PersistenceQueue {
  schedule(params: SaveReadingStateParams): void;
  flush(path: string): Promise<void>;
  flushAll(): Promise<void>;
  cancel(path: string): void;
  hasPending(path?: string): boolean;
  dispose(): void;
}

/**
 * Per-path debounced reading-state persistence queue.
 * Scheduling a save for path B never cancels or overwrites path A's pending save.
 */
export function createPersistenceQueue(
  api: Pick<ReaderApi, "saveReadingState">,
  debounceMs = SAVE_DEBOUNCE_MS,
): PersistenceQueue {
  const pending = new Map<string, PendingSaveEntry>();

  function clearEntryTimer(entry: PendingSaveEntry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  async function flush(path: string): Promise<void> {
    const entry = pending.get(path);
    if (!entry) {
      return;
    }
    clearEntryTimer(entry);
    pending.delete(path);

    try {
      await api.saveReadingState(entry.payload);
    } catch (err) {
      console.error("Failed to save reading state:", err);
    }
  }

  function schedule(params: SaveReadingStateParams): void {
    const existing = pending.get(params.path);
    if (existing) {
      clearEntryTimer(existing);
    }

    const entry: PendingSaveEntry = {
      payload: params,
      timer: setTimeout(() => {
        void flush(params.path);
      }, debounceMs),
    };
    pending.set(params.path, entry);
  }

  async function flushAll(): Promise<void> {
    const paths = Array.from(pending.keys());
    if (paths.length === 0) {
      return;
    }
    await Promise.allSettled(paths.map((path) => flush(path)));
  }

  function cancel(path: string): void {
    const existing = pending.get(path);
    if (!existing) {
      return;
    }
    clearEntryTimer(existing);
    pending.delete(path);
  }

  function hasPending(path?: string): boolean {
    return typeof path === "string" ? pending.has(path) : pending.size > 0;
  }

  function dispose(): void {
    for (const entry of pending.values()) {
      clearEntryTimer(entry);
    }
    pending.clear();
  }

  return {
    schedule,
    flush,
    flushAll,
    cancel,
    hasPending,
    dispose,
  };
}
