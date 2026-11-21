<script lang="ts">
  import type { RequestSummary } from '../lib/types.js';

  interface Props {
    /** The request as typed; null for the picks made without one. */
    text: string | null;
    /** How the request was read; null when it was not stored or cannot be read. */
    summary: RequestSummary | null;
    /** How many of this request's picks are on screen. */
    shown: number;
    /** How many of those are older titles added because too few recent ones matched (they carry a rule note). */
    older?: number;
    /** How many are close matches added because too few titles matched every word (they carry a rule note). */
    close?: number;
  }

  let { text, summary, shown, older = 0, close = 0 }: Props = $props();

  /**
   * "13 titles match, 10 in your list". The close matches and older picks added
   * when too few titles matched are not among the matches, so they are named
   * apart: "1 title matches and is in your list, plus 9 close matches".
   */
  function matchLine(matched: number, shown: number, older: number, close: number): string {
    const count = Math.max(0, shown - older - close);
    const total = matched === 1 ? '1 title matches' : `${matched.toLocaleString()} titles match`;
    const inList = count === 0 ? '' : count < matched ? `, ${count} in your list` : matched === 1 ? ' and is in your list' : ', all in your list';
    const added = [
      close > 0 ? `${close} close ${close === 1 ? 'match' : 'matches'}` : null,
      older > 0 ? `${older} older ${older === 1 ? 'pick' : 'picks'}` : null,
    ].filter((s): s is string => s !== null);
    const extra = added.length > 0 ? `, plus ${added.join(' and ')}` : '';
    return `${total}${inList}${extra}`;
  }
</script>

<section class="request-summary" aria-label={text ? `Picks for “${text}”` : 'Picks for your taste'}>
  {#if text}
    <h2 class="asked">“{text}”</h2>
  {:else}
    <h2 class="asked">Picked for your taste</h2>
  {/if}
  {#if summary}
    {#if summary.understood.length}
      <ul class="chips" aria-label="Understood as">
        {#each summary.understood as rule}<li class="chip">{rule}</li>{/each}
      </ul>
    {/if}
    {#if summary.matched > 0}<p class="count">{matchLine(summary.matched, shown, older, close)}</p>{/if}
    {#if summary.note}
      <p class="note" class:none={summary.matched === 0}>{summary.note}</p>
    {:else if summary.matched === 0}
      <p class="note none">Nothing in the library matches all of that.</p>
    {/if}
  {/if}
</section>

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
  .note { font-size: 0.76rem; color: #c5c5dd; line-height: 1.35; }
  .note.none { color: #e9728a; }
</style>
