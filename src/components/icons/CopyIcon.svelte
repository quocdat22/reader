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
  <rect
    x="2.25"
    y="4.75"
    width="8.25"
    height="9.5"
    rx="1.25"
    stroke="currentColor"
    stroke-width="1.4"
  />
  <path
    d="M5.5 4.75V3a1.25 1.25 0 0 1 1.25-1.25h6A1.25 1.25 0 0 1 14 3v7.25a1.25 1.25 0 0 1-1.25 1.25H10.5"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>
