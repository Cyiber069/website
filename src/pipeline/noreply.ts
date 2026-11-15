// Cheap check for customer messages that need no answer at all, so no AI call is spent on them.
/**
 * True for a message that needs no answer: streak counting ("day 12", "day 13 until I get a free kit"),
 * or a lone acknowledgement made only of emoji, reactions or a sticker.
 */
export function noReplyNeeded(body: string, kind = 'text'): boolean {
  if (kind === 'sticker') return true;
  const text = body.trim().toLowerCase();
  if (!text) return false;
  // Only emoji, punctuation or spaces.
  if (/^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s!.?]+$/u.test(text)) return true;
  const streak = /^(day|dia|día|d)\s*#?\s*\d{1,3}\b(.*)$/u.exec(text);
  if (streak) {
    const rest = streak[2]!.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
    const words = rest ? rest.split(/\s+/) : [];
    // "day 12" alone, or with streak talk. "day 12 and my order still has not come" is a real question.
    if (words.length <= 3) return true;
    if (/\b(free|until|till|til|asking|texting|messaging|message|dm|streak|kit|bike|giveaway|win)\b/.test(rest) && !/\b(order|refund|delivery|delivered|parcel|tracking|broken|fault|help)\b/.test(rest)) return true;
  }
  return false;
}
