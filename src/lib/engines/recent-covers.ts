import type { ReaderApi } from "../ipc/client";

export const DEFAULT_COVER_MAX_SIDE_PX = 160;
export const MAX_COVER_CACHE_ENTRIES = 40;
export const MAX_CONCURRENT_COVER_LOADS = 2;

export type CoverEntry =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly imageData: ImageData }
  | { readonly status: "unavailable" };

export interface RecentCoverLoaderOptions {
  readonly api: Pick<ReaderApi, "getRecentCover">;
  readonly maxSidePx?: number;
  readonly maxCacheEntries?: number;
  readonly maxConcurrent?: number;
  readonly onChange?: () => void;
}

export interface RecentCoverLoader {
  get(path: string): CoverEntry | undefined;
  syncVisible(paths: readonly string[]): void;
  clearPending(): void;
  invalidate(path: string): void;
  destroy(): void;
}

/**
 * Framework-agnostic bounded cover loader and LRU memory cache for the Home recent-files list.
 */
export function createRecentCoverLoader(
  options: RecentCoverLoaderOptions,
): RecentCoverLoader {
  const maxSidePx = options.maxSidePx ?? DEFAULT_COVER_MAX_SIDE_PX;
  const maxCacheEntries = Math.max(
    1,
    options.maxCacheEntries ?? MAX_COVER_CACHE_ENTRIES,
  );
  const maxConcurrent = Math.max(
    1,
    options.maxConcurrent ?? MAX_CONCURRENT_COVER_LOADS,
  );

  const cache = new Map<string, Exclude<CoverEntry, { status: "loading" }>>();
  const generations = new Map<string, number>();
  const activePathEpochs = new Map<string, number>();
  const queuedSet = new Set<string>();
  const queued: string[] = [];
  let inFlightCount = 0;
  let visibleSet = new Set<string>();
  let destroyed = false;

  function notify(): void {
    if (!destroyed) {
      options.onChange?.();
    }
  }

  function touchCacheEntry(
    path: string,
    entry: Exclude<CoverEntry, { status: "loading" }>,
  ): void {
    cache.delete(path);
    cache.set(path, entry);
  }

  function evictIfNeeded(): void {
    if (cache.size <= maxCacheEntries) {
      return;
    }
    for (const candidate of cache.keys()) {
      if (cache.size <= maxCacheEntries) {
        break;
      }
      if (!visibleSet.has(candidate)) {
        cache.delete(candidate);
      }
    }
    while (cache.size > maxCacheEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
  }

  function pumpQueue(): void {
    if (destroyed) {
      return;
    }

    while (inFlightCount < maxConcurrent && queued.length > 0) {
      const nextPath = queued.shift();
      if (nextPath === undefined) {
        break;
      }
      queuedSet.delete(nextPath);

      if (
        !visibleSet.has(nextPath) ||
        cache.has(nextPath) ||
        activePathEpochs.has(nextPath)
      ) {
        continue;
      }

      void startFetch(nextPath);
    }
  }

  async function startFetch(path: string): Promise<void> {
    const epoch = generations.get(path) ?? 0;
    inFlightCount += 1;
    activePathEpochs.set(path, epoch);
    notify();

    try {
      const imageData = await options.api.getRecentCover(path, maxSidePx);
      if (!destroyed && (generations.get(path) ?? 0) === epoch) {
        touchCacheEntry(path, { status: "ready", imageData });
        evictIfNeeded();
      }
    } catch {
      if (!destroyed && (generations.get(path) ?? 0) === epoch) {
        touchCacheEntry(path, { status: "unavailable" });
        evictIfNeeded();
      }
    } finally {
      inFlightCount = Math.max(0, inFlightCount - 1);
      if (activePathEpochs.get(path) === epoch) {
        activePathEpochs.delete(path);
      }
      notify();
      pumpQueue();
    }
  }

  function get(path: string): CoverEntry | undefined {
    const cached = cache.get(path);
    if (cached) {
      return cached;
    }
    if (activePathEpochs.has(path) || queuedSet.has(path)) {
      return { status: "loading" };
    }
    return undefined;
  }

  function syncVisible(paths: readonly string[]): void {
    if (destroyed) {
      return;
    }

    const nextVisible = new Set<string>();
    const ordered: string[] = [];
    for (const path of paths) {
      if (
        typeof path !== "string" ||
        path.length === 0 ||
        nextVisible.has(path)
      ) {
        continue;
      }
      nextVisible.add(path);
      ordered.push(path);
    }
    visibleSet = nextVisible;

    // Drop any unstarted queued items that are no longer visible on the active page.
    if (queued.length > 0) {
      let writeIdx = 0;
      for (const path of queued) {
        if (visibleSet.has(path)) {
          queued[writeIdx] = path;
          writeIdx += 1;
        } else {
          queuedSet.delete(path);
        }
      }
      queued.length = writeIdx;
    }

    let queuedAny = false;
    for (const path of ordered) {
      const existing = cache.get(path);
      if (existing) {
        touchCacheEntry(path, existing);
        continue;
      }
      if (!activePathEpochs.has(path) && !queuedSet.has(path)) {
        queuedSet.add(path);
        queued.push(path);
        queuedAny = true;
      }
    }

    if (queuedAny) {
      notify();
    }
    pumpQueue();
  }

  function clearPending(): void {
    visibleSet = new Set();
    if (queued.length > 0) {
      queued.length = 0;
      queuedSet.clear();
      notify();
    }
  }

  function invalidate(path: string): void {
    if (typeof path !== "string" || path.length === 0) {
      return;
    }
    generations.set(path, (generations.get(path) ?? 0) + 1);
    const hadActive = activePathEpochs.delete(path);
    const hadCached = cache.delete(path);
    let hadQueued = false;
    if (queuedSet.delete(path)) {
      hadQueued = true;
      const idx = queued.indexOf(path);
      if (idx !== -1) {
        queued.splice(idx, 1);
      }
    }
    if (hadActive || hadCached || hadQueued) {
      notify();
    }
  }

  function destroy(): void {
    destroyed = true;
    visibleSet.clear();
    queued.length = 0;
    queuedSet.clear();
    activePathEpochs.clear();
    inFlightCount = 0;
    cache.clear();
    generations.clear();
  }

  return {
    get,
    syncVisible,
    clearPending,
    invalidate,
    destroy,
  };
}
