import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/viewport-layers.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { createTauriReaderApi } from "./lib/ipc/client";
import { createAppActions } from "./lib/state/actions";
import { createAppStore } from "./lib/state/app-store.svelte";
import { createDocumentScopeRegistry } from "./lib/state/doc-scope";
import { createPersistenceQueue } from "./lib/state/persistence";
import type { TransitionHooks } from "./lib/state/types";

const target = document.getElementById("app");
if (!target) {
  throw new Error("Missing #app mount target.");
}

const api = createTauriReaderApi();
const store = createAppStore();
const scopes = createDocumentScopeRegistry();
const persistence = createPersistenceQueue(api);
const hooks: TransitionHooks = {};
const actions = createAppActions({ store, api, scopes, persistence, hooks });

mount(App, {
  target,
  props: {
    store,
    actions,
    api,
    scopes,
    hooks,
  },
});
