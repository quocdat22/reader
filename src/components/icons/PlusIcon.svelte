<script lang="ts">
  interface Props {
    size?: number;
  }

  let { size = 14 }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  aria-hidden="true"
>
  <path
    d="M8 3.25v9.5M3.25 8h9.5"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
  />
</svg>
