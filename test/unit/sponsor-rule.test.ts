import { describe, expect, it } from 'vitest';
import { sponsorCodeClaim, withoutSponsorCodeClaim } from '../../src/brain/rules';

describe('never say sponsors get discount codes', () => {
  it('spots the lines the owner hates', () => {
    expect(sponsorCodeClaim('Discount codes are only for our sponsored creators.')).toBe(true);
    expect(sponsorCodeClaim('Discount codes are only for our sponsored riders')).toBe(true);
    expect(sponsorCodeClaim('Our creators get £20 off codes')).toBe(true);
    expect(sponsorCodeClaim('Sponsored riders get a code for their followers')).toBe(true);
  });
  it('leaves normal replies alone', () => {
    expect(sponsorCodeClaim('Our prices are already on sale, so the site price is the best price')).toBe(false);
    expect(sponsorCodeClaim('Send me your TikTok and I will pass it to the team')).toBe(false);
    expect(sponsorCodeClaim('The 5000W does around 50 to 60 mph for experienced riders')).toBe(false);
  });
  it('removes only that sentence', () => {
    expect(withoutSponsorCodeClaim('No other codes I\'m afraid. Our prices are already on sale. Discount codes are only for our sponsored creators. Want me to check your battery size?'))
      .toBe('No other codes I\'m afraid. Our prices are already on sale. Want me to check your battery size?');
  });
});

import { promisesRefund, withoutRefundPromise } from '../../src/brain/rules';
describe('never promise a refund or a return', () => {
  it('spots promises', () => {
    for (const t of ["We'll refund you today", 'Your refund has been approved', 'Yes, you can return it within 14 days', "I'll send you a replacement", "You'll get a full refund", 'We can take it back'])
      expect(promisesRefund(t)).toBe(true);
  });
  it('leaves the holding reply and the policy wording alone', () => {
    for (const t of ["I'm passing it straight to the team so they can sort it properly", 'Returns are within 14 days if unused and unfitted', 'Can you send me your order number?'])
      expect(promisesRefund(t)).toBe(false);
    expect(withoutRefundPromise("I'm really sorry. We'll refund you today. I'm passing it to the team.")).toBe("I'm really sorry. I'm passing it to the team.");
  });
});
