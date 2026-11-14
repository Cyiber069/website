// Public surface of the brain. Implemented in this folder; the rest of the backend imports only from here.
import type { Decision, DecideInput, Env, PolishInput, PolishResult } from '../types';
import { getSettings } from '../lib/settings';
import { mockDecide, mockPolish } from './mock';
import { finalizeParts } from './style';
import { profileTone } from './tone';

export async function decide(env: Env, input: DecideInput): Promise<Decision> {
  const settings = await getSettings(env.DB);
  const tone = profileTone(input.history);
  if (env.ACX_TEST_MODE === '1') {
    const d = mockDecide(input, tone);
    d.parts = finalizeParts(d.parts, { voice: settings.voice, tone, channel: input.channel });
    return d;
  }
  throw new Error('brain.decide not implemented yet');
}

export async function polishOwnerAnswer(env: Env, input: PolishInput): Promise<PolishResult> {
  const settings = await getSettings(env.DB);
  const tone = profileTone(input.history);
  if (env.ACX_TEST_MODE === '1') {
    const r = mockPolish(input);
    r.parts = finalizeParts(r.parts, { voice: settings.voice, tone, channel: input.channel });
    return r;
  }
  throw new Error('brain.polishOwnerAnswer not implemented yet');
}
