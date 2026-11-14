// Bundles the TikTok mock (React 18 + the real Draft.js) into one self contained index.html.
// Run after changing src/app.jsx:  node test/e2e/mocks/tiktok/build.mjs
// The output is committed so the end to end test needs no build step.
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const result = await build({
  entryPoints: [join(here, 'src', 'app.jsx')],
  bundle: true, write: false, format: 'iife', minify: true, platform: 'browser', legalComments: 'none',
  loader: { '.jsx': 'jsx' },
  define: { 'process.env.NODE_ENV': '"production"', global: 'window' },
  logLevel: 'error',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

// What TikTok ships in the page: the logged in user and the A/B flags that pick the DM front end.
const appData = {
  __DEFAULT_SCOPE__: {
    'webapp.app-context': {
      region: 'GB', language: 'en',
      user: { uid: '7000000000000000001', uniqueId: 'acx.ebikes', nickName: 'ACX Ebikes' },
      abTestVersion: { parameters: { web_dm_im_react_sdk: { vid: 'v4' }, web_dm_flexible_drawer: { vid: 'v3' }, enable_dm_side_nav: { vid: 'v1' } } },
    },
  },
};

const css = `
body { margin: 0; font: 14px/1.4 system-ui, sans-serif; }
.layout { display: flex; height: 100vh; }
.left { width: 340px; border-right: 1px solid #ddd; display: flex; flex-direction: column; }
.list-header { padding: 12px; font-weight: 600; display: flex; gap: 8px; }
.list { flex: 1; overflow-y: auto; }
.requests-entry { height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; cursor: pointer; }
.item { display: flex; align-items: center; gap: 10px; height: 72px; padding: 0 12px; box-sizing: border-box; cursor: pointer; }
.item.selected { background: #f1f1f2; }
.avatar img, header img, .h img[data-e2e="chat-avatar"] { width: 32px; height: 32px; border-radius: 50%; background: #ccc; }
.info { flex: 1; min-width: 0; }
.info p { margin: 0; }
.extract { display: flex; gap: 8px; color: #666; }
.extract .preview { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.badge { background: #fe2c55; color: #fff; border-radius: 10px; padding: 0 6px; font-size: 12px; }
.chat { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.chat header { display: flex; align-items: center; gap: 8px; padding: 10px; border-bottom: 1px solid #ddd; }
.chat header p { margin: 0; }
.messages { flex: 1; overflow-y: auto; padding: 10px; }
.separator, .system { text-align: center; color: #888; font-size: 12px; margin: 8px 0; }
.h { display: flex; flex-direction: row; align-items: flex-end; gap: 8px; margin: 6px 0; }
.h.mine { flex-direction: row-reverse; }
.bubble { background: #f1f1f2; border-radius: 8px; padding: 6px 10px; max-width: 420px; white-space: pre-wrap; }
.bubble p { margin: 0; }
.card { width: 120px; height: 160px; background: #bbb; border-radius: 8px; }
.composer { display: flex; align-items: center; gap: 8px; padding: 10px; border-top: 1px solid #ddd; }
.input-area { flex: 1; display: flex; align-items: center; gap: 6px; background: #f1f1f2; border-radius: 8px; padding: 8px 10px; }
.editor { flex: 1; min-width: 0; position: relative; }
.public-DraftEditorPlaceholder-root { position: absolute; color: #999; pointer-events: none; }
.public-DraftEditor-content { min-height: 20px; outline: none; }
.send { cursor: pointer; color: #fe2c55; font-size: 20px; }
.stranger { padding: 14px; border-top: 1px solid #ddd; text-align: center; }
.stranger .buttons { display: flex; gap: 12px; justify-content: center; }
.stranger [role="button"] { cursor: pointer; padding: 6px 14px; border: 1px solid #ccc; border-radius: 6px; }
.toast { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); background: #222; color: #fff; padding: 10px 16px; border-radius: 6px; }
.captcha { position: fixed; inset: 20% 30%; background: #fff; border: 1px solid #999; padding: 30px; text-align: center; }
.empty { flex: 1; display: flex; align-items: center; justify-content: center; color: #888; }
`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Messages | TikTok (mock)</title>
<style>${css}</style>
</head>
<body>
<div id="app"></div>
<div id="portal"></div>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(appData)}</script>
<script>${js}</script>
</body>
</html>
`;
writeFileSync(join(here, 'index.html'), html);
console.log(`built index.html (${Math.round(html.length / 1024)} KB)`);
