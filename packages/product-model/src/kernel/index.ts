export { reduce } from "./reduce.ts";
export {
  emptySnapshot,
  asInstant,
  counterAllocator,
  cloneSnapshot,
  validAskRimOrigin,
} from "./snapshot.ts";
export { applyEffects } from "./effects.ts";
export { evaluateRowGuard } from "./evaluate-guard.ts";
export type {
  AppliedRuleTrace,
  CompositionOrder,
  ExecutionContext,
  KernelError,
  KernelErrorCode,
  TransitionOutcome,
  TransitionResult,
} from "./types.ts";
