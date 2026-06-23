import { defineConfig } from 'vitest/config';

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
        extends: true,
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
