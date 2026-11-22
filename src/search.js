/**
 * Compact per-tab in-document search bar, debounced query execution, and match navigation.
 *
 * Isolates query text, match lists, active index, and open/closed visibility per tab
 * so switching tabs never leaks search state or page highlights across documents.
 */

import { searchDocument } from "./api.js";

const SEARCH_DEBOUNCE_MS = 200;
const SEARCHING_INDICATOR_DELAY_MS = 120;

function createPrevIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M7.5 2.5L4 6l3.5 3.5");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");

  svg.appendChild(path);
  return svg;
}

function createNextIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M4.5 2.5L8 6l-3.5 3.5");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");

  svg.appendChild(path);
  return svg;
}

function createCloseIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "11");
  svg.setAttribute("height", "11");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2.75 2.75l6.5 6.5M9.25 2.75l-6.5 6.5");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");

  svg.appendChild(path);
  return svg;
}

/**
 * Creates a fresh per-tab search state record.
 */
export function createInitialSearchState() {
  return {
    open: false,
    query: "",
    lastSearchedQuery: "",
    status: "idle",
    matches: [],
    matchesByPage: new Map(),
    currentIndex: -1,
    errorMessage: null,
    requestSeq: 0,
    inFlight: false,
    inFlightQuery: null,
  };
}

/**
 * Ensures `tab.searchState` is initialized and returns it.
 * @param {any} tab
 */
export function ensureSearchState(tab) {
  if (!tab.searchState) {
    tab.searchState = createInitialSearchState();
  }
  return tab.searchState;
}

/**
 * Indexes `SearchMatch[]` by zero-based `page_index` for O(matches on page) overlay rendering.
 * @param {Array<{ page_index: number, rects: Array<{ x: number, y: number, width: number, height: number }> }>} matches
 * @returns {Map<number, Array<{ matchIndex: number, rects: Array<{ x: number, y: number, width: number, height: number }> }>>}
 */
export function groupMatchesByPage(matches) {
  const byPage = new Map();
  if (!Array.isArray(matches)) {
    return byPage;
  }

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    if (!match || !Array.isArray(match.rects) || match.rects.length === 0) {
      continue;
    }
    let list = byPage.get(match.page_index);
    if (!list) {
      list = [];
      byPage.set(match.page_index, list);
    }
    list.push({ matchIndex: i, rects: match.rects });
  }

  return byPage;
}

/**
 * Picks the first match at or after `currentPageIndex`, wrapping to index 0 if none follow.
 * @param {Array<{ page_index: number }>} matches
 * @param {number} currentPageIndex
 * @returns {number}
 */
export function resolveInitialMatchIndex(matches, currentPageIndex) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return -1;
  }
  const page = Number.isInteger(currentPageIndex) && currentPageIndex >= 0 ? currentPageIndex : 0;
  const idx = matches.findIndex((match) => match.page_index >= page);
  return idx >= 0 ? idx : 0;
}

/**
 * Cycles match index by `delta` (`1` or `-1`) with wrap-around.
 * @param {number} currentIndex
 * @param {number} total
 * @param {1 | -1} delta
 * @returns {number}
 */
export function stepMatchIndex(currentIndex, total, delta) {
  if (!Number.isInteger(total) || total <= 0) {
    return -1;
  }
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= total) {
    return delta >= 0 ? 0 : total - 1;
  }
  return (currentIndex + delta + total) % total;
}

function resetMatches(state) {
  state.lastSearchedQuery = "";
  state.status = "idle";
  state.matches = [];
  state.matchesByPage = new Map();
  state.currentIndex = -1;
  state.errorMessage = null;
}

/**
 * @param {{
 *   barEl: HTMLElement,
 *   getActiveTab: () => any | null,
 *   isTabOpen: (documentId: number) => boolean,
 *   onMatchesUpdated: (tab: any) => void,
 *   onActiveMatchChanged: (tab: any, match: any | null) => void,
 *   onVisibilityChanged?: (tab: any) => void,
 *   onCloseFocusViewport?: () => void,
 * }} options
 */
export function createSearchController({
  barEl,
  getActiveTab,
  isTabOpen,
  onMatchesUpdated,
  onActiveMatchChanged,
  onVisibilityChanged,
  onCloseFocusViewport,
}) {
  barEl.textContent = "";
  barEl.setAttribute("role", "search");
  barEl.setAttribute("aria-label", "Find in document");

  const inputEl = document.createElement("input");
  inputEl.id = "search-input";
  inputEl.className = "search-input";
  inputEl.type = "search";
  inputEl.placeholder = "Find in document";
  inputEl.autocomplete = "off";
  inputEl.spellcheck = false;
  inputEl.setAttribute("aria-label", "Find in document");

  const countEl = document.createElement("span");
  countEl.id = "search-count";
  countEl.className = "search-count";
  countEl.setAttribute("aria-live", "polite");

  const navGroupEl = document.createElement("div");
  navGroupEl.className = "search-nav-group";
  navGroupEl.setAttribute("role", "group");
  navGroupEl.setAttribute("aria-label", "Match navigation");

  const prevBtnEl = document.createElement("button");
  prevBtnEl.type = "button";
  prevBtnEl.className = "icon-btn search-nav-btn";
  prevBtnEl.setAttribute("aria-label", "Previous match");
  prevBtnEl.title = "Previous match (Shift+Enter)";
  prevBtnEl.disabled = true;
  prevBtnEl.appendChild(createPrevIcon());

  const nextBtnEl = document.createElement("button");
  nextBtnEl.type = "button";
  nextBtnEl.className = "icon-btn search-nav-btn";
  nextBtnEl.setAttribute("aria-label", "Next match");
  nextBtnEl.title = "Next match (Enter)";
  nextBtnEl.disabled = true;
  nextBtnEl.appendChild(createNextIcon());

  navGroupEl.appendChild(prevBtnEl);
  navGroupEl.appendChild(nextBtnEl);

  const closeBtnEl = document.createElement("button");
  closeBtnEl.type = "button";
  closeBtnEl.className = "icon-btn search-close-btn";
  closeBtnEl.setAttribute("aria-label", "Close search");
  closeBtnEl.title = "Close search (Esc)";
  closeBtnEl.appendChild(createCloseIcon());

  barEl.appendChild(inputEl);
  barEl.appendChild(countEl);
  barEl.appendChild(navGroupEl);
  barEl.appendChild(closeBtnEl);

  /** @type {ReturnType<typeof setTimeout> | null} */
  let debounceTimer = null;
  /** @type {any | null} */
  let debounceTab = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let searchingDelayTimer = null;
  let showSearchingLabel = false;

  function clearDebounce() {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    debounceTab = null;
  }

  function clearSearchingDelay() {
    if (searchingDelayTimer !== null) {
      clearTimeout(searchingDelayTimer);
      searchingDelayTimer = null;
    }
    showSearchingLabel = false;
  }

  function renderBar(tab) {
    if (!tab || !tab.searchState?.open) {
      clearSearchingDelay();
      barEl.hidden = true;
      return;
    }

    const state = ensureSearchState(tab);
    barEl.hidden = false;

    if (inputEl.value !== state.query) {
      inputEl.value = state.query;
    }

    countEl.classList.remove("search-count--error");
    countEl.removeAttribute("aria-label");

    if (state.query.trim().length === 0) {
      countEl.textContent = "";
    } else if (state.status === "searching") {
      countEl.textContent = showSearchingLabel ? "Searching…" : "";
    } else if (state.status === "error") {
      countEl.textContent = "Search failed";
      countEl.classList.add("search-count--error");
    } else if (state.status === "ready") {
      if (state.matches.length > 0) {
        countEl.textContent = `${state.currentIndex + 1} / ${state.matches.length}`;
      } else {
        countEl.textContent = "0 / 0";
        countEl.setAttribute("aria-label", "No matches");
      }
    } else {
      countEl.textContent = "";
    }

    const hasMatches = state.matches.length > 0;
    prevBtnEl.disabled = !hasMatches;
    nextBtnEl.disabled = !hasMatches;
  }

  async function executeSearch(tab, rawQuery) {
    if (!tab || !isTabOpen(tab.documentId)) {
      return;
    }

    const state = ensureSearchState(tab);

    if (rawQuery.trim().length === 0) {
      state.requestSeq += 1;
      resetMatches(state);
      if (getActiveTab()?.documentId === tab.documentId) {
        clearSearchingDelay();
        renderBar(tab);
        onMatchesUpdated(tab);
      }
      return;
    }

    // Serialize at most one active IPC search per tab; latest query runs on completion.
    if (state.inFlight) {
      return;
    }

    const seq = (state.requestSeq += 1);
    state.inFlight = true;
    state.inFlightQuery = rawQuery;
    state.status = "searching";
    state.errorMessage = null;

    if (getActiveTab()?.documentId === tab.documentId) {
      clearSearchingDelay();
      renderBar(tab);
      searchingDelayTimer = setTimeout(() => {
        searchingDelayTimer = null;
        const active = getActiveTab();
        if (
          active &&
          active.documentId === tab.documentId &&
          state.open &&
          state.status === "searching"
        ) {
          showSearchingLabel = true;
          renderBar(active);
        }
      }, SEARCHING_INDICATOR_DELAY_MS);
    }

    try {
      const matches = await searchDocument(tab.documentId, rawQuery);
      state.inFlight = false;
      state.inFlightQuery = null;

      if (getActiveTab()?.documentId === tab.documentId) {
        clearSearchingDelay();
      }

      if (!isTabOpen(tab.documentId) || !state.open) {
        return;
      }

      // If the query changed or was reopened while this request was in flight, run the latest query.
      if (state.query !== rawQuery || seq !== state.requestSeq) {
        if (state.query.trim().length > 0) {
          void executeSearch(tab, state.query);
        } else {
          resetMatches(state);
          if (getActiveTab()?.documentId === tab.documentId) {
            renderBar(tab);
            onMatchesUpdated(tab);
          }
        }
        return;
      }

      state.status = "ready";
      state.lastSearchedQuery = rawQuery;
      state.matches = Array.isArray(matches) ? matches : [];
      state.matchesByPage = groupMatchesByPage(state.matches);
      state.currentIndex = resolveInitialMatchIndex(state.matches, tab.pageIndex);

      if (getActiveTab()?.documentId === tab.documentId) {
        renderBar(tab);
        onMatchesUpdated(tab);
        if (state.currentIndex >= 0) {
          onActiveMatchChanged(tab, state.matches[state.currentIndex]);
        }
      }
    } catch (err) {
      state.inFlight = false;
      state.inFlightQuery = null;

      if (getActiveTab()?.documentId === tab.documentId) {
        clearSearchingDelay();
      }

      if (!isTabOpen(tab.documentId) || !state.open) {
        return;
      }

      if (state.query !== rawQuery || seq !== state.requestSeq) {
        if (state.query.trim().length > 0) {
          void executeSearch(tab, state.query);
        }
        return;
      }

      state.status = "error";
      state.matches = [];
      state.matchesByPage = new Map();
      state.currentIndex = -1;
      state.errorMessage =
        typeof err?.message === "string" && err.message.trim().length > 0
          ? err.message
          : "Search failed.";

      if (getActiveTab()?.documentId === tab.documentId) {
        renderBar(tab);
        onMatchesUpdated(tab);
      }
    }
  }

  function scheduleSearch(tab, rawQuery) {
    clearDebounce();
    const state = ensureSearchState(tab);

    if (rawQuery.trim().length === 0) {
      state.requestSeq += 1;
      resetMatches(state);
      renderBar(tab);
      onMatchesUpdated(tab);
      return;
    }

    debounceTab = tab;
    debounceTimer = setTimeout(() => {
      const targetTab = debounceTab;
      debounceTimer = null;
      debounceTab = null;
      if (targetTab && isTabOpen(targetTab.documentId) && targetTab.searchState?.open) {
        void executeSearch(targetTab, targetTab.searchState.query);
      }
    }, SEARCH_DEBOUNCE_MS);
  }

  function stepMatch(tab, delta) {
    if (!tab || !tab.searchState?.open) {
      return;
    }
    const state = tab.searchState;

    if (
      state.query.trim().length > 0 &&
      (state.status !== "ready" || state.lastSearchedQuery !== state.query)
    ) {
      clearDebounce();
      if (!state.inFlight) {
        void executeSearch(tab, state.query);
      }
      return;
    }

    if (state.matches.length === 0) {
      return;
    }

    state.currentIndex = stepMatchIndex(state.currentIndex, state.matches.length, delta);
    if (getActiveTab()?.documentId === tab.documentId) {
      renderBar(tab);
      onActiveMatchChanged(tab, state.matches[state.currentIndex]);
    }
  }

  function openForTab(tab) {
    if (!tab) {
      return;
    }
    const state = ensureSearchState(tab);
    const wasOpen = state.open;
    state.open = true;

    if (!wasOpen) {
      onVisibilityChanged?.(tab);
    }

    renderBar(tab);
    inputEl.focus();
    inputEl.select();

    if (
      state.query.trim().length > 0 &&
      (state.status !== "ready" || state.lastSearchedQuery !== state.query) &&
      !state.inFlight
    ) {
      void executeSearch(tab, state.query);
    }
  }

  function closeForTab(tab, { focusViewport = true } = {}) {
    if (!tab) {
      clear();
      return;
    }

    clearDebounce();
    clearSearchingDelay();

    const state = ensureSearchState(tab);
    const wasOpen = state.open;
    state.open = false;
    state.requestSeq += 1;
    resetMatches(state);

    if (getActiveTab()?.documentId === tab.documentId) {
      renderBar(tab);
      onMatchesUpdated(tab);
      if (wasOpen) {
        onVisibilityChanged?.(tab);
      }
      if (focusViewport) {
        onCloseFocusViewport?.();
      }
    }
  }

  function toggleForTab(tab) {
    if (!tab) {
      return;
    }
    if (tab.searchState?.open) {
      closeForTab(tab, { focusViewport: true });
    } else {
      openForTab(tab);
    }
  }

  function syncTab(tab) {
    if (
      debounceTimer !== null &&
      debounceTab &&
      debounceTab !== tab &&
      isTabOpen(debounceTab.documentId) &&
      debounceTab.searchState?.open
    ) {
      const pendingTab = debounceTab;
      clearDebounce();
      void executeSearch(pendingTab, pendingTab.searchState.query);
    }

    clearSearchingDelay();
    if (!tab || !tab.searchState?.open) {
      barEl.hidden = true;
      return;
    }
    renderBar(tab);
  }

  function clear() {
    clearDebounce();
    clearSearchingDelay();
    barEl.hidden = true;
    inputEl.value = "";
    countEl.textContent = "";
    prevBtnEl.disabled = true;
    nextBtnEl.disabled = true;
  }

  function isOpenForTab(tab) {
    return Boolean(tab?.searchState?.open);
  }

  function containsElement(el) {
    return Boolean(el && barEl.contains(el));
  }

  inputEl.addEventListener("input", () => {
    const active = getActiveTab();
    if (!active) {
      return;
    }
    const state = ensureSearchState(active);
    state.query = inputEl.value;
    scheduleSearch(active, state.query);
  });

  inputEl.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const active = getActiveTab();
      if (!active) {
        return;
      }
      stepMatch(active, event.shiftKey ? -1 : 1);
    }
  });

  prevBtnEl.addEventListener("click", () => {
    const active = getActiveTab();
    if (active) {
      stepMatch(active, -1);
    }
  });

  nextBtnEl.addEventListener("click", () => {
    const active = getActiveTab();
    if (active) {
      stepMatch(active, 1);
    }
  });

  closeBtnEl.addEventListener("click", () => {
    const active = getActiveTab();
    closeForTab(active, { focusViewport: true });
  });

  return {
    openForTab,
    closeForTab,
    toggleForTab,
    stepMatch,
    syncTab,
    clear,
    isOpenForTab,
    containsElement,
  };
}
