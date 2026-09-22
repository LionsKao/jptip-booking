import { env } from 'cloudflare:workers';
import { afterEach, it } from 'vitest';
import { fetchWorker } from './helpers';

afterEach(() => {
  env.ALLOW_ANY_OTP = 'false';
});

it('reports testMode false when ALLOW_ANY_OTP is unset (production baseline)', async ({ expect }) => {
  const res = await fetchWorker('/api/config');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ testMode: false });
});

it('reports testMode true when ALLOW_ANY_OTP=true', async ({ expect }) => {
  env.ALLOW_ANY_OTP = 'true';
  const res = await fetchWorker('/api/config');
  expect(await res.json()).toEqual({ testMode: true });
});
