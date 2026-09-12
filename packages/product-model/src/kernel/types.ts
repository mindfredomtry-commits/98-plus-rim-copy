import type { CanonicalEvent, CanonicalEventId } from "../events.ts";
import type { Effect } from "../effects.ts";
import type { ProductSnapshot } from "../extended-state.ts";
import type { MatrixEffectDeclaration, MatrixResult } from "../guards.ts";
import type { Instant } from "../primitives.ts";
import type { UserId } from "../ids.ts";
import type { MatrixRowKind, MatrixScope } from "../matrix/types.ts";
import type { ProductControlState } from "../states.ts";

export type ExecutionContext = Readonly<{
  now: Instant;
  currentUserId: UserId;
  allocateId: (kind: string) => string;
}>;

export type AppliedRuleTrace = Readonly<{
  identity: string;
  kind: MatrixRowKind;
  state: MatrixScope;
  eventId: CanonicalEventId | "LATE_RESULT";
  branch: string;
  result: MatrixResult;
  order: number;
}>;

export type KernelErrorCode =
  | "ABSENT_EVENT"
  | "MULTIPLE_BRANCHES_MATCHED"
  | "NO_BRANCH_MATCHED"
  | "NON_CANONICAL_NEXT_STATE"
  | "MISSING_REQUIRED_DATA";

export type KernelError = Readonly<{
  code: KernelErrorCode;
  message: string;
  identities: readonly string[];
}>;

export type TransitionOutcome = "APPLIED" | "UNDEFINED" | "KERNEL_INVARIANT";

export type CompositionOrder =
  | "LOCAL_ONLY"
  | "GLOBAL_ONLY"
  | "GLOBAL_THEN_LOCAL"
  | "BOOTSTRAP_ONLY"
  | "E43_ONLY"
  | "LOCAL_THEN_E43"
  | "UNDEFINED";

export type TransitionResult = Readonly<{
  outcome: TransitionOutcome;
  result: MatrixResult | "UNDEFINED";
  controlState: ProductControlState | null;
  snapshot: ProductSnapshot;
  effects: readonly Effect[];
  declaredEffects: readonly MatrixEffectDeclaration[];
  traces: readonly AppliedRuleTrace[];
  composition: CompositionOrder;
  error: KernelError | null;
}>;

export type ResolveInput = Readonly<{
  snapshot: ProductSnapshot;
  event: CanonicalEvent;
  eventId: CanonicalEventId;
  context: ExecutionContext;
}>;
