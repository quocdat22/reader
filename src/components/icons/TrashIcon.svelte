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
    d="M2.5 4.25h11"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
  />
  <path
    d="M6 4.25V2.9c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.35"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
  <path
    d="M4.25 4.25l.62 8.78c.04.55.5.97 1.05.97h4.16c.55 0 1.01-.42 1.05-.97l.62-8.78"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
  <path
    d="M6.75 7v4.25M9.25 7v4.25"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
  />
</svg>
