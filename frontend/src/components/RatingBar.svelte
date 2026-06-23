<script lang="ts">
  interface Props {
    rating?: number | null;
    onRate?: (r: number) => void;
  }

  let { rating = null, onRate = () => {} }: Props = $props();
</script>

<div class="rating-bar" role="group" aria-label="Rate this title">
  {#each [1, 2, 3, 4, 5] as star}
    <button
      class="star"
      class:filled={rating !== null && star <= rating}
      onclick={() => onRate(star)}
      aria-label={`Rate ${star} star${star > 1 ? 's' : ''}`}
    >★</button>
  {/each}
</div>

<style>
  .rating-bar { display: flex; gap: 0.25rem; }
  .star { background: none; border: none; font-size: 1.4rem; color: #555; cursor: pointer; padding: 0; }
  .star.filled { color: #f5c518; }
</style>
