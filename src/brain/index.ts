// Public surface of the brain. Implemented in this folder; the rest of the backend imports only from here.
//
//   decide               conversation -> what to do next (reply, escalate to the owner, or nothing)
//   polishOwnerAnswer    the owner's rough answer -> a customer ready reply plus a reusable fact
//   extractDiscountRequest  does the customer want their own creator code, and which one
//   ownerGuidance, learnFromOwnerNote   the owner's note on an Urgent item: guidance for decide, and a reusable fact
//   draftRecoveryTemplate, personalizeRecovery   wording for abandoned checkout reminders
//   testBrain            one small call to check the AI connection
//   writeFollowUp        the one nudge after a product recommendation (src/sales), cheap model
//
// Files: llm.ts (providers), prompt.ts (what the model is told and the check on its answer),
// tone.ts (how the customer writes), style.ts (the owner's writing rules, enforced in code),
// mock.ts (deterministic stand in used when ACX_TEST_MODE=1).
export { decide } from './decide';
export { polishOwnerAnswer } from './polish';
export { OWNER_GUIDANCE_PREFIX, REPLY_NOW_NOTE, learnFromOwnerNote, mockNoteFact, noteSaysWait, ownerGuidance, type NoteFact } from './note';
export { extractDiscountRequest, mockDiscountRequest, validateDiscountRequest, type DiscountRequest } from './discount';
export { draftRecoveryTemplate, personalizeRecovery, testBrain, type BrainTestResult, type RecoveryPerson } from './recovery';
export { writeFollowUp, fallbackFollowUp, checkFollowUp, type FollowUpInput, type FollowUpResult } from './followup';
export { confidentHoldingLine, inventedLinks, isShopping, linksIn, productLink, soundsUnsure } from './rules';
export { LlmError, callJson, cheapChoice, chooseProvider, type ProviderChoice, type ProviderName } from './llm';
export { finalizeParts, sanitizeReply, violations, type StyleContext } from './style';
export { analyzeTone, collapseElongation, mirrorPlan, profileTone, type MirrorPlan } from './tone';
