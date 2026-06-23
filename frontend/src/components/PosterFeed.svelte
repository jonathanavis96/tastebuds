<script lang="ts">
  import type { Recommendation } from '../lib/types.js';
  import { kindMeta } from '../lib/categories.js';

  interface Props {
    recommendations?: Recommendation[];
    onOpen?: (rec: Recommendation) => void;
  }

  let { recommendations = [], onOpen = () => {} }: Props = $props();

  function posterUrl(path: string | null | undefined): string {
    if (!path) return 'https://via.placeholder.com/342x513?text=No+Poster';
    return `https://image.tmdb.org/t/p/w342${path}`;
  }
</script>

<div class="poster-feed">
  {#if recommendations.length === 0}
    <p class="empty">No recommendations yet. Tap Generate!</p>
  {/if}
  {#each recommendations as rec (rec.id)}
    {@const meta = kindMeta(rec)}
    {@const badgeLabel = (rec.kind ?? 'core') === 'core' ? (rec.category || meta.label) : meta.label}
    <button
      class="poster-card"
      class:wildcard={rec.kind === 'wildcard'}
      class:adversarial={rec.kind === 'adversarial'}
      style="--kc:{meta.color}"
      onclick={() => onOpen(rec)}
      aria-label={`View details for ${rec.title ?? 'title'}`}
    >
      <div class="poster-img-wrap">
        <img src={posterUrl(rec.poster_path)} alt={rec.title ?? 'Poster'} loading="lazy" />
        <span class="badge" style="background:{meta.color};color:{meta.text}">{meta.icon} {badgeLabel}</span>
      </div>
      <div class="poster-info">
        <span class="title">{rec.title ?? 'Unknown'}</span>
        <span class="year">{rec.year ?? ''}</span>
        <span class="why">{rec.why_blurb}</span>
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
  .poster-card.wildcard { border-color: color-mix(in srgb, var(--kc) 45%, #21294a); }
  .poster-card.adversarial { border-color: color-mix(in srgb, var(--kc) 55%, #21294a); }

  .poster-img-wrap { position: relative; }
  .poster-img-wrap img { width: 100%; display: block; aspect-ratio: 2/3; object-fit: cover; }
  .badge {
    position: absolute; top: 6px; left: 6px;
    max-width: calc(100% - 12px);
    font-size: 0.64rem; font-weight: 800; letter-spacing: 0.01em;
    padding: 3px 8px; border-radius: 20px;
    box-shadow: 0 1px 5px rgba(0,0,0,0.45);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .poster-info { padding: 0.55rem; display: flex; flex-direction: column; }
  .title { font-weight: 700; font-size: 0.85rem; color: #fff; line-height: 1.2; }
  .year { font-size: 0.72rem; color: #888; margin-top: 1px; }
  .why { font-size: 0.74rem; color: #aab; margin-top: 5px; line-height: 1.35;
         display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .empty { color: #888; text-align: center; padding: 2rem; grid-column: 1 / -1; }
</style>
