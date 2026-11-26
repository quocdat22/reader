import type { RecentFile } from "../ipc/types";

export const RECENTS_PAGE_SIZE = 10;

export type PageItem = number | "ellipsis";

/**
 * Filters recent files case-insensitively across `title` and full `path`.
 * Multiple whitespace-separated tokens must all match.
 */
export function filterRecentFiles(
  recentFiles: readonly RecentFile[],
  query: string,
): RecentFile[] {
  if (!Array.isArray(recentFiles)) {
    return [];
  }
  const normalized =
    typeof query === "string" ? query.trim().toLowerCase() : "";
  if (normalized.length === 0) {
    return [...recentFiles];
  }
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return recentFiles.filter((item) => {
    const haystack = `${item.title || ""}\n${item.path || ""}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/**
 * Computes page numbers and ellipsis markers for compact pagination controls.
 */
export function getVisiblePageItems(
  currentPage: number,
  totalPages: number,
): PageItem[] {
  if (totalPages <= 0) {
    return [];
  }
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  if (currentPage <= 3) {
    return [1, 2, 3, 4, "ellipsis", totalPages];
  }
  if (currentPage >= totalPages - 2) {
    return [
      1,
      "ellipsis",
      totalPages - 3,
      totalPages - 2,
      totalPages - 1,
      totalPages,
    ];
  }
  return [
    1,
    "ellipsis",
    currentPage - 1,
    currentPage,
    currentPage + 1,
    "ellipsis",
    totalPages,
  ];
}
