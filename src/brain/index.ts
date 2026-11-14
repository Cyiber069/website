// Public surface of the brain. Implemented in this folder; the rest of the backend imports only from here.
import type { Decision, DecideInput, Env, PolishInput, PolishResult } from '../types';
import { MOCK_TONE, mockDecide, mockPolish } from './mock';

export async function decide(env: Env, input: DecideInput): Promise<Decision> {
  if (env.ACX_TEST_MODE === '1') return mockDecide(input, MOCK_TONE);
  throw new Error('brain.decide not implemented yet');
}

export async function polishOwnerAnswer(env: Env, input: PolishInput): Promise<PolishResult> {
  if (env.ACX_TEST_MODE === '1') return mockPolish(input);
  throw new Error('brain.polishOwnerAnswer not implemented yet');
}
