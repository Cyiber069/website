import { describe, expect, it } from 'vitest';
import { asksAboutOrder, describeOrder, ukStock, workingDaysBetween } from '../../src/shopify/orders';

const DAY = 86_400_000;
const order = (o: Partial<Parameters<typeof describeOrder>[0]> = {}) => ({
  name: '#1043', createdAt: '2026-11-16T10:00:00Z', cancelledAt: null, email: 'sam@example.com', phone: '+447700900123',
  displayFulfillmentStatus: 'UNFULFILLED',
  lineItems: { nodes: [{ title: 'ACX 2000w bundle', variantTitle: '29 / Sw900 / 20ah' }] },
  fulfillments: [], ...o,
});

describe('order questions', () => {
  it('spots a customer asking about an order they placed', () => {
    for (const t of ['where is my order', "where's my kit", 'any tracking?', 'has it been shipped yet', 'when will my bundle arrive', 'still not arrived', 'i ordered last week'])
      expect(asksAboutOrder(t)).toBe(true);
    for (const t of ['how do I order', 'is the 2000w good', 'what is your best bundle', 'does it fit a trek marlin'])
      expect(asksAboutOrder(t)).toBe(false);
  });

  it('knows which orders are UK stock', () => {
    expect(ukStock(order())).toBe(true);
    expect(ukStock(order({ lineItems: { nodes: [{ title: 'ACX 2000w bundle', variantTitle: '26 / Sw900 / 20ah' }] } }))).toBe(false);
    expect(ukStock(order({ lineItems: { nodes: [{ title: 'ACX 1500w bundle', variantTitle: '29 / Sw900 / 20ah' }] } }))).toBe(false);
  });

  it('counts working days without weekends', () => {
    const fri = Date.parse('2026-11-20T10:00:00Z');
    expect(workingDaysBetween(fri, fri + 3 * DAY)).toBe(1);   // Sat, Sun, Mon
  });

  it('sends tracking for a shipped order and names only the courier shown', () => {
    const now = Date.parse('2026-11-19T10:00:00Z');
    const note = describeOrder(order({ fulfillments: [{ createdAt: '2026-11-18T10:00:00Z', displayStatus: 'IN_TRANSIT', trackingInfo: [{ number: '1Z999', url: 'https://ups.com/t/1Z999', company: 'UPS' }] }] }), now);
    expect(note).toMatch(/tracking number 1Z999 with UPS/);
    expect(note).toMatch(/parcelpanel/);
    expect(note).not.toMatch(/team/);
  });

  it('says it is being prepared inside the window, and hands it over past it', () => {
    const inside = describeOrder(order(), Date.parse('2026-11-18T10:00:00Z'));
    expect(inside).toMatch(/being prepared/);
    expect(inside).toMatch(/Do not hand this to the team/);
    const late = describeOrder(order(), Date.parse('2026-11-23T10:00:00Z'));
    expect(late).toMatch(/past the usual window/);
    expect(late).toMatch(/order_status/);
    const factory = order({ lineItems: { nodes: [{ title: 'ACX 1000w bundle', variantTitle: '26 / Sw900 / 20ah' }] } });
    expect(describeOrder(factory, Date.parse('2026-11-30T10:00:00Z'))).toMatch(/2 to 3 weeks/);
    expect(describeOrder(factory, Date.parse('2026-11-30T10:00:00Z'))).toMatch(/being prepared/);
  });

  it('hands over stuck tracking and cancelled orders', () => {
    const now = Date.parse('2026-11-30T10:00:00Z');
    expect(describeOrder(order({ fulfillments: [{ createdAt: '2026-11-18T10:00:00Z', displayStatus: 'IN_TRANSIT', trackingInfo: [{ number: 'RM1', url: null, company: 'Royal Mail' }] }] }), now)).toMatch(/stuck/);
    expect(describeOrder(order({ cancelledAt: '2026-11-17T10:00:00Z' }), now)).toMatch(/cancelled/);
  });
});
