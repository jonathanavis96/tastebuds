<script lang="ts">
  import { KIND_META, CATEGORY_BLURBS } from '../lib/categories.js';

  let open = $state(false);

  const kinds = [KIND_META.core, KIND_META.wildcard, KIND_META.adversarial];
  const flavours = Object.entries(CATEGORY_BLURBS);
</script>

<div class="legend">
  <button class="toggle" onclick={() => (open = !open)} aria-expanded={open}>
    {open ? '×' : '?'} What do the labels mean
  </button>

  {#if open}
    <div class="panel">
      <p class="section-label">Every set has 7 for-you picks, 2 surprises and 1 challenge:</p>
      {#each kinds as k}
        <div class="row" style="--kc:{k.color}">
          <span class="chip">{k.icon} {k.label}</span>
          <span class="desc">{k.blurb}</span>
        </div>
      {/each}

      <p class="section-label">Flavour tags on a pick:</p>
      {#each flavours as [name, blurb]}
        <div class="row flavour">
          <span class="chip flavour-chip">{name}</span>
          <span class="desc">{blurb}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .legend { padding: 0 1rem 0.5rem; }
  .toggle { background: none; border: none; color: #8aa; font-size: 0.78rem; cursor: pointer; padding: 0.2rem 0; text-decoration: underline; text-underline-offset: 2px; }
  .panel { margin-top: 0.5rem; background: #14142b; border: 1px solid #2a2a4a; border-radius: 10px; padding: 0.75rem; }
  .section-label { font-size: 0.72rem; color: #777; margin: 0.25rem 0 0.5rem; }
  .section-label:not(:first-child) { margin-top: 0.9rem; border-top: 1px solid #23233f; padding-top: 0.75rem; }
  .row { display: flex; gap: 0.6rem; align-items: baseline; margin-bottom: 0.5rem; }
  .chip { flex-shrink: 0; font-size: 0.68rem; font-weight: 700; padding: 2px 8px; border-radius: 20px; background: var(--kc, #0f3460); color: #0c0c1a; min-width: 92px; text-align: center; }
  .flavour-chip { background: #0f3460; color: #8ec5ff; }
  .desc { font-size: 0.76rem; color: #b9b9d0; line-height: 1.35; }
</style>
