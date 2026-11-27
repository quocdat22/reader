<script lang="ts">
  import type { HighlightColor } from "../../lib/ipc/types";

  interface Props {
    color?: HighlightColor;
    size?: number;
  }

  let { color = "yellow", size = 15 }: Props = $props();

  const fillToken = $derived(`var(--hl-${color}-swatch)`);
  const borderToken = $derived(`var(--hl-${color}-swatch-border)`);
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  aria-hidden="true"
>
  <path
    d="M9.8 2.2L13.3 5.7L6.7 12.3L3.6 12.5L3.8 9.4L9.8 2.2Z"
    stroke="currentColor"
    stroke-width="1.35"
    stroke-linejoin="round"
  />
  <path
    d="M8.3 3.9L11.7 7.3"
    stroke="currentColor"
    stroke-width="1.25"
    stroke-linecap="round"
  />
  <rect
    x="2.5"
    y="13.4"
    width="11"
    height="2"
    rx="0.9"
    fill={fillToken}
    stroke={borderToken}
    stroke-width="0.5"
  />
</svg>
