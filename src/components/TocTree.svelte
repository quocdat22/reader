<script lang="ts">
  import type { OutlineNode } from "../lib/domain/outline";
  import ChevronIcon from "./icons/ChevronIcon.svelte";
  import Self from "./TocTree.svelte";

  const MAX_INDENT_DEPTH = 6;

  interface Props {
    nodes: readonly OutlineNode[];
    expandedIds: ReadonlySet<string>;
    activeVisibleNodeId: string | null;
    rovingNodeId: string | null;
    isRoot?: boolean;
    onToggleExpand: (nodeId: string, expanded: boolean) => void;
    onActivateNode: (node: OutlineNode, fromKeyboard: boolean) => void;
    onRowKeyDown: (event: KeyboardEvent, node: OutlineNode) => void;
    onSetRovingNode: (nodeId: string) => void;
  }

  let {
    nodes,
    expandedIds,
    activeVisibleNodeId,
    rovingNodeId,
    isRoot = false,
    onToggleExpand,
    onActivateNode,
    onRowKeyDown,
    onSetRovingNode,
  }: Props = $props();
</script>

<ul
  class="toc-list"
  role={isRoot ? "tree" : "group"}
  aria-label={isRoot ? "Document outline" : undefined}
>
  {#each nodes as node, idx (node.id)}
    {@const isExpanded = node.hasChildren && expandedIds.has(node.id)}
    {@const isInert = node.pageIndex === null && !node.hasChildren}
    {@const isActive = activeVisibleNodeId === node.id}
    {@const isRoving =
      rovingNodeId === node.id ||
      (isRoot && idx === 0 && rovingNodeId === null)}
    <li class="toc-item" role="none">
      <div
        class="toc-row"
        class:toc-row--top={node.depth === 0}
        class:toc-row--inert={isInert}
        class:toc-row--active={isActive}
        style:--toc-depth={Math.min(node.depth, MAX_INDENT_DEPTH)}
        role="treeitem"
        aria-level={node.depth + 1}
        aria-expanded={node.hasChildren ? isExpanded : undefined}
        aria-disabled={isInert ? "true" : undefined}
        aria-selected={isActive}
        aria-current={isActive ? "location" : undefined}
        tabindex={isRoving ? 0 : -1}
        data-node-id={node.id}
        title={node.title}
        onclick={() => {
          if (isInert) {
            return;
          }
          onSetRovingNode(node.id);
          onActivateNode(node, false);
        }}
        onkeydown={(event) => onRowKeyDown(event, node)}
      >
        {#if node.hasChildren}
          <button
            type="button"
            class="toc-chevron-btn"
            tabindex={-1}
            aria-hidden="true"
            aria-expanded={isExpanded}
            onclick={(event) => {
              event.stopPropagation();
              onToggleExpand(node.id, !isExpanded);
            }}
          >
            <ChevronIcon
              direction="right"
              size={10}
              className="toc-chevron-icon"
            />
          </button>
        {:else}
          <span class="toc-chevron-spacer" aria-hidden="true"></span>
        {/if}

        <span class="toc-label">{node.title}</span>

        {#if node.pageIndex !== null}
          <span class="toc-page">{node.pageIndex + 1}</span>
        {/if}
      </div>

      {#if node.hasChildren && isExpanded}
        <Self
          nodes={node.children}
          {expandedIds}
          {activeVisibleNodeId}
          {rovingNodeId}
          isRoot={false}
          {onToggleExpand}
          {onActivateNode}
          {onRowKeyDown}
          {onSetRovingNode}
        />
      {/if}
    </li>
  {/each}
</ul>

<style>
  .toc-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .toc-item {
    margin: 0;
    padding: 0;
  }

  .toc-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 27px;
    padding: 4px 8px 4px calc(6px + var(--toc-depth, 0) * 14px);
    border-radius: var(--radius-sm);
    color: var(--ink-muted);
    font-size: 12.5px;
    line-height: 1.35;
    cursor: pointer;
    transition:
      background-color 110ms ease,
      color 110ms ease;
  }

  .toc-row--top {
    color: var(--ink-primary);
  }

  .toc-row:hover {
    background-color: var(--hover-subtle);
    color: var(--ink-primary);
  }

  .toc-row--inert {
    cursor: default;
  }

  .toc-row--inert:hover {
    background-color: transparent;
    color: var(--ink-muted);
  }

  .toc-row--active {
    background-color: var(--accent-tint);
    color: var(--accent-cobalt);
  }

  .toc-row--active::before {
    content: "";
    position: absolute;
    left: 0;
    top: 4px;
    bottom: 4px;
    width: 2px;
    border-radius: 1px;
    background-color: var(--accent-cobalt);
  }

  .toc-row--active:hover {
    background-color: var(--accent-tint);
    color: var(--accent-cobalt);
  }

  .toc-chevron-btn,
  .toc-chevron-spacer {
    flex: 0 0 18px;
    width: 18px;
    height: 18px;
  }

  .toc-chevron-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: inherit;
    opacity: 0.72;
    cursor: pointer;
    transition:
      background-color 110ms ease,
      opacity 110ms ease;
  }

  .toc-chevron-btn:hover {
    background-color: var(--active-subtle);
    opacity: 1;
  }

  :global(.toc-chevron-icon) {
    transition: transform 120ms ease;
  }

  .toc-chevron-btn[aria-expanded="true"] :global(.toc-chevron-icon) {
    transform: rotate(90deg);
  }

  .toc-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 450;
  }

  .toc-row--active .toc-label {
    font-weight: 550;
  }

  .toc-page {
    flex: 0 0 auto;
    margin-left: 6px;
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    color: var(--ink-muted);
    opacity: 0.8;
  }

  .toc-row--active .toc-page {
    color: var(--accent-cobalt);
    opacity: 0.9;
  }
</style>
