import { flushSync } from "svelte";

export function createSmokeCounter(initial: number) {
  let count = $state(initial);
  const doubled = $derived(count * 2);

  return {
    get count() {
      return count;
    },
    get doubled() {
      return doubled;
    },
    increment() {
      count += 1;
    },
  };
}

export function trackEffectRuns(
  readValue: () => number,
  onRun: (value: number) => void,
): () => void {
  const cleanup = $effect.root(() => {
    $effect(() => {
      onRun(readValue());
    });
  });
  flushSync();
  return cleanup;
}
