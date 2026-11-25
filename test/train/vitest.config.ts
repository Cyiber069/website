// The reply trainer (see README.md): builds the agent's real prompt for a set of customer chats, and runs
// the answers a model gave through the agent's real checks. Not part of the normal test run.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: new URL('../..', import.meta.url).pathname,
  plugins: [{ name: 'md-as-text', transform(code, id) { if (id.endsWith('.md')) return { code: `export default ${JSON.stringify(code)}`, map: null }; } }],
  test: { include: ['test/train/*.train.ts'], testTimeout: 120_000 },
});
