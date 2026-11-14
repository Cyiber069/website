// Starts the Worker locally (wrangler dev, test config, fresh database) for API and end to end tests.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)); });
  });
}

export async function startServer({ port } = {}) {
  const state = mkdtempSync(join(tmpdir(), 'acx-test-'));
  const usePort = port ?? (await freePort());
  const mig = { status: 0 };
  

  let log = '';
  const child = spawn(process.execPath, [wrangler, 'dev', '-c', 'wrangler.test.jsonc', '--port', String(usePort), '--ip', '127.0.0.1', '--persist-to', state, '--show-interactive-dev-session=false'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' },
  });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${usePort}`;

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${log.slice(-3000)}`);
    try {
      const r = await fetch(`${url}/api/session`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`wrangler dev did not start:\n${log.slice(-3000)}`); }
    await new Promise((r) => setTimeout(r, 400));
  }

  return {
    url,
    logs: () => log,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (child.exitCode === null) child.kill('SIGKILL');
      try { rmSync(state, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
