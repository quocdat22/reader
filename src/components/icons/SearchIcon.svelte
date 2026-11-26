<script lang="ts">
  interface Props {
    size?: number;
    className?: string;
  }

  let { size = 15, className = "" }: Props = $props();
</script>

<svg
  class={className || undefined}
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  aria-hidden="true"
>
  <circle cx="7.2" cy="7.2" r="4.4" stroke="currentColor" stroke-width="1.5" />
  <path
    d="M10.6 10.6L13.5 13.5"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
  />
</svg>
