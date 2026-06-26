<script lang="ts">
  // Ratings are on a 0.5–5 star scale (half-stars allowed). Each star has two hit
  // zones: tapping the left half sets x.5, the right half sets x.0.
  interface Props {
    rating?: number | null;
    onRate?: (r: number) => void;
  }

  let { rating = null, onRate = () => {} }: Props = $props();

  const stars = [1, 2, 3, 4, 5];
  // Fraction of star `n` that should appear filled (0, 0.5, or 1).
  function fill(n: number): number {
    if (rating == null) return 0;
    if (rating >= n) return 1;
    if (rating >= n - 0.5) return 0.5;
    return 0;
  }
</script>

<div class="rating-bar" role="group" aria-label="Rate this title">
  {#each stars as star}
    {@const f = fill(star)}
    <span class="star" style="--fill:{f * 100}%">
      <button
        class="half left"
        onclick={() => onRate(Math.max(1, star - 0.5))}
        aria-label={`Rate ${Math.max(1, star - 0.5)} stars`}
      ></button>
      <button
        class="half right"
        onclick={() => onRate(star)}
        aria-label={`Rate ${star} star${star > 1 ? 's' : ''}`}
      ></button>
      <span class="glyph" aria-hidden="true">★</span>
    </span>
  {/each}
</div>

<style>
  .rating-bar { display: flex; gap: 0.25rem; }
  .star { position: relative; display: inline-block; font-size: 1.4rem; line-height: 1; width: 1.4rem; height: 1.4rem; }
  /* Grey base star with a gold overlay clipped to the fill fraction. */
  .glyph { position: absolute; inset: 0; color: #555; pointer-events: none; }
  .glyph::after { content: '★'; position: absolute; inset: 0; color: #f5c518; overflow: hidden; width: var(--fill); }
  .half { position: absolute; top: 0; width: 50%; height: 100%; background: none; border: none; padding: 0; margin: 0; cursor: pointer; z-index: 1; }
  .half.left { left: 0; }
  .half.right { right: 0; }
</style>
