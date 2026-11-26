interface ScopeEntry {
  readonly root: AbortController;
  search: AbortController | null;
  unlinkSearchFromRoot: (() => void) | null;
}

/**
 * Manages per-document `AbortController` lifecycles and linked child search scopes.
 * Disposing a document aborts its root signal and cascades to any active search.
 */
export class DocumentScopeRegistry {
  private readonly scopes = new Map<number, ScopeEntry>();

  /**
   * Ensures a root scope exists for `documentId` and returns its `AbortSignal`.
   */
  ensure(documentId: number): AbortSignal {
    let entry = this.scopes.get(documentId);
    if (!entry) {
      entry = {
        root: new AbortController(),
        search: null,
        unlinkSearchFromRoot: null,
      };
      this.scopes.set(documentId, entry);
    }
    return entry.root.signal;
  }

  /**
   * Returns the active root `AbortSignal` for `documentId`, or `null` if not open.
   */
  getSignal(documentId: number): AbortSignal | null {
    return this.scopes.get(documentId)?.root.signal ?? null;
  }

  /**
   * Returns `true` iff `documentId` is registered and neither the scope nor `signal` is aborted.
   */
  isAlive(documentId: number, signal?: AbortSignal | null): boolean {
    const entry = this.scopes.get(documentId);
    if (!entry || entry.root.signal.aborted) {
      return false;
    }
    if (signal && signal.aborted) {
      return false;
    }
    return true;
  }

  /**
   * Aborts any prior search for `documentId` and returns a fresh child `AbortSignal`
   * linked to the document's root lifecycle signal.
   */
  beginSearch(documentId: number): AbortSignal {
    this.ensure(documentId);
    const entry = this.scopes.get(documentId);
    if (!entry) {
      const fallback = new AbortController();
      fallback.abort();
      return fallback.signal;
    }

    this.abortSearchEntry(entry);

    const searchController = new AbortController();
    const onRootAbort = () => {
      searchController.abort();
    };
    entry.root.signal.addEventListener("abort", onRootAbort, { once: true });
    entry.search = searchController;
    entry.unlinkSearchFromRoot = () => {
      entry.root.signal.removeEventListener("abort", onRootAbort);
    };

    if (entry.root.signal.aborted) {
      searchController.abort();
    }

    return searchController.signal;
  }

  /**
   * Aborts the active search scope for `documentId` without closing the document.
   */
  cancelSearch(documentId: number): void {
    const entry = this.scopes.get(documentId);
    if (!entry) {
      return;
    }
    this.abortSearchEntry(entry);
  }

  /**
   * Aborts the document scope (cascading to active searches) and removes it.
   */
  dispose(documentId: number): void {
    const entry = this.scopes.get(documentId);
    if (!entry) {
      return;
    }
    this.scopes.delete(documentId);
    this.abortSearchEntry(entry);
    entry.root.abort();
  }

  /**
   * Disposes all active document scopes.
   */
  disposeAll(): void {
    for (const documentId of Array.from(this.scopes.keys())) {
      this.dispose(documentId);
    }
  }

  private abortSearchEntry(entry: ScopeEntry): void {
    entry.unlinkSearchFromRoot?.();
    entry.unlinkSearchFromRoot = null;
    if (entry.search) {
      entry.search.abort();
      entry.search = null;
    }
  }
}

export function createDocumentScopeRegistry(): DocumentScopeRegistry {
  return new DocumentScopeRegistry();
}
