/**
 * Derives a human-readable tab/document title from embedded metadata or filename stem.
 */
export function deriveTitle(
  canonicalPath: string,
  metadataTitle?: string | null,
): string {
  if (typeof metadataTitle === "string" && metadataTitle.trim().length > 0) {
    return metadataTitle.trim();
  }
  const normalized = canonicalPath.replace(/\\/g, "/");
  const filename = normalized.split("/").pop() || canonicalPath;
  const stem = filename.replace(/\.pdf$/i, "");
  return stem.trim() || filename || "Untitled";
}

/**
 * Extracts the parent directory portion of a file path, preserving original separators.
 */
export function splitParentDirectory(fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "";
  }
  return fullPath.slice(0, lastSlash);
}
