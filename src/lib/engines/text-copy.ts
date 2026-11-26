import type { NormalizedRect } from "../ipc/types";

export const SAME_LINE_Y_THRESHOLD = 0.55;

export interface CopiedTextFragment {
  readonly pageIndex: number;
  readonly text: string;
  readonly rect: NormalizedRect;
}

/**
 * Joins extracted selected text fragments into clean plain text using
 * normalized page geometry to insert spaces between same-line segments
 * and newlines across line or page breaks.
 */
export function formatCopiedFragments(
  fragments: readonly CopiedTextFragment[],
): string {
  if (!Array.isArray(fragments) || fragments.length === 0) {
    return "";
  }

  let output = "";
  let prev: CopiedTextFragment | null = null;

  for (const frag of fragments) {
    if (!frag || typeof frag.text !== "string" || frag.text.length === 0) {
      continue;
    }

    if (prev) {
      const samePage = frag.pageIndex === prev.pageIndex;
      const prevMidY = prev.rect.y + prev.rect.height / 2;
      const currMidY = frag.rect.y + frag.rect.height / 2;
      const maxHeight = Math.max(prev.rect.height, frag.rect.height);
      const sameLine =
        samePage &&
        maxHeight > 0 &&
        Math.abs(currMidY - prevMidY) <= maxHeight * SAME_LINE_Y_THRESHOLD;

      if (sameLine) {
        if (!/\s$/.test(prev.text) && !/^\s/.test(frag.text)) {
          output += " ";
        }
      } else if (!output.endsWith("\n")) {
        output += "\n";
      }
    }

    output += frag.text;
    prev = frag;
  }

  return output;
}
