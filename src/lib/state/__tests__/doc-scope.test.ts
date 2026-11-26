import { describe, expect, it } from "vitest";
import { createDocumentScopeRegistry } from "../doc-scope";

describe("DocumentScopeRegistry", () => {
  it("tracks document root lifetimes and cascades disposal to child search signals", () => {
    const registry = createDocumentScopeRegistry();
    const rootSignal = registry.ensure(1);
    const searchSignal = registry.beginSearch(1);

    expect(registry.isAlive(1, rootSignal)).toBe(true);
    expect(registry.isAlive(1, searchSignal)).toBe(true);

    registry.dispose(1);

    expect(rootSignal.aborted).toBe(true);
    expect(searchSignal.aborted).toBe(true);
    expect(registry.isAlive(1, rootSignal)).toBe(false);
    expect(registry.getSignal(1)).toBeNull();
  });

  it("aborts superseded search signals without aborting the document root scope", () => {
    const registry = createDocumentScopeRegistry();
    const rootSignal = registry.ensure(2);
    const search1 = registry.beginSearch(2);
    const search2 = registry.beginSearch(2);

    expect(search1.aborted).toBe(true);
    expect(search2.aborted).toBe(false);
    expect(rootSignal.aborted).toBe(false);

    registry.cancelSearch(2);
    expect(search2.aborted).toBe(true);
    expect(rootSignal.aborted).toBe(false);
    expect(registry.isAlive(2, rootSignal)).toBe(true);

    registry.disposeAll();
    expect(rootSignal.aborted).toBe(true);
  });
});
