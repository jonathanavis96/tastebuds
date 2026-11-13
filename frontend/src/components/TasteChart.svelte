<script lang="ts">
  import { onMount } from 'svelte';
  import { getTasteChart } from '../lib/api.js';
  import { chartNotes, formatLift, radiusFor, spokePoint } from '../lib/tasteChart.js';
  import type { TasteChart } from '../lib/types.js';

  interface Props {
    profileId: number;
    profileName: string;
    isJoint: boolean;
    onClose: () => void;
  }

  let { profileId, profileName, isJoint, onClose }: Props = $props();

  let chart = $state<TasteChart | null>(null);
  let failed = $state(false);
  /** Spoke picked by tap, hover or keyboard: its numbers show under the chart. */
  let picked = $state<number | null>(null);
  let closeBtn = $state<HTMLButtonElement | null>(null);

  const SIZE = 320;
  const C = SIZE / 2;
  const R = 112;
  /** Person colours: first person the app accent, second a cool contrast; Together is a dashed light outline. */
  const COLOURS = ['#e94560', '#4cc9f0'];

  onMount(() => {
    closeBtn?.focus();
    getTasteChart(profileId)
      .then(c => { chart = c; })
      .catch(() => { failed = true; });
  });

  function colourOf(i: number, kind: string): string {
    return kind === 'together' ? '#f1f1f7' : COLOURS[i] ?? '#e94560';
  }

  function ring(r: number, n: number): string {
    return Array.from({ length: n }, (_, i) => spokePoint(i, n, r, C, R).join(',')).join(' ');
  }

  function shape(lifts: Array<number | null>, n: number): string {
    return lifts.map((l, i) => spokePoint(i, n, radiusFor(l), C, R).join(',')).join(' ');
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  function pickKey(e: KeyboardEvent, i: number) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picked = i; }
  }

  const title = $derived(isJoint ? 'Your tastes together' : `${profileName}'s taste`);
  const notes = $derived(chart ? chartNotes(chart) : []);
  const ratingTotal = $derived(chart?.series.find(s => s.kind === 'together')?.total ?? chart?.series[0]?.total ?? 0);
</script>

<svelte:window onkeydown={onKeydown} />

<div class="backdrop" onclick={onClose} role="presentation">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="taste-title" tabindex="-1" onclick={(e) => e.stopPropagation()}>
    <div class="head">
      <h2 id="taste-title">{title}</h2>
      <button class="close" bind:this={closeBtn} onclick={onClose} aria-label="Close taste chart">×</button>
    </div>

    {#if failed}
      <p class="empty">The taste chart didn't load. Close this and tap the profile again.</p>
    {:else if !chart}
      <p class="empty">Loading…</p>
    {:else if chart.axes.length === 0}
      <p class="empty">Rate a few more titles and the chart will appear here.</p>
    {:else}
      {@const n = chart.axes.length}
      <div class="body">
        <svg
          class="radar"
          viewBox="-44 -14 {SIZE + 88} {SIZE + 28}"
          role="img"
          aria-label="Radar chart of {title.toLowerCase()} across {chart.axes.join(', ')}"
        >
          {#each [0.25, 0.75, 1] as r}
            <polygon class="ring" points={ring(r, n)} />
          {/each}
          <polygon class="ring usual" points={ring(0.5, n)} />
          {#each chart.axes as _, i}
            {@const [x, y] = spokePoint(i, n, 1, C, R)}
            <line class="spoke" class:on={picked === i} x1={C} y1={C} x2={x} y2={y} />
          {/each}
          <g class="shapes">
            {#each chart.series as s, si}
              {@const col = colourOf(si, s.kind)}
              <polygon
                class="shape"
                class:together={s.kind === 'together'}
                points={shape(s.lifts, n)}
                style="--c: {col}"
              />
              {#each s.lifts as l, i}
                {@const [x, y] = spokePoint(i, n, radiusFor(l), C, R)}
                <circle class="dot" class:hollow={l == null} cx={x} cy={y} r={l == null ? 3.5 : 3} style="--c: {col}" />
              {/each}
            {/each}
          </g>
          {#each chart.axes as axis, i}
            {@const [x, y] = spokePoint(i, n, 1.2, C, R)}
            <text
              class="axis"
              class:on={picked === i}
              {x}
              {y}
              text-anchor={Math.abs(x - C) < 4 ? 'middle' : x > C ? 'start' : 'end'}
              dominant-baseline="middle"
              role="button"
              tabindex="0"
              aria-pressed={picked === i}
              onfocus={() => (picked = i)}
              onclick={() => (picked = i)}
              onmouseenter={() => (picked = i)}
              onkeydown={(e) => pickKey(e, i)}
            >{axis}</text>
          {/each}
        </svg>

        <div class="side">
          {#if chart.series.length > 1}
            <ul class="legend">
              {#each chart.series as s, si}
                <li><i class="swatch" class:together={s.kind === 'together'} style="--c: {colourOf(si, s.kind)}"></i>{s.kind === 'together' ? 'Together (rated as a pair)' : s.label}</li>
              {/each}
            </ul>
          {/if}

          <p class="detail" aria-live="polite">
            {#if picked != null}
              <strong>{chart.axes[picked]}</strong>
              {#each chart.series as s, si}
                <span class="detail-item" style="--c: {colourOf(si, s.kind)}">
                  {chart.series.length > 1 ? `${s.label} ` : ''}{formatLift(s.lifts[picked])}<span class="n"> ({s.counts[picked]} {s.counts[picked] === 1 ? 'title' : 'titles'})</span>
                </span>
              {/each}
            {:else}
              <span class="hint">Tap a genre for the numbers.</span>
            {/if}
          </p>

          {#if notes.length}
            <ul class="notes">
              {#each notes as line}<li>{line}</li>{/each}
            </ul>
          {/if}

          <p class="how">
            Further out means rated above {isJoint ? "that person's" : 'your'} usual; the bold ring is usual, the edge one star above.
            A hollow dot means no ratings in that genre yet. Built from {ratingTotal} ratings and “Not interested” taps; the genres are the ones that best split
            {isJoint ? 'your' : 'this household’s'} likes from dislikes.
          </p>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 50;
    background: rgba(6, 6, 18, 0.8);
    backdrop-filter: blur(3px);
    display: flex; align-items: flex-end; justify-content: center;
  }
  .sheet {
    width: 100%; max-width: 560px;
    max-height: 92vh; max-height: 92dvh;
    overflow-y: auto;
    background: #14142b;
    border: 1px solid #2a2a4a;
    border-bottom: none;
    border-radius: 18px 18px 0 0;
    padding: 0.85rem 1.1rem 1.3rem;
    box-shadow: 0 -8px 40px rgba(0,0,0,0.55);
    outline: none;
  }
  @media (min-width: 600px) {
    .backdrop { align-items: center; padding: 1.5rem; }
    .sheet { border-bottom: 1px solid #2a2a4a; border-radius: 16px; padding: 1rem 1.5rem 1.4rem; }
  }
  @media (min-width: 900px) {
    .sheet { max-width: 820px; }
    .body { display: grid; grid-template-columns: 430px 1fr; gap: 1.5rem; align-items: center; }
  }

  .head { display: flex; align-items: center; gap: 0.75rem; }
  h2 { font-size: 1.15rem; font-weight: 800; color: #fff; letter-spacing: -0.01em; }
  .close { margin-left: auto; width: 32px; height: 32px; border-radius: 50%; background: rgba(255,255,255,0.08); border: none; color: #ccc; font-size: 1.3rem; line-height: 1; cursor: pointer; }
  .close:hover { background: rgba(255,255,255,0.16); color: #fff; }
  .close:focus-visible, .axis:focus-visible { outline: 2px solid #e94560; outline-offset: 2px; }

  .empty { color: #9a9ab8; padding: 2rem 0.25rem; font-size: 0.9rem; }

  .radar { width: 100%; max-width: 430px; display: block; margin: 0.3rem auto 0; overflow: visible; }
  .ring { fill: none; stroke: #2a2a4a; stroke-width: 1; }
  .ring.usual { stroke: #5a5a82; stroke-width: 1.8; }
  .spoke { stroke: #2a2a4a; stroke-width: 1; }
  .spoke.on { stroke: #8a8ab0; }
  /* Centre of the chart in viewport units: the viewBox starts at (-44, -14), the centre is at (160, 160). */
  .shapes { transform-box: view-box; transform-origin: 204px 174px; animation: grow 0.45s cubic-bezier(.2,.8,.2,1); }
  @keyframes grow { from { transform: scale(0.4); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .shapes { animation: none; } }
  .shape { fill: var(--c); fill-opacity: 0.16; stroke: var(--c); stroke-width: 2.2; stroke-linejoin: round; }
  .shape.together { fill: none; stroke-dasharray: 6 5; stroke-width: 2; }
  .dot { fill: var(--c); }
  .dot.hollow { fill: #14142b; stroke: var(--c); stroke-width: 1.5; }
  .axis { fill: #b9b9d0; font-size: 12.5px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; }
  .axis:hover, .axis.on { fill: #fff; }

  .legend { list-style: none; display: flex; flex-wrap: wrap; gap: 0.4rem 1rem; font-size: 0.82rem; color: #cfcfe4; margin-top: 0.4rem; }
  @media (min-width: 900px) { .legend { flex-direction: column; } }
  .swatch { display: inline-block; width: 1.3em; height: 0; border-top: 3px solid var(--c); vertical-align: middle; margin-right: 0.4em; }
  .swatch.together { border-top-style: dashed; }

  .detail { margin-top: 0.7rem; min-height: 2.6em; font-size: 0.86rem; color: #cfcfe4; display: flex; flex-wrap: wrap; gap: 0.25rem 0.8rem; align-items: baseline; }
  .detail strong { color: #fff; }
  .detail-item { color: var(--c); font-weight: 600; }
  .detail .n { color: #6e6e92; font-weight: 400; font-size: 0.8em; }
  .hint { color: #6e6e92; }

  .notes { margin: 0.5rem 0 0 1.1rem; font-size: 0.88rem; line-height: 1.5; color: #e4e4f0; }
  .how { margin-top: 0.8rem; font-size: 0.74rem; line-height: 1.45; color: #7a7a9c; max-width: 60ch; }
</style>
