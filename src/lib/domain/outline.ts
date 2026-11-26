import { SvelteSet } from "svelte/reactivity";
import type { OutlineItem } from "../ipc/types";

export interface OutlineNode {
  readonly id: string;
  readonly title: string;
  readonly pageIndex: number | null;
  readonly depth: number;
  readonly parentId: string | null;
  readonly children: OutlineNode[];
  readonly hasChildren: boolean;
}

export interface OutlineModel {
  readonly roots: OutlineNode[];
  readonly flat: OutlineNode[];
  readonly byId: Map<string, OutlineNode>;
}

/**
 * Normalizes raw Rust `OutlineItem[]` into an indexed tree model for fast lookups.
 */
export function buildOutlineModel(
  rawItems: readonly OutlineItem[],
): OutlineModel {
  const flat: OutlineNode[] = [];
  const byId = new Map<string, OutlineNode>();

  function walk(
    items: readonly OutlineItem[] | undefined,
    depth: number,
    parentId: string | null,
    prefix: string,
  ): OutlineNode[] {
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }

    const result: OutlineNode[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const raw = items[i];
      if (!raw || typeof raw !== "object") {
        continue;
      }

      const id = prefix ? `${prefix}.${i}` : String(i);
      const rawTitle = typeof raw.title === "string" ? raw.title.trim() : "";
      const title = rawTitle.length > 0 ? rawTitle : "Untitled";
      const pageIndex =
        typeof raw.page_index === "number" &&
        Number.isInteger(raw.page_index) &&
        raw.page_index >= 0
          ? raw.page_index
          : null;

      const node: OutlineNode = {
        id,
        title,
        pageIndex,
        depth,
        parentId,
        children: [],
        hasChildren: false,
      };

      const flatIndex = flat.length;
      flat.push(node);
      byId.set(id, node);

      const children = walk(raw.children, depth + 1, id, id);
      const finalized: OutlineNode = {
        ...node,
        children,
        hasChildren: children.length > 0,
      };
      byId.set(id, finalized);
      // Keep `flat` pointing at the finalized node object at its original preorder index.
      flat[flatIndex] = finalized;
      result.push(finalized);
    }
    return result;
  }

  const roots = walk(rawItems, 0, null, "");
  return { roots, flat, byId };
}

/**
 * Resolves the deepest outline node corresponding to `pageIndex`.
 *
 * When multiple entries share `pageIndex`, preserves `preferredNodeId` if it points
 * to `pageIndex`; otherwise picks the first entry on `pageIndex` when landing on a
 * bookmark page, or the last entry on the nearest preceding bookmark page.
 */
export function resolveActiveOutlineNodeId(
  model: OutlineModel | null,
  pageIndex: number,
  preferredNodeId: string | null = null,
): string | null {
  if (
    !model ||
    model.flat.length === 0 ||
    !Number.isInteger(pageIndex) ||
    pageIndex < 0
  ) {
    return null;
  }

  if (preferredNodeId) {
    const preferred = model.byId.get(preferredNodeId);
    if (preferred && preferred.pageIndex === pageIndex) {
      return preferred.id;
    }
  }

  let bestPage = -1;
  let firstAtBest: string | null = null;
  let lastAtBest: string | null = null;

  for (const node of model.flat) {
    if (node.pageIndex === null || node.pageIndex > pageIndex) {
      continue;
    }
    if (node.pageIndex > bestPage) {
      bestPage = node.pageIndex;
      firstAtBest = node.id;
      lastAtBest = node.id;
    } else if (node.pageIndex === bestPage) {
      lastAtBest = node.id;
    }
  }

  if (bestPage < 0) {
    return null;
  }

  return bestPage === pageIndex ? firstAtBest : lastAtBest;
}

/**
 * Maps a resolved active node ID to itself if visible, or to its deepest visible
 * collapsed ancestor so active progress remains clear without auto-expanding closed sections.
 */
export function resolveVisibleActiveNodeId(
  model: OutlineModel | null,
  nodeId: string | null,
  expandedIds: ReadonlySet<string>,
): string | null {
  if (!nodeId || !model) {
    return null;
  }
  const target = model.byId.get(nodeId);
  if (!target) {
    return null;
  }

  const chain: OutlineNode[] = [];
  let cursor: OutlineNode | undefined = target;
  while (cursor) {
    chain.push(cursor);
    cursor = cursor.parentId ? model.byId.get(cursor.parentId) : undefined;
  }
  chain.reverse();

  let visible = chain[0];
  if (!visible) {
    return null;
  }
  for (let i = 0; i < chain.length - 1; i += 1) {
    const current = chain[i];
    const next = chain[i + 1];
    if (!current || !next) {
      break;
    }
    if (!expandedIds.has(current.id)) {
      return current.id;
    }
    visible = next;
  }
  return visible.id;
}

/**
 * Computes initial expanded node IDs on first open for a tab:
 * - Auto-expands root wrappers when a document nests everything under 1-2 roots.
 * - Expands the ancestor chain of the reader's current chapter.
 */
export function createInitialExpandedIds(
  model: OutlineModel,
  pageIndex: number,
): SvelteSet<string> {
  const expanded = new SvelteSet<string>();

  if (model.roots.length > 0 && model.roots.length <= 2) {
    for (const root of model.roots) {
      if (root.hasChildren) {
        expanded.add(root.id);
      }
    }
  }

  const activeId = resolveActiveOutlineNodeId(model, pageIndex);
  let cursor = activeId ? model.byId.get(activeId) : undefined;
  while (cursor && cursor.parentId) {
    expanded.add(cursor.parentId);
    cursor = model.byId.get(cursor.parentId);
  }

  return expanded;
}
