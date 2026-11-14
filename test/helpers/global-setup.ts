// One local server for the whole API test run. Creates the owner and a paired device and hands
// their credentials to the tests through environment variables.
// @ts-expect-error plain JS helper
import { startServer } from './server.mjs';

export const OWNER_PASSWORD = 'correct horse battery';

export default async function setup() {
  const server = await startServer();
  const base: string = server.url;
  const setupRes = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: OWNER_PASSWORD }) });
  if (!setupRes.ok) throw new Error(`setup failed ${setupRes.status}`);
  const cookie = (setupRes.headers.get('set-cookie') ?? '').split(';')[0]!;
  const codeRes = await fetch(`${base}/api/devices/pair-code`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
  const { code } = (await codeRes.json()) as { code: string };
  const pairRes = await fetch(`${base}/api/agent/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Test laptop' }) });
  const { token } = (await pairRes.json()) as { token: string };

  process.env.ACX_TEST_URL = base;
  process.env.ACX_TEST_COOKIE = cookie;
  process.env.ACX_TEST_DEVICE = token;
  return async () => { await server.stop(); };
}
