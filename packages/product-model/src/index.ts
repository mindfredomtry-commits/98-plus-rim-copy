export { AUTHORITY_DOCUMENTS, PRODUCT_SPECIFICATION_SOURCE } from "./authority.ts";
export type { AuthorityDocument, AuthorityReference, ReferencedDefinition } from "./authority.ts";
export { contactPartnerIdsFromBans, isQualifyingAuthoritativeBan } from "./contacts.ts";
export type { BanParticipants } from "./contacts.ts";
export {
  APP_FULL_CLOSE_COMPOSITION,
  APP_FULL_CLOSE_FORBIDDEN_EFFECT_TYPES,
  APP_FULL_CLOSE_GLOBAL_EFFECTS,
  assertsNoDomainTimerMutation,
  composeAppFullCloseDeclaredEffects,
  composeDeclaredEffects,
  E42_DURATION_EXPIRED_EFFECTS,
} from "./composition.ts";
export type {
  GlobalLocalCompositionContract,
  RuleCompositionKind,
  RuleLayer,
} from "./composition.ts";
export type {
  DomainTimerMutatingEffectType,
  Effect,
  EffectType,
  ForbiddenDomainTimerCloseEffectType,
  TimerNotificationItemProcessCause,
  TimerNotificationItemProcessingEffectType,
} from "./effects.ts";
export {
  ABSENT_EVENT_IDS,
  assertCanonicalEventId,
  CANONICAL_EVENT_COUNT,
  CANONICAL_EVENT_DEFINITIONS,
  isAbsentEventId,
  isCanonicalEventId,
  isCanonicalEventName,
} from "./events.ts";
export type {
  AbsentEventId,
  CanonicalEvent,
  CanonicalEventDefinition,
  CanonicalEventId,
  CanonicalEventName,
  EventPayloadMap,
  EventSourceClass,
} from "./events.ts";
export { isTimerNotificationItem, markTimerNotificationItemProcessed } from "./entities.ts";
export type {
  AiOperation,
  Ban,
  BanAcceptance,
  BanDraft,
  CheckNotificationItem,
  CheckPair,
  CreateBanOrigin,
  DomainTimer,
  DomainTimerState,
  IncomingBanNotificationItem,
  NotificationItem,
  NotificationLifecycle,
  RelationshipBan,
  RelationshipContext,
  RelationshipContextData,
  RelationshipContextStatus,
  ReplyBanDraft,
  ReplySource,
  RimAiResult,
  RimChat,
  RimMessage,
  RimSuggestion,
  ShareOperation,
  ShareOperationStatus,
  StatusNotificationItem,
  ThreeSuggestions,
  TimerNotificationItem,
} from "./entities.ts";
export { lookupDomainTimer } from "./extended-state.ts";
export type {
  BootstrapState,
  EntityState,
  ExtendedState,
  PendingExternalEntry,
  PendingOperation,
  PendingOperationKind,
  PendingSendDraft,
  PriorityState,
  ProductSnapshot,
  RuntimeState,
} from "./extended-state.ts";
export type {
  Guard,
  MatrixEffectDeclaration,
  MatrixNextState,
  MatrixReference,
  MatrixResult,
  MatrixStateRef,
} from "./guards.ts";
export type { MatrixRowKind, MatrixScope, MatrixSource } from "./matrix/types.ts";
export type {
  AiRequestId,
  BanId,
  Brand,
  CheckPairId,
  ContextRequestId,
  DomainTimerId,
  DurationMinutes,
  NotificationItemId,
  OperationId,
  Percentage,
  RimChatId,
  ShareAttemptId,
  ShareLinkId,
  UserId,
} from "./ids.ts";
export {
  CREATE_BAN_MATRIX_ROWS,
  E43_ROWS,
  GLOBAL_AND_BOOTSTRAP_ROWS,
  MATRIX_BOOTSTRAP_RULE_COUNT,
  MATRIX_CONTRACT_ROWS,
  MATRIX_E43_RULE_COUNT,
  MATRIX_GLOBAL_RULE_COUNT,
  MATRIX_SPEC_GAP_COUNT,
  NOTIFICATIONS_MATRIX_ROWS,
  REPLY_BAN_MATRIX_ROWS,
  RIM_MATRIX_ROWS,
  countMatrixRowsByProductControlState,
  isAuthoritativeEventReference,
  isValidMatrixNextState,
  matrixRowIdentity,
} from "./matrix.ts";
export type { MatrixContractRow } from "./matrix.ts";
export {
  DOCUMENT_INCONSISTENCIES,
  EXPECTED_AUTHORITATIVE_ROW_IDS,
  EXPECTED_LOCAL_ROW_COUNTS,
  NONDETERMINISTIC_MATRIX_LINES,
} from "./matrix/expected-coverage.ts";
export {
  isValidBanText,
  isValidDurationMinutes,
  isValidPercentage,
  MAX_DURATION_MINUTES,
  MIN_DURATION_MINUTES,
  PENDING_EXTERNAL_ENTRY_TTL_MS,
  RELATIONSHIP_BAN_LIMIT,
  RIM_SUGGESTION_COUNT,
} from "./primitives.ts";
export type {
  BanStatus,
  CheckAnswer,
  CheckDerivedStatus,
  ConnectionState,
  DurationInput,
  Failure,
  Instant,
  Opaque,
  Role,
  ServerState,
  SessionStatus,
  ShareLinkFailureReason,
  ShareResult,
  ShareToken,
  TemplateContext,
} from "./primitives.ts";
export { reduce } from "./kernel/index.ts";
export {
  applyEffects,
  asInstant,
  cloneSnapshot,
  counterAllocator,
  emptySnapshot,
  evaluateRowGuard,
} from "./kernel/index.ts";
export type {
  AppliedRuleTrace,
  CompositionOrder,
  ExecutionContext,
  KernelError,
  KernelErrorCode,
  TransitionOutcome,
  TransitionResult,
} from "./kernel/index.ts";
export { IMPLEMENTATION_STAGE, STAGE_1_EXCLUDES, STAGE_2_EXCLUDES } from "./stage.ts";
export {
  ABSENT_CREATE_BAN_STATE_ID,
  isProductControlState,
  PRODUCT_CONTROL_STATE_COUNT,
  PRODUCT_CONTROL_STATE_DEFINITIONS,
  PRODUCT_CONTROL_STATE_IDS,
  PRODUCT_CONTROL_STATES,
} from "./states.ts";
export type {
  ProductControlState,
  ProductControlStateDefinition,
  ProductControlStateId,
  ProductSection,
} from "./states.ts";
