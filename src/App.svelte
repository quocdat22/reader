<script lang="ts">
  import DropOverlay from "./components/DropOverlay.svelte";
  import HomeScreen from "./components/HomeScreen.svelte";
  import NoticeBanner from "./components/NoticeBanner.svelte";
  import TabStrip from "./components/TabStrip.svelte";
  import Toolbar from "./components/Toolbar.svelte";
  import ViewportHost from "./components/ViewportHost.svelte";
  import { installShortcutRouter } from "./lib/engines/shortcuts";
  import type { ReaderApi } from "./lib/ipc/client";
  import type { AppActions } from "./lib/state/actions";
  import type { AppStore } from "./lib/state/app-store.svelte";
  import type { DocumentScopeRegistry } from "./lib/state/doc-scope";
  import type { TransitionHooks } from "./lib/state/types";

  interface Props {
    store: AppStore;
    actions: AppActions;
    api: ReaderApi;
    scopes: DocumentScopeRegistry;
    hooks: TransitionHooks;
  }

  let { store, actions, api, scopes, hooks }: Props = $props();
  const windowControls = $derived(api.getWindowControls());
  let viewportEl = $state<HTMLElement | null>(null);

  $effect(() => {
    document.title = store.windowTitle;
  });

  $effect(() => {
    let active = true;
    let unlistenDragDrop: (() => void) | null = null;

    const handleDragOver = (event: DragEvent) => {
      event.preventDefault();
    };
    const handleDrop = (event: DragEvent) => {
      event.preventDefault();
    };
    const handleBeforeUnload = () => {
      void actions.flushActiveReadingState();
    };

    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);
    window.addEventListener("beforeunload", handleBeforeUnload);

    const uninstallShortcuts = installShortcutRouter({
      store,
      actions,
      getViewportEl: () => viewportEl,
      isInsideToc: () => false,
      isInsideSearch: () => false,
    });

    void api
      .subscribeDragDrop({
        onEnter: () => actions.setDraggingFiles(true),
        onLeave: () => actions.setDraggingFiles(false),
        onDrop: (paths) => {
          actions.setDraggingFiles(false);
          void actions.openPathBatch(paths);
        },
      })
      .then((unlisten) => {
        if (active) {
          unlistenDragDrop = unlisten;
        } else {
          unlisten();
        }
      })
      .catch((err) => {
        console.error("Failed to subscribe to drag-drop events:", err);
      });

    void actions.bootstrap();

    return () => {
      active = false;
      unlistenDragDrop?.();
      uninstallShortcuts();
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      actions.dispose();
    };
  });
</script>

<div class="app">
  <header id="app-chrome" class="chrome">
    <TabStrip {store} {actions} {windowControls} />
    <Toolbar {store} {actions} {hooks} />
  </header>

  <NoticeBanner {store} {actions} />

  <main id="workspace" class="workspace">
    <HomeScreen {store} {actions} />

    <div
      id="reader-shell"
      class="reader-shell"
      hidden={store.shellMode !== "document"}
    >
      <ViewportHost
        {store}
        {actions}
        {api}
        {scopes}
        {hooks}
        onViewportElement={(el) => {
          viewportEl = el;
        }}
      />
    </div>
  </main>

  <DropOverlay {store} />
</div>

<style>
  .app {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
  }

  .chrome {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    z-index: 20;
  }

  .workspace {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }

  .reader-shell {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    overflow: hidden;
  }
</style>
