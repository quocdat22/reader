import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveReadingStateParams } from "../../ipc/client";
import { createPersistenceQueue, SAVE_DEBOUNCE_MS } from "../persistence";

describe("PersistenceQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("isolates 400ms debounced saves per canonical path without clobbering other tabs", async () => {
    const saved: SaveReadingStateParams[] = [];
    const queue = createPersistenceQueue({
      saveReadingState: async (params) => {
        saved.push(params);
      },
    });

    queue.schedule({
      path: "/virtual/doc-a.pdf",
      pageIndex: 2,
      zoomMode: "fit_width",
      zoomScale: 1.0,
    });

    await vi.advanceTimersByTimeAsync(150);

    queue.schedule({
      path: "/virtual/doc-b.pdf",
      pageIndex: 9,
      zoomMode: "custom",
      zoomScale: 1.5,
    });

    expect(queue.hasPending("/virtual/doc-a.pdf")).toBe(true);
    expect(queue.hasPending("/virtual/doc-b.pdf")).toBe(true);

    // At 400ms total, doc-a flushes while doc-b still has 150ms remaining.
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 150);
    expect(saved).toEqual([
      {
        path: "/virtual/doc-a.pdf",
        pageIndex: 2,
        zoomMode: "fit_width",
        zoomScale: 1.0,
      },
    ]);
    expect(queue.hasPending("/virtual/doc-a.pdf")).toBe(false);
    expect(queue.hasPending("/virtual/doc-b.pdf")).toBe(true);

    await vi.advanceTimersByTimeAsync(150);
    expect(saved).toEqual([
      {
        path: "/virtual/doc-a.pdf",
        pageIndex: 2,
        zoomMode: "fit_width",
        zoomScale: 1.0,
      },
      {
        path: "/virtual/doc-b.pdf",
        pageIndex: 9,
        zoomMode: "custom",
        zoomScale: 1.5,
      },
    ]);
    expect(queue.hasPending()).toBe(false);
  });

  it("supports immediate flush, flushAll, and cancel without duplicate saves", async () => {
    const saved: SaveReadingStateParams[] = [];
    const queue = createPersistenceQueue({
      saveReadingState: async (params) => {
        saved.push(params);
      },
    });

    queue.schedule({
      path: "/virtual/doc-a.pdf",
      pageIndex: 1,
      zoomMode: "fit_width",
      zoomScale: 1.0,
    });
    queue.schedule({
      path: "/virtual/doc-a.pdf",
      pageIndex: 4,
      zoomMode: "fit_page",
      zoomScale: 0.85,
    });

    await queue.flush("/virtual/doc-a.pdf");
    expect(saved).toHaveLength(1);
    expect(saved[0]?.pageIndex).toBe(4);

    // Timer was cleared; advancing time must not save again.
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
    expect(saved).toHaveLength(1);

    queue.schedule({
      path: "/virtual/doc-b.pdf",
      pageIndex: 3,
      zoomMode: "custom",
      zoomScale: 1.25,
    });
    queue.schedule({
      path: "/virtual/doc-c.pdf",
      pageIndex: 7,
      zoomMode: "fit_width",
      zoomScale: 1.0,
    });
    queue.cancel("/virtual/doc-b.pdf");

    await queue.flushAll();
    expect(saved).toHaveLength(2);
    expect(saved[1]?.path).toBe("/virtual/doc-c.pdf");
  });

  it("swallows and logs backend errors without throwing to callers", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const queue = createPersistenceQueue({
        saveReadingState: async () => {
          throw new Error("disk full");
        },
      });

      queue.schedule({
        path: "/virtual/doc-a.pdf",
        pageIndex: 0,
        zoomMode: "fit_width",
        zoomScale: 1.0,
      });

      await expect(queue.flush("/virtual/doc-a.pdf")).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});
