<script lang="ts">
  import type { Profile } from '../lib/types.js';

  interface Props {
    profiles: Profile[];
    activeProfileId: number | null;
    onSelect: (id: number) => void;
    /** Tapping the profile you are already on opens its taste chart. */
    onOpenTaste?: (id: number) => void;
  }

  let { profiles = [], activeProfileId = null, onSelect, onOpenTaste }: Props = $props();
</script>

<div class="profile-switcher">
  {#each profiles as profile}
    <button
      class="profile-tab"
      class:active={activeProfileId === profile.id}
      onclick={() => (activeProfileId === profile.id && onOpenTaste ? onOpenTaste(profile.id) : onSelect(profile.id))}
      aria-pressed={activeProfileId === profile.id}
      title={activeProfileId === profile.id && onOpenTaste ? 'Show taste chart' : undefined}
    >
      <span class="name">{profile.name}</span>
      {#if activeProfileId === profile.id && onOpenTaste}
        <svg class="taste-mark" viewBox="0 0 20 20" aria-label="taste chart">
          <polygon points="10,1.5 18,7.3 15,17.5 5,17.5 2,7.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
          <polygon points="10,5.5 14.5,9 12,14 7,13.2 6,8.6" fill="currentColor" opacity="0.55" />
        </svg>
      {/if}
    </button>
  {/each}
</div>

<style>
  .profile-switcher {
    display: flex;
    gap: 0.45rem;
    padding: 0.6rem 0.75rem 0.5rem;
    background: #1a1a2e;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .profile-tab {
    flex: 1;
    padding: 0.5rem 0.5rem;
    border: 1px solid #2a2a4a;
    border-radius: 12px;
    background: #161630;
    color: #b9b9d0;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }
  .profile-tab:hover { border-color: #3a3a5a; color: #fff; }
  .taste-mark { width: 0.95em; height: 0.95em; margin-left: 0.35em; vertical-align: -0.12em; color: #e94560; }
  .profile-tab.active {
    border-color: transparent;
    color: #fff;
    background: linear-gradient(135deg, #1f2f5a 0%, #16213e 100%);
    box-shadow: 0 0 0 1.5px #e94560 inset;
  }
</style>
