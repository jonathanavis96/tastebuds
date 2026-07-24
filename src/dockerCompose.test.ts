import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Guards the container-binding fix: docker-compose.yml's `env_file: .env`
// forwards every var in .env into the container, including HOST — which the
// bare-Node dev docs tell people to set to 127.0.0.1. Left unguarded, that
// same value reaches the container and makes the app bind to its own
// loopback, so the published BIND_HOST port can never reach it even though
// the container looks healthy. `environment` must pin HOST to 0.0.0.0 so it
// always wins over whatever env_file forwards.
describe('docker-compose.yml container HOST binding', () => {
  const composePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'docker-compose.yml');
  const compose = readFileSync(composePath, 'utf-8');

  it('still forwards the whole .env file (env_file present)', () => {
    expect(compose).toMatch(/env_file:\s*\n\s*-\s*\.env/);
  });

  it('explicitly pins the in-container HOST to 0.0.0.0, overriding env_file', () => {
    // `environment:` entries always take precedence over the same key coming
    // from `env_file:` in docker-compose, regardless of block order.
    expect(compose).toMatch(/environment:\s*\n(?:.*\n)*?\s*-\s*HOST=0\.0\.0\.0/);
  });

  it('does not hardcode HOST=127.0.0.1 anywhere in the container environment block', () => {
    const envBlockMatch = compose.match(/environment:\s*\n((?:\s+[-#].*\n?)+)/);
    expect(envBlockMatch).not.toBeNull();
    expect(envBlockMatch![1]).not.toMatch(/HOST=127\.0\.0\.1/);
  });
});
