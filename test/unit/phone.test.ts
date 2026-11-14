import { describe, expect, it } from 'vitest';
import { fromApiNode, fromWebhook } from '../../src/shopify/checkouts';
import { normaliseShopDomain } from '../../src/shopify/client';
import { DIAL_CODES, maskPhone, toE164 } from '../../src/shopify/phone';

// Every number here is made up: UK 07700 900xxx, US 555 01xx and AU 0491 570 xxx are ranges
// reserved for fiction, the rest are obvious filler.
describe('toE164', () => {
  it('rebuilds UK numbers however they were typed', () => {
    expect(toE164('07700 900123', 'GB', 'GB')).toBe('+447700900123');
    expect(toE164('7700900123', 'GB', 'GB')).toBe('+447700900123');
    expect(toE164('(07700) 900-123', 'GB', 'GB')).toBe('+447700900123');
    expect(toE164('447700900123', 'GB', 'GB')).toBe('+447700900123');
    expect(toE164('+44 (0)7700 900123', 'GB', 'GB')).toBe('+447700900123');
    expect(toE164('0044 7700 900123', 'GB', 'GB')).toBe('+447700900123');
    expect(toE164('07700 900123', 'uk', 'GB')).toBe('+447700900123');
  });

  it('uses the address country, then the store default', () => {
    expect(toE164('6265550123', 'US', 'GB')).toBe('+16265550123');
    expect(toE164('1 (626) 555-0123', 'US', 'GB')).toBe('+16265550123');
    expect(toE164('0491 570 156', 'AU', 'GB')).toBe('+61491570156');
    expect(toE164('015112345678', 'DE', 'GB')).toBe('+4915112345678');
    expect(toE164('06 12 34 56 78', 'FR', 'GB')).toBe('+33612345678');
    expect(toE164('612 345 678', 'ES', 'GB')).toBe('+34612345678');
    expect(toE164('085 012 3456', 'IE', 'GB')).toBe('+353850123456');
    // No country on the address: the store's own country is assumed.
    expect(toE164('07700 900456', null, 'GB')).toBe('+447700900456');
    expect(toE164('07700 900456', '', 'GB')).toBe('+447700900456');
  });

  it('leaves international numbers on their own country', () => {
    expect(toE164('+4790000000', 'NO', 'GB')).toBe('+4790000000');
    expect(toE164('+44 7700 900123', 'PL', 'GB')).toBe('+447700900123');
    expect(toE164('+1 626 555 0123', 'GB', 'GB')).toBe('+16265550123');
    expect(toE164('+39 06 1234 5678', 'IT', 'GB')).toBe('+390612345678'); // Italy keeps its zero
  });

  it('handles trunk prefixes that are not a zero', () => {
    expect(toE164('8 912 345 67 89', 'RU', 'GB')).toBe('+79123456789');
    expect(toE164('06 30 123 4567', 'HU', 'GB')).toBe('+36301234567');
    expect(toE164('338 123 4567', 'IT', 'GB')).toBe('+393381234567');
  });

  it('returns null for anything that is not a real number', () => {
    for (const bad of ['', '   ', '12345', '555-555-SHIP', 'call me', '0000000000', '07700 9001', '07700 900123456', '+999 123 456 789', '+44 123']) {
      expect(toE164(bad, 'GB', 'GB'), bad).toBeNull();
    }
    expect(toE164(null, 'GB', 'GB')).toBeNull();
    expect(toE164(undefined, 'GB', 'GB')).toBeNull();
    expect(toE164('1265550123', 'US', 'GB')).toBeNull(); // US area codes never start with 1
    expect(toE164('07700 900123', 'ZZ', 'ZZ')).toBeNull(); // unknown country and unknown default
  });

  it('drops extensions', () => {
    expect(toE164('07700 900123 x12', 'GB', 'GB')).toBe('+447700900123');
  });

  it('has a dial code for every country Shopify can send', () => {
    expect(Object.keys(DIAL_CODES).length).toBeGreaterThan(235);
    for (const [iso, code] of Object.entries(DIAL_CODES)) {
      expect(iso).toMatch(/^[A-Z]{2}$/);
      expect(code).toMatch(/^[1-9]\d{0,2}$/);
    }
    expect(DIAL_CODES.GB).toBe('44');
    expect(DIAL_CODES.JE).toBe('44');
    expect(DIAL_CODES.CA).toBe('1');
  });
});

describe('maskPhone', () => {
  it('keeps only the last three digits', () => {
    expect(maskPhone('+447700900123')).toBe('+•••••••••123');
    expect(maskPhone('+447700900123')).not.toContain('7700');
    expect(maskPhone(null)).toBe('');
  });
});

describe('checkout normalising', () => {
  it('reads an Admin API node: shipping phone first, consent from the customer phone', () => {
    const c = fromApiNode({
      id: 'gid://shopify/AbandonedCheckout/9001', name: '#9001',
      abandonedCheckoutUrl: 'https://shop.example/1/checkouts/ac/abc123def/recover?key=k',
      createdAt: '2026-11-14T15:57:11Z', updatedAt: '2026-11-14T15:59:40Z', completedAt: null,
      totalPriceSet: { shopMoney: { amount: '499.0', currencyCode: 'GBP' }, presentmentMoney: { amount: '499.0', currencyCode: 'GBP' } },
      lineItems: { nodes: [{ title: 'Example kit', variantTitle: 'Black', quantity: 1 }] },
      shippingAddress: { firstName: 'Sam', phone: '07700 900123', countryCodeV2: 'GB' },
      billingAddress: { firstName: 'Samuel', phone: '6265550123', countryCodeV2: 'US' },
      customer: {
        id: 'gid://shopify/Customer/1', firstName: 'S',
        defaultEmailAddress: { emailAddress: 'Sam@Example.com', marketingState: 'NOT_SUBSCRIBED' },
        defaultPhoneNumber: { phoneNumber: '+447700900999', smsMarketingConsent: { state: 'NEVER_SUBSCRIBED' }, whatsAppMarketingConsent: { state: 'SUBSCRIBED' } },
      },
    }, 'GB');
    expect(c).toMatchObject({
      id: '9001', first_name: 'Sam', phone_e164: '+447700900123', country: 'GB', total: '499.00', currency: 'GBP',
      email: 'sam@example.com', consent_sms: true, consent_email: false, completed_at: null,
      items: [{ title: 'Example kit', quantity: 1 }],
    });
    expect(c.created_at_shop).toBe(Date.parse('2026-11-14T15:57:11Z'));
  });

  it('reads a webhook payload: token is the key, a bad shipping phone falls through to billing', () => {
    const c = fromWebhook({
      token: 'tok123', name: '#77', email: 'jo@example.com', total_price: '1299.00', currency: 'GBP', presentment_currency: 'EUR',
      created_at: '2026-11-14T10:00:00+00:00', updated_at: '2026-11-14T10:05:00+00:00', completed_at: null,
      abandoned_checkout_url: 'https://shop.example/1/checkouts/tok123/recover?key=s',
      buyer_accepts_sms_marketing: true, buyer_accepts_marketing: false,
      line_items: [{ title: 'Kit A', quantity: 2 }, { title: 'Charger', quantity: 1 }],
      shipping_address: { first_name: 'Jo', phone: '555-555-SHIP', country_code: 'DE' },
      billing_address: { first_name: 'Joanna', phone: '0151 12345678', country_code: 'DE' },
      customer: { first_name: 'J', phone: null },
    }, 'GB')!;
    expect(c).toMatchObject({
      id: 'tok123', token: 'tok123', first_name: 'Jo', phone_raw: '0151 12345678', phone_e164: '+4915112345678', country: 'DE',
      total: '1299.00', currency: 'EUR', consent_sms: true, consent_email: false,
    });
    expect(c.items).toHaveLength(2);
    expect(fromWebhook({ name: 'no key' }, 'GB')).toBeNull();
  });

  it('keeps the typed number when nothing normalises, so the owner can see why it was skipped', () => {
    const c = fromWebhook({ token: 't2', shipping_address: { phone: '12345', country_code: 'GB' } }, 'GB')!;
    expect(c.phone_raw).toBe('12345');
    expect(c.phone_e164).toBeNull();
  });
});

describe('normaliseShopDomain', () => {
  it('accepts the usual ways of pasting a store address', () => {
    expect(normaliseShopDomain('abc-123')).toBe('abc-123.myshopify.com');
    expect(normaliseShopDomain(' https://ABC-123.myshopify.com/admin ')).toBe('abc-123.myshopify.com');
    expect(normaliseShopDomain('https://admin.shopify.com/store/abc-123/settings/apps')).toBe('abc-123.myshopify.com');
    expect(normaliseShopDomain('acxebikes.com')).toBe('');
    expect(normaliseShopDomain('evil.example/abc.myshopify.com')).toBe('');
  });
});
