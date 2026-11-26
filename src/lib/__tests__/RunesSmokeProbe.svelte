<script lang="ts">
  interface Props {
    value: number;
  }

  let { value }: Props = $props();
  const doubled = $derived(value * 2);
</script>

<span>{doubled}</span>
