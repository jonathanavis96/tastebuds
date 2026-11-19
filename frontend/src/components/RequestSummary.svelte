<script lang="ts">
  import type { Recommendation, RequestSummary } from '../lib/types.js';

  interface Props {
    /** The newest request's summary; null renders nothing (no request behind the feed). */
    summary: RequestSummary | null;
    /** The picks on screen; those carrying this request's text are the ones that answer it. */
    recommendations: Recommendation[];
  }

  let { summary, recommendations }: Props = $props();

  const text = $derived(summary?.text.trim() ?? '');
  const shown = $derived(recommendations.filter(r => (r.request_text ?? '').trim() === text).length);
  const earlier = $derived(recommendations.length - shown);

  function matchLine(matched: number, count: number): string {
    if (matched === 1) return '1 title matches';
    const total = matched.toLocaleString();
    return count >= matched ? `${total} titles match, all shown` : `${total} titles match, showing ${count}`;
  }
</script>

{#if summary}
  <section class="request-summary" aria-label="How your request was read">
    {#if text}<p class="asked">“{text}”</p>{/if}
    {#if summary.understood.length}
      <ul class="chips" aria-label="Understood as">
        {#each summary.understood as rule}<li class="chip">{rule}</li>{/each}
      </ul>
    {/if}
    {#if summary.matched === 0}
      <p class="count none">
        Nothing in the library matches all of that. Try loosening the year, or lower the IMDb filter.
        {#if earlier > 0}The picks below are from earlier requests.{/if}
      </p>
    {:else}
      <p class="count">{matchLine(summary.matched, shown)}</p>
    {/if}
    {#if summary.note}<p class="note">{summary.note}</p>{/if}
  </section>
{/if}

<style>
  .request-summary {
    display: flex; flex-direction: column; gap: 0.4rem;
    margin: 0.25rem 1rem 0; padding: 0.7rem 0.85rem;
    background: #14142b; border: 1px solid #2a2a4a; border-radius: 10px;
  }
  .asked { font-size: 0.88rem; font-weight: 700; color: #fff; line-height: 1.3; overflow-wrap: anywhere; }
  .chips { list-style: none; display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .chip { font-size: 0.68rem; font-weight: 600; background: #0f3460; color: #8ec5ff; padding: 2px 8px; border-radius: 20px; }
  .count { font-size: 0.76rem; color: #9a9ab8; line-height: 1.35; }
  .count.none { color: #e9728a; }
  .note { font-size: 0.76rem; color: #c5c5dd; line-height: 1.35; }
</style>
