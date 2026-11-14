// Public surface of the brain. Implemented in this folder; the rest of the backend imports only from here.
//
//   decide               conversation -> what to do next (reply, escalate to the owner, or nothing)
//   polishOwnerAnswer    the owner's rough answer -> a customer ready reply plus a reusable fact
//   draftRecoveryTemplate, personalizeRecovery   wording for abandoned checkout reminders
//   testBrain            one small call to check the AI connection
//
// Files: llm.ts (providers), prompt.ts (what the model is told and the check on its answer),
// tone.ts (how the customer writes), style.ts (the owner's writing rules, enforced in code),
// mock.ts (deterministic stand in used when ACX_TEST_MODE=1).
export { decide } from './decide';
export { polishOwnerAnswer } from './polish';
export { draftRecoveryTemplate, personalizeRecovery, testBrain, type BrainTestResult, type RecoveryPerson } from './recovery';
export { LlmError, callJson, chooseProvider, type ProviderChoice, type ProviderName } from './llm';
export { finalizeParts, sanitizeReply, violations, type StyleContext } from './style';
export { analyzeTone, collapseElongation, mirrorPlan, profileTone, type MirrorPlan } from './tone';
