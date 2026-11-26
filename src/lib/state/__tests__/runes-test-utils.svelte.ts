import { flushSync } from "svelte";

/**
 * Creates a detached Svelte 5 `$effect.root` registering independent `$effect` callbacks
 * and flushes synchronously.
 */
export function observeReactiveEffect(
  ...effectFns: Array<() => void>
): () => void {
  const dispose = $effect.root(() => {
    for (const fn of effectFns) {
      $effect(() => {
        fn();
      });
    }
  });
  flushSync();
  return dispose;
}
