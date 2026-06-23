<script lang="ts">
  import type { Profile } from '../lib/types.js';

  interface Props {
    profiles: Profile[];
    activeProfileId: number | null;
    onSelect: (id: number) => void;
  }

  let { profiles = [], activeProfileId = null, onSelect }: Props = $props();
</script>

<div class="profile-switcher">
  {#each profiles as profile}
    <button
      class="profile-tab"
      class:active={activeProfileId === profile.id}
      onclick={() => onSelect(profile.id)}
      aria-pressed={activeProfileId === profile.id}
    >
      <span class="name">{profile.name}</span>
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
  .profile-tab.active {
    border-color: transparent;
    color: #fff;
    background: linear-gradient(135deg, #1f2f5a 0%, #16213e 100%);
    box-shadow: 0 0 0 1.5px #e94560 inset;
  }
</style>
