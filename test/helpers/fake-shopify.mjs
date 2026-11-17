// A fake Shopify Admin API (and a push service) for the API tests. The Worker is pointed at it in test
// mode only (POST /api/test/shopify-base), never in production. With it the real Shopify client runs
// end to end (src/shopify/client.ts and discounts.ts), with every database read production makes.
//
//   POST /admin/api/<version>/graphql.json   the collections query and discountCodeBasicCreate
//                                            (a code in `taken` gets Shopify's TAKEN user error)
//   POST /admin/oauth/access_token           a client credentials token
//   POST /push                               a push service: 201
// Every request is recorded in `requests` ({ path, op }).
import { createServer } from 'node:http';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function startFakeShopify() {
  const state = { requests: [], taken: new Set() };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const path = (req.url || '').split('?')[0];
      if (path === '/push') { state.requests.push({ path, op: 'push' }); res.writeHead(201); res.end(); return; }
      if (path === '/admin/oauth/access_token') { state.requests.push({ path, op: 'token' }); json(res, 200, { access_token: 'shpat_fake_cc', expires_in: 86_399 }); return; }
      if (!/^\/admin\/api\/[^/]+\/graphql\.json$/.test(path)) { json(res, 404, { errors: 'Not Found' }); return; }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* empty */ }
      const query = String(body.query || '');
      if (/AcxDiscountCollections/.test(query)) {
        state.requests.push({ path, op: 'collections' });
        json(res, 200, { data: {
          kits: { nodes: [{ id: 'gid://shopify/Collection/1', title: 'Kits' }] },
          bundles: { nodes: [{ id: 'gid://shopify/Collection/2', title: 'Bundles' }] },
          batteries: { nodes: [{ id: 'gid://shopify/Collection/3', title: 'Batteries' }] },
        } });
        return;
      }
      if (/AcxDiscountCreate/.test(query)) {
        const code = String(body.variables?.basicCodeDiscount?.code || '');
        state.requests.push({ path, op: 'create', code });
        if (state.taken.has(code.toUpperCase())) {
          json(res, 200, { data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ field: ['basicCodeDiscount', 'code'], code: 'TAKEN', message: 'Code must be unique.' }] } } });
          return;
        }
        json(res, 200, { data: { discountCodeBasicCreate: { codeDiscountNode: { id: `gid://shopify/DiscountCodeNode/${code}`, codeDiscount: { status: 'ACTIVE', title: code } }, userErrors: [] } } });
        return;
      }
      state.requests.push({ path, op: 'other' });
      json(res, 200, { data: {} });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, stop: () => new Promise((r) => server.close(() => r())) };
}
