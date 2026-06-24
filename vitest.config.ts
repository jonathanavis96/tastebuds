import { defineConfig } from 'vitest/config';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // The Svelte plugin is required so component (*.svelte) imports compile
        // under jsdom — without it vitest throws "Unknown file extension .svelte".
        plugins: [svelte({ preprocess: vitePreprocess({ script: true }) })],
        // Force Svelte's browser build so mount()/lifecycle work under jsdom
        // (otherwise it resolves index-server.js → "mount is not available on the server").
        resolve: { conditions: ['browser'] },
        test: {
          name: 'browser',
          include: ['frontend/**/*.test.ts'],
          environment: 'jsdom',
          setupFiles: ['./frontend/vitest.setup.ts'],
        },
      },
    ],
  },
});
