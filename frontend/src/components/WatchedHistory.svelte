<script lang="ts">
  import type { WatchEvent } from '../lib/types.js';

  interface Props {
    items?: WatchEvent[];
    onOpen?: (item: WatchEvent) => void;
  }

  let { items = [], onOpen = () => {} }: Props = $props();

  function posterUrl(path: string | null | undefined): string {
    if (!path) return 'https://via.placeholder.com/100x150?text=?';
    return `https://image.tmdb.org/t/p/w92${path}`;
  }
</script>

<div class="list-view">
  {#if items.length === 0}
    <p class="empty">Nothing watched yet.</p>
  {/if}
  {#each items as item}
    <button class="list-item" onclick={() => onOpen(item)} aria-label={`Details for ${item.title ?? 'title'}`}>
      <img src={posterUrl(item.poster_path)} alt={item.title ?? ''} />
      <div class="item-info">
        <span class="title">{item.title ?? 'Unknown'}</span>
        <span class="year">{item.year ?? ''}</span>
        {#if item.rating}<span class="rating">{'★'.repeat(item.rating)}</span>{/if}
        {#if item.watched_at}<span class="date">{new Date(item.watched_at).toLocaleDateString()}</span>{/if}
      </div>
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
  .year, .date { color: #888; font-size: 0.8rem; display: block; }
  .rating { color: #f5c518; font-size: 0.85rem; }
  .empty { color: #888; text-align: center; padding: 2rem; }
</style>
