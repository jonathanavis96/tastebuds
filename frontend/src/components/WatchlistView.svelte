<script lang="ts">
  import type { WatchEvent } from '../lib/types.js';

  interface Props {
    items?: WatchEvent[];
    onOpen?: (item: WatchEvent) => void;
    onMarkWatched?: (titleId: number) => void;
  }

  let { items = [], onOpen = () => {}, onMarkWatched = () => {} }: Props = $props();

  function posterUrl(path: string | null | undefined): string {
    if (!path) return 'https://via.placeholder.com/100x150?text=?';
    return `https://image.tmdb.org/t/p/w92${path}`;
  }
</script>

<div class="list-view">
  {#if items.length === 0}
    <p class="empty">Your watchlist is empty.</p>
  {/if}
  {#each items as item}
    <button class="list-item" onclick={() => onOpen(item)} aria-label={`Details for ${item.title ?? 'title'}`}>
      <img src={posterUrl(item.poster_path)} alt={item.title ?? ''} />
      <div class="item-info">
        <span class="title">{item.title ?? 'Unknown'}</span>
        <span class="year">{item.year ?? ''}</span>
      </div>
      <span
        class="watched-btn"
        role="button"
        tabindex="0"
        onclick={(e) => { e.stopPropagation(); onMarkWatched(item.title_id); }}
        onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onMarkWatched(item.title_id); } }}
      >Mark Watched</span>
    </button>
  {/each}
</div>

<style>
  .list-view { padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem; }
  .list-item { display: flex; gap: 0.75rem; align-items: center; background: #16213e; border: 1px solid #21294a; border-radius: 10px; padding: 0.5rem; width: 100%; text-align: left; cursor: pointer; color: inherit; font: inherit; transition: border-color 0.12s; }
  .list-item:hover { border-color: #34406e; }
  .list-item img { width: 50px; border-radius: 4px; flex-shrink: 0; }
  .item-info { flex: 1; min-width: 0; }
  .title { display: block; font-weight: 600; color: #fff; font-size: 0.9rem; }
  .year { color: #888; font-size: 0.8rem; }
  .watched-btn { padding: 0.35rem 0.6rem; border-radius: 6px; border: 1px solid #444; background: transparent; color: #ccc; cursor: pointer; font-size: 0.75rem; white-space: nowrap; }
  .watched-btn:hover { border-color: #4ade80; color: #4ade80; }
  .empty { color: #888; text-align: center; padding: 2rem; }
</style>
