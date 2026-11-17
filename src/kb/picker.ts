// The product picker: one short line per product with its price and its link, built from the
// starter catalogue (seed/knowledge/products.md). The brain gets it in full whenever a customer is
// shopping, so a recommendation always carries a real price and a real link. Pure, no database.
import { splitSections } from './chunk';

export const PRODUCT_PICKER_ID = 'seed_product_picker';
export const PRODUCT_PICKER_TITLE = 'Product picker: every product with its price and link';

const field = (content: string, name: string): string | null => {
  const m = new RegExp(`^- ${name}: (.+)$`, 'm').exec(content);
  const v = m?.[1]?.trim();
  return v && !/^\(none/.test(v) ? v : null;
};

/** One line per product: name, price, collection, options, link. Products without a link are left out. */
export function buildProductPicker(productsMd: string): string {
  const lines: string[] = [];
  for (const section of splitSections(productsMd).sections) {
    const url = field(section.content, 'URL');
    if (!url) continue;
    // Two products share the title "ACX 1500w kit", so the handle the catalogue adds stays in the name.
    const name = section.title.trim();
    const price = (field(section.content, 'Price range') ?? '').replace(/\s*\(same price for every variant\)/, '');
    const collection = (field(section.content, 'Collections') ?? '').replace(/\s*\([^)]*\)/g, '');
    const options = field(section.content, 'Options');
    const bits = [`${name}: ${price || 'price on the product page'}`];
    if (collection) bits.push(`in ${collection}`);
    if (options && !/single variant/.test(options)) bits.push(`options ${options}`);
    lines.push(`${bits.join('. ')}. Link: ${url}`);
  }
  return [
    'Every product the shop sells, with its price and its link. Copy the link exactly as written here. Full details, what is included and fitting notes are in each product\'s own entry. An entry whose title ends in live prices wins on price.',
    '',
    ...lines,
  ].join('\n');
}
