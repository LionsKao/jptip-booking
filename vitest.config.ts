import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            // Test-only binding so test/apply-migrations.ts can seed the D1
            // schema before each test file runs — not part of the real Worker.
            TEST_MIGRATIONS: migrations,
            // Pin a deterministic baseline instead of inheriting whatever
            // .dev.vars happens to have locally (same var wrangler dev
            // reads) — tests that need the bypass flip it themselves.
            ALLOW_ANY_OTP: 'false',
          },
        },
      }),
    ],
    test: {
      // Backend tests only — e2e/ is Playwright (browser specs, not vitest's).
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
