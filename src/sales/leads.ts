// Lead stage tracking: after every decision the brain's sales read (stage and product) and any
// product link we queued are written onto the conversation. One small UPDATE by primary key.
import type { ConversationRow, SalesRead, SalesStage } from '../types';
import { clip, run } from '../lib/db';
import { productLink } from '../brain/rules';

const HOT: SalesStage[] = ['interested', 'ready'];

/**
 * The stage to store. A later small talk message ("ok cheers") reads as none or browsing, which must
 * not wipe a live lead: those two never overwrite interested or ready. Everything else does.
 */
export function nextStage(current: SalesStage | null | undefined, read: SalesStage | null | undefined): SalesStage | null {
  if (!read) return null;
  if ((read === 'none' || read === 'browsing') && current && HOT.includes(current)) return null;
  if (read === 'none' && current === 'browsing') return null;
  return read;
}

/**
 * Store what the brain made of the sale. `sentParts` are the parts we queued to the customer in this
 * turn (a reply or a holding line), used to remember the product link we sent. A follow up still
 * waiting is cancelled because the customer wrote again.
 */
export async function recordSalesRead(db: D1Database, conv: ConversationRow, read: SalesRead | null | undefined, sentParts: string[], now: number): Promise<void> {
  const stage = nextStage(conv.sales_stage ?? null, read?.stage ?? null);
  const link = sentParts.length ? productLink(sentParts.join(' ')) : null;
  const product = read?.product ? clip(read.product, 120) : null;
  const pendingFollowUp = conv.followup_outbox_id && (conv.followup_status === 'queued' || conv.followup_status === 'draft');
  if (pendingFollowUp) {
    await run(db, `UPDATE outbox SET status = 'cancelled', last_error = 'the customer wrote again' WHERE id = ? AND status IN ('pending', 'review')`, conv.followup_outbox_id!);
  }
  if (!stage && !link && !product) return;
  const hot = stage === 'interested' || stage === 'ready' ? 1 : 0;
  await run(
    db,
    `UPDATE conversations SET
       sales_stage = COALESCE(?, sales_stage),
       sales_stage_at = CASE WHEN ? IS NOT NULL THEN ? ELSE sales_stage_at END,
       sales_product = COALESCE(?, sales_product),
       interested_at = CASE WHEN ? = 1 THEN COALESCE(interested_at, ?) ELSE interested_at END,
       ready_at = CASE WHEN ? = 'ready' THEN COALESCE(ready_at, ?) ELSE ready_at END,
       sales_link = COALESCE(?, sales_link),
       sales_link_at = CASE WHEN ? IS NOT NULL THEN ? ELSE sales_link_at END
     WHERE id = ?`,
    stage, stage, now, product, hot, now, stage, now, link, link, now, conv.id,
  );
}
