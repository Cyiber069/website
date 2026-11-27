// Live Roblox chart data from Roblox's public explore API. Nothing here is estimated or invented:
// "change" is the difference in live players between this fetch and the previous saved one.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { DATA_DIR } = require('./store');

const URL = 'https://apis.roblox.com/explore-api/v1/get-sorts?sessionId=4f1c2c1e-6d1b-4b7e-9a57-0d6f1f2a9c11';
const FILE = path.join(DATA_DIR, 'market.json');
const TTL = 10 * 60 * 1000;

let cache = null;
try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}

function getJson(url) {
  return fetch(url, { signal: AbortSignal.timeout(20000) }).then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).catch(() => new Promise((res, rej) => {
    // Fallback for machines where Node cannot reach the network directly (proxy setups).
    execFile('curl', ['-s', '-m', '25', url], { maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
      if (err) return rej(new Error('Could not reach Roblox'));
      try { res(JSON.parse(out)); } catch { rej(new Error('Roblox returned an unreadable response')); }
    });
  }));
}

async function get(force) {
  if (cache && !force && Date.now() - cache.fetchedAt < TTL) return cache;
  const raw = await getJson(URL);
  const prev = cache && cache.players ? cache : null;
  const players = {};
  const sorts = (raw.sorts || []).filter(s => Array.isArray(s.games) && s.games.length).map(s => ({
    id: String(s.sortId), name: String(s.sortDisplayName || s.sortId),
    games: s.games.map((g, i) => {
      players[g.universeId] = Number(g.playerCount) || 0;
      const before = prev ? prev.players[g.universeId] : undefined;
      const votes = (g.totalUpVotes || 0) + (g.totalDownVotes || 0);
      return { rank: i + 1, universeId: Number(g.universeId), placeId: Number(g.rootPlaceId), name: String(g.name || ''), players: Number(g.playerCount) || 0,
        change: before === undefined ? null : (Number(g.playerCount) || 0) - before,
        likePct: votes ? Math.round(100 * g.totalUpVotes / votes) : null, genre: String(g.genreL1 || '') };
    }),
  }));
  cache = { fetchedAt: Date.now(), comparedTo: prev ? prev.fetchedAt : null, sorts, players };
  fs.writeFileSync(FILE, JSON.stringify(cache));
  return cache;
}

const view = (c) => ({ fetchedAt: c.fetchedAt, comparedTo: c.comparedTo, sorts: c.sorts });
module.exports = { get, view };
