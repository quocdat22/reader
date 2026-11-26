<script lang="ts">
  interface Props {
    size?: number;
  }

  let { size = 12 }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 12 12"
  fill="none"
  aria-hidden="true"
>
  <path
    d="M2.75 2.75l6.5 6.5M9.25 2.75l-6.5 6.5"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
  />
</svg>
