<script lang="ts">
  import type { WatchEvent } from '../lib/types.js';

  interface Props {
    items?: WatchEvent[];
    onOpen?: (item: WatchEvent) => void;
    onMarkWatched?: (titleId: number) => void;
  }

  let { items = [], onOpen = () => {}, onMarkWatched = () => {} }: Props = $props();

  function posterUrl(path: string | null | undefined): string {
    if (!path) return 'https://via.placeholder.com/342x513?text=No+Poster';
    return `https://image.tmdb.org/t/p/w342${path}`;
  }

  // created_at is when the title was added to the watchlist.
  function addedDate(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
</script>

<div class="poster-feed">
  {#if items.length === 0}
    <p class="empty">Your watchlist is empty.</p>
  {/if}
  {#each items as item (item.id)}
    <button
      class="poster-card"
      onclick={() => onOpen(item)}
      aria-label={`View details for ${item.title ?? 'title'}`}
    >
      <div class="poster-img-wrap">
        <img src={posterUrl(item.poster_path)} alt={item.title ?? 'Poster'} loading="lazy" />
        {#if addedDate(item.created_at)}
          <span class="badge">＋ Added {addedDate(item.created_at)}</span>
        {/if}
      </div>
      <div class="poster-info">
        <span class="title">{item.title ?? 'Unknown'}</span>
        <span class="year">{item.year ?? ''}</span>
        <span
          class="watched-btn"
          role="button"
          tabindex="0"
          onclick={(e) => { e.stopPropagation(); onMarkWatched(item.title_id); }}
          onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onMarkWatched(item.title_id); } }}
        >Mark Watched</span>
      </div>
    </button>
  {/each}
</div>

<style>
  .poster-feed {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    padding: 1rem;
  }
  @media (min-width: 640px) { .poster-feed { grid-template-columns: repeat(3, 1fr); } }
  @media (min-width: 900px) { .poster-feed { grid-template-columns: repeat(4, 1fr); } }

  .poster-card {
    display: flex; flex-direction: column;
    text-align: left;
    background: #16213e;
    border: 1px solid #21294a;
    border-radius: 12px;
    overflow: hidden;
    cursor: pointer;
    padding: 0;
    color: inherit;
    font: inherit;
    transition: transform 0.12s, border-color 0.12s, box-shadow 0.12s;
  }
  .poster-card:hover { transform: translateY(-2px); border-color: #34406e; box-shadow: 0 6px 18px rgba(0,0,0,0.35); }

  .poster-img-wrap { position: relative; }
  .poster-img-wrap img { width: 100%; display: block; aspect-ratio: 2/3; object-fit: cover; }
  .badge {
    position: absolute; top: 6px; left: 6px;
    max-width: calc(100% - 12px);
    font-size: 0.64rem; font-weight: 800; letter-spacing: 0.01em;
    padding: 3px 8px; border-radius: 20px;
    background: #0f3460; color: #fff;
    box-shadow: 0 1px 5px rgba(0,0,0,0.45);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .poster-info { padding: 0.55rem; display: flex; flex-direction: column; gap: 2px; }
  .title { font-weight: 700; font-size: 0.85rem; color: #fff; line-height: 1.2; }
  .year { font-size: 0.72rem; color: #888; }
  .watched-btn {
    margin-top: 0.5rem; padding: 0.4rem 0.6rem; border-radius: 6px;
    border: 1px solid #444; background: transparent; color: #ccc;
    cursor: pointer; font-size: 0.75rem; text-align: center;
  }
  .watched-btn:hover { border-color: #4ade80; color: #4ade80; }
  .empty { color: #888; text-align: center; padding: 2rem; grid-column: 1 / -1; }
</style>
