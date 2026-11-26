import { flushSync } from "svelte";
import { describe, expect, it } from "vitest";
import { createSmokeCounter, trackEffectRuns } from "./runes-smoke.svelte";

describe("Svelte 5 runes toolchain smoke test", () => {
  it("evaluates $state, $derived, $effect.root, and flushSync under browser conditions", () => {
    const counter = createSmokeCounter(2);
    const seen: number[] = [];

    const dispose = trackEffectRuns(
      () => counter.doubled,
      (value) => seen.push(value),
    );

    try {
      expect(counter.count).toBe(2);
      expect(counter.doubled).toBe(4);
      expect(seen).toEqual([4]);

      counter.increment();
      flushSync();

      expect(counter.count).toBe(3);
      expect(counter.doubled).toBe(6);
      expect(seen).toEqual([4, 6]);
    } finally {
      dispose();
    }
  });
});
