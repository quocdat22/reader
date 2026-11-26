import { describe, expect, it, vi } from "vitest";
import { createRecentCoverLoader } from "../recent-covers";

function makeFakeImageData(width: number, height: number): ImageData {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
    colorSpace: "srgb",
  } as ImageData;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createRecentCoverLoader", () => {
  it("limits concurrent cover IPC requests and resolves ready covers", async () => {
    const pending = new Map<string, Deferred<ImageData>>();
    const getRecentCover = vi.fn((path: string) => {
      const deferred = createDeferred<ImageData>();
      pending.set(path, deferred);
      return deferred.promise;
    });
    const onChange = vi.fn();

    const loader = createRecentCoverLoader({
      api: { getRecentCover },
      maxConcurrent: 2,
      onChange,
    });

    loader.syncVisible(["/a.pdf", "/b.pdf", "/c.pdf", "/d.pdf"]);

    expect(getRecentCover).toHaveBeenCalledTimes(2);
    expect(getRecentCover).toHaveBeenNthCalledWith(1, "/a.pdf", 160);
    expect(getRecentCover).toHaveBeenNthCalledWith(2, "/b.pdf", 160);
    expect(loader.get("/a.pdf")).toEqual({ status: "loading" });
    expect(loader.get("/c.pdf")).toEqual({ status: "loading" });

    const imgA = makeFakeImageData(120, 160);
    pending.get("/a.pdf")?.resolve(imgA);
    await vi.waitFor(() => {
      expect(loader.get("/a.pdf")).toEqual({
        status: "ready",
        imageData: imgA,
      });
      expect(getRecentCover).toHaveBeenCalledTimes(3);
    });
    expect(getRecentCover).toHaveBeenNthCalledWith(3, "/c.pdf", 160);

    loader.destroy();
  });

  it("drops queued off-page requests when visible paths change", async () => {
    const pending = new Map<string, Deferred<ImageData>>();
    const loader = createRecentCoverLoader({
      api: {
        getRecentCover: (path: string) => {
          const deferred = createDeferred<ImageData>();
          pending.set(path, deferred);
          return deferred.promise;
        },
      },
      maxConcurrent: 1,
    });

    loader.syncVisible(["/page1-a.pdf", "/page1-b.pdf"]);
    expect(Array.from(pending.keys())).toEqual(["/page1-a.pdf"]);

    // Page changed before /page1-b.pdf started fetching.
    loader.syncVisible(["/page2-a.pdf"]);
    expect(loader.get("/page1-b.pdf")).toBeUndefined();

    pending.get("/page1-a.pdf")?.resolve(makeFakeImageData(100, 140));
    await vi.waitFor(() => {
      expect(pending.has("/page2-a.pdf")).toBe(true);
    });

    expect(pending.has("/page1-b.pdf")).toBe(false);

    loader.destroy();
  });

  it("marks failed cover loads as unavailable and supports invalidation", async () => {
    let attempt = 0;
    const img = makeFakeImageData(110, 160);
    const loader = createRecentCoverLoader({
      api: {
        getRecentCover: async () => {
          attempt += 1;
          if (attempt === 1) {
            throw new Error("Missing file");
          }
          return img;
        },
      },
    });

    loader.syncVisible(["/missing.pdf"]);
    await vi.waitFor(() => {
      expect(loader.get("/missing.pdf")).toEqual({ status: "unavailable" });
    });

    loader.invalidate("/missing.pdf");
    expect(loader.get("/missing.pdf")).toBeUndefined();

    loader.syncVisible(["/missing.pdf"]);
    await vi.waitFor(() => {
      expect(loader.get("/missing.pdf")).toEqual({
        status: "ready",
        imageData: img,
      });
    });

    loader.destroy();
  });

  it("evicts oldest non-visible entries past maxCacheEntries", async () => {
    const loader = createRecentCoverLoader({
      api: {
        getRecentCover: async (path: string) =>
          makeFakeImageData(100, 140 + path.length),
      },
      maxCacheEntries: 2,
      maxConcurrent: 2,
    });

    loader.syncVisible(["/one.pdf", "/two.pdf"]);
    await vi.waitFor(() => {
      expect(loader.get("/one.pdf")?.status).toBe("ready");
      expect(loader.get("/two.pdf")?.status).toBe("ready");
    });

    loader.syncVisible(["/three.pdf"]);
    await vi.waitFor(() => {
      expect(loader.get("/three.pdf")?.status).toBe("ready");
    });

    expect(loader.get("/one.pdf")).toBeUndefined();
    expect(loader.get("/two.pdf")?.status).toBe("ready");

    loader.destroy();
  });
});
