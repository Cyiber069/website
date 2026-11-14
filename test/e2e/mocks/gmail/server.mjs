// Mock Gmail (test process side): holds the mailbox, serves the mock pages for https://mail.google.com/*
// through Playwright's context.route, and answers the unread Atom feed the way Gmail does.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const file = (name) => readFileSync(join(dir, name), 'utf8');

export const ACCOUNT = { name: 'ACX Support', email: 'support@acxebikes.example' };

const MIN = 60_000;
const div = (...lines) => lines.map((l) => `<div>${l}</div>`).join('');

/** A mailbox with one old conversation, two automated emails that must be ignored, and a promotion. */
function seed() {
  const now = Date.now();
  const me = { ...ACCOUNT };
  const mia = { name: 'Mia Old', email: 'mia.old@example.com' };
  return {
    account: ACCOUNT.email,
    name: ACCOUNT.name,
    seq: 0x100,
    rev: 0,
    sent: [],
    threads: [
      {
        id: '19a8000000000001', subject: 'Charger question', category: 'primary', unread: false, draft: null,
        messages: [
          { id: '19a8000000000001', from: mia, to: me, date: now - 50 * 60 * MIN, html: div('hi do you sell spare chargers'), unsub: false, legacy: true },
          { id: '19a8000000000002', from: me, to: mia, date: now - 49 * 60 * MIN, html: `${div('hi Mia yes we do they are on the site')}<div class="gmail_signature_prefix">--</div><div class="gmail_signature" data-smartmail="gmail_signature"><div>ACX Ebikes</div></div>`, unsub: false, legacy: true },
          { id: '19a8000000000003', from: mia, to: me, date: now - 48 * 60 * MIN, html: `${div('great thank you')}<br><div class="gmail_quote"><div class="gmail_attr">On Thu ACX Support wrote:</div><blockquote class="gmail_quote">hi Mia yes we do they are on the site</blockquote></div>`, unsub: false, legacy: true },
        ],
      },
      {
        // Skipped from the feed alone (sender address), so it is never opened and stays unread.
        id: '19a8000000000010', subject: 'Big winter sale starts now', category: 'primary', unread: true, draft: null,
        messages: [{ id: '19a8000000000010', from: { name: 'ACME Deals', email: 'newsletter@acme-mail.example' }, to: me, date: now - 30 * MIN, html: div('Save 40% this week only.', '<a href="https://acme-mail.example/u">Unsubscribe</a>'), unsub: true, legacy: true }],
      },
      {
        // An ordinary looking sender: only Gmail's Unsubscribe marker inside the opened email gives it away.
        id: '19a8000000000020', subject: 'Your weekly round up', category: 'primary', unread: true, draft: null,
        messages: [{ id: '19a8000000000020', from: { name: 'Deals Weekly', email: 'sam@dealsweekly.example' }, to: me, date: now - 20 * MIN, html: div('Hello, here is what happened this week.'), unsub: true, legacy: true }],
      },
      {
        id: '19a8000000000030', subject: '50% off tyres', category: 'promo', unread: true, draft: null,
        messages: [{ id: '19a8000000000030', from: { name: 'Tyre Shop', email: 'offers@tyres.example' }, to: me, date: now - 10 * MIN, html: div('Promotion'), unsub: true, legacy: true }],
      },
    ],
  };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plain = (html) => html.replace(/<div class="gmail_quote">[\s\S]*$/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** The Atom feed of unread Primary mail. message_id is the id of the newest message, not of the thread. */
function atomFeed(state) {
  const unread = state.threads.filter((t) => t.category === 'primary' && t.unread).sort((a, b) => b.messages.at(-1).date - a.messages.at(-1).date);
  const entries = unread.slice(0, 20).map((t) => {
    const m = t.messages.at(-1);
    const iso = new Date(m.date).toISOString().replace(/\.\d+Z$/, 'Z');
    return `<entry><title>${xml(t.subject)}</title><summary>${xml(plain(m.html).slice(0, 120))}</summary>` +
      `<link rel="alternate" href="https://mail.google.com/mail/u/0?account_id=${xml(state.account)}&amp;message_id=${m.id}&amp;view=conv&amp;extsrc=atom" type="text/html"/>` +
      `<modified>${iso}</modified><issued>${iso}</issued><id>tag:gmail.google.com,2004:${BigInt(`0x${m.id}`)}</id>` +
      `<author><name>${xml(m.from.name)}</name><email>${xml(m.from.email)}</email></author></entry>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?><feed version="0.3" xmlns="http://purl.org/atom/ns#">` +
    `<title>Gmail - Inbox for ${xml(state.account)}</title><tagline>New messages in your Gmail Inbox</tagline>` +
    `<fullcount>${unread.length}</fullcount><link rel="alternate" href="https://mail.google.com/mail/u/0" type="text/html"/>` +
    `<modified>${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</modified>${entries.join('')}</feed>`;
}

/**
 * Create the mock. Use `await context.route('https://mail.google.com/**', gmail.handle)`.
 *   gmail.state      the mailbox as last saved by the page (threads, sent)
 *   gmail.loggedOut  true: every page is the sign-in page and the feed answers 401
 *   gmail.feedDown   true: the feed answers 404 (forces the adapter's list scan)
 *   gmail.feedHits   number of feed requests answered
 */
export function createGmailMock() {
  const gmail = {
    state: seed(),
    loggedOut: false,
    feedDown: false,
    feedHits: 0,
    sent: () => gmail.state.sent,
    thread: (id) => gmail.state.threads.find((t) => t.id === id || t.messages.some((m) => m.id === id)) || null,
    async handle(route) {
      const req = route.request();
      const url = new URL(req.url());
      const send = (status, contentType, body) => route.fulfill({ status, contentType, body, headers: { 'cache-control': 'no-store' } });
      if (url.pathname === '/mock/state') {
        if (req.method() === 'POST') {
          if (process.env.MOCK_DEBUG) { const d = JSON.parse(req.postData() || '{}'); console.error('push', 'rev', d.rev, 'have', gmail.state.rev, 'sent', d.sent?.length, 'threads', d.threads?.map((t) => t.messages.length).join(',')); }
          const next = JSON.parse(req.postData() || '{}');
          if ((next.rev || 0) >= (gmail.state.rev || 0)) gmail.state = next; // ignore a save that was overtaken by a newer one
          return send(200, 'application/json', '{"ok":true}');
        }
        return send(200, 'application/json', JSON.stringify(gmail.state));
      }
      if (url.pathname === '/mock/app.js') return send(200, 'text/javascript; charset=utf-8', file('app.js'));
      if (url.pathname.includes('/feed/atom')) {
        gmail.feedHits++;
        if (gmail.loggedOut) return send(401, 'text/html', 'Unauthorized');
        if (gmail.feedDown) return send(404, 'text/html', 'Not found');
        // Only the Primary feed is modelled; the adapter must ask for exactly that one.
        if (!decodeURIComponent(url.pathname).endsWith('/feed/atom/^sq_ig_i_personal')) return send(404, 'text/html', 'Not found');
        return send(200, 'application/atom+xml; charset=UTF-8', atomFeed(gmail.state));
      }
      if (url.pathname === '/favicon.ico') return send(204, 'image/x-icon', '');
      if (gmail.loggedOut) return send(200, 'text/html; charset=utf-8', file('logged-out.html'));
      return send(200, 'text/html; charset=utf-8', file('index.html'));
    },
  };
  return gmail;
}
