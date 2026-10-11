/**
 * OBS-2 — correlated production diagnostics (safe metadata only).
 * Schema is intentionally narrow; unknown fields are stripped by the emitter.
 */

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export type DiagnosticSource =
  | "http"
  | "telegram"
  | "product"
  | "persistence"
  | "materializer"
  | "rim"
  | "system";

/** Stable machine-readable event names (OBS-2 contract). */
export type DiagnosticEventName =
  | "request.received"
  | "request.completed"
  | "request.failed"
  | "product.event.received"
  | "product.event.applied"
  | "product.event.rejected"
  | "product.event.failed"
  | "persistence.transaction.started"
  | "persistence.transaction.committed"
  | "persistence.transaction.rolled_back"
  | "persistence.transaction.commit_uncertain"
  | "persistence.cas.conflict"
  | "status.materializer.started"
  | "status.materializer.created"
  | "status.materializer.reused"
  | "status.materializer.remapped"
  | "status.materializer.failed"
  | "status.priority.cleared"
  | "telegram.callback.received"
  | "telegram.callback.duplicate"
  | "telegram.callback.applied"
  | "telegram.callback.failed"
  | "rim.request.started"
  | "rim.request.completed"
  | "rim.request.timeout"
  | "rim.request.stale"
  | "rim.request.failed";

/** Internal classification — may be more specific than public API error codes. */
export type DiagnosticClassification =
  | "PRODUCT_GUARD_REJECTED"
  | "KERNEL_INVARIANT"
  | "SESSION_CAS_CONFLICT"
  | "BAN_MUTATION_REJECTED"
  | "STATUS_LOGICAL_DUPLICATE"
  | "STATUS_ID_REMAP_FAILED"
  | "LOCK_PLAN_VIOLATION"
  | "PG_DEADLOCK"
  | "PG_TRANSACTION_ROLLBACK"
  | "SHARE_CLAIM_CONFLICT"
  | "TELEGRAM_CALLBACK_FAILURE"
  | "AI_TIMEOUT"
  | "STALE_AI_RESULT"
  | "PERSISTENCE_INVARIANT"
  | "PERSISTENCE_FAILURE"
  | "INFRASTRUCTURE_FAILURE"
  | "OK";

/** Materializer / in-tx outcome phase — never imply durable create before COMMIT. */
export type DiagnosticPhase = "proposed" | "staged" | "committed" | "rolled_back" | "observed";

export type DiagnosticContext = Readonly<{
  correlationId: string;
  actionId?: string;
  source: DiagnosticSource;
  eventId?: string;
  actorId?: string;
  banId?: string;
  requestId?: string;
  attemptId?: string;
  telegramUpdateId?: number;
  telegramCallbackQueryId?: string;
  /** Non-authoritative client-supplied id (validated/length-limited). */
  clientRequestId?: string;
}>;

/** Allowlisted metadata keys only — see privacy.ts. */
export type DiagnosticSafeMeta = Readonly<{
  actionId?: string;
  eventId?: string;
  eventName?: string;
  actorId?: string;
  banId?: string;
  requestId?: string;
  attemptId?: string;
  clientRequestId?: string;
  telegramUpdateId?: number;
  telegramCallbackQueryId?: string;
  callbackResultCode?: string;
  pcsBefore?: string;
  pcsAfter?: string;
  matrixRuleId?: string;
  matrixBranch?: string;
  kernelOutcome?: string;
  guardResult?: string;
  classification?: DiagnosticClassification;
  sessionRevisionBefore?: number;
  sessionRevisionAfter?: number;
  expectedRevision?: number;
  actualRevision?: number | null;
  effectTypes?: readonly string[];
  effectCount?: number;
  pendingOperationId?: string;
  banWriteCount?: number;
  itemWriteCount?: number;
  timerWriteCount?: number;
  pairWriteCount?: number;
  lockBanCount?: number;
  lockSessionCount?: number;
  lockPairCount?: number;
  lockTimerCount?: number;
  logicalStatusKey?: string;
  kernelItemId?: string;
  durableItemId?: string;
  durableStatusCount?: number;
  materializerCreatedCount?: number;
  materializerUpdatedCount?: number;
  materializerRemapCount?: number;
  phase?: DiagnosticPhase;
  transactionKind?: string;
  httpMethod?: string;
  httpPath?: string;
  httpStatus?: number;
  durationMs?: number;
  responseOutcome?: "attempted" | "completed" | "failed" | "aborted";
  persistenceOutcome?: string;
  errorCode?: string;
  errorMessage?: string;
  storeKind?: "postgres" | "memory";
}>;

export type DiagnosticRecord = Readonly<{
  timestamp: string;
  level: DiagnosticLevel;
  schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
  eventName: DiagnosticEventName;
  correlationId: string;
  source: DiagnosticSource;
  meta: DiagnosticSafeMeta;
}>;

export type DiagnosticSink = (line: string) => void;
