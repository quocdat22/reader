<script lang="ts">
  interface Props {
    direction?: "left" | "right";
    size?: number;
    className?: string;
  }

  let { direction = "left", size = 14, className = "" }: Props = $props();
  const arrowPath = $derived(
    direction === "left"
      ? "M11.5 7H2.75M6.25 3.5L2.75 7l3.5 3.5"
      : "M2.5 7h8.75M7.75 3.5L11.25 7l-3.5 3.5",
  );
</script>

<svg
  class={className || undefined}
  width={size}
  height={size}
  viewBox="0 0 14 14"
  fill="none"
  aria-hidden="true"
>
  <path
    d={arrowPath}
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>
