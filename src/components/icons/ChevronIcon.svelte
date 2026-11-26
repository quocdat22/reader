<script lang="ts">
  interface Props {
    direction?: "left" | "right";
    size?: number;
    className?: string;
  }

  let { direction = "right", size = 12, className = "" }: Props = $props();
  const pathData = $derived(
    direction === "left" ? "M7.5 2.5L4 6l3.5 3.5" : "M4.5 2.5L8 6l-3.5 3.5",
  );
</script>

<svg
  class={className || undefined}
  width={size}
  height={size}
  viewBox="0 0 12 12"
  fill="none"
  aria-hidden="true"
>
  <path
    d={pathData}
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>
