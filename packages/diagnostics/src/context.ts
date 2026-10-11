import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DiagnosticContext, DiagnosticSafeMeta, DiagnosticSource } from "./types.ts";
import { truncateDiagnosticString } from "./privacy.ts";

const storage = new AsyncLocalStorage<DiagnosticContext>();

const CLIENT_ID_MAX = 64;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export function createCorrelationId(): string {
  return randomUUID();
}

export function createActionId(): string {
  return randomUUID();
}

/**
 * Optional client-supplied request id — never authoritative for correlation.
 * Returns undefined when missing or invalid.
 */
export function validateClientRequestId(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > CLIENT_ID_MAX) {
    return undefined;
  }
  if (!CLIENT_ID_PATTERN.test(trimmed)) {
    return undefined;
  }
  return truncateDiagnosticString(trimmed, CLIENT_ID_MAX);
}

export function createDiagnosticContext(input: {
  source: DiagnosticSource;
  correlationId?: string;
  actionId?: string;
  eventId?: string;
  actorId?: string;
  banId?: string;
  requestId?: string;
  attemptId?: string;
  telegramUpdateId?: number;
  telegramCallbackQueryId?: string;
  clientRequestId?: string;
}): DiagnosticContext {
  const context: {
    correlationId: string;
    source: DiagnosticSource;
    actionId?: string;
    eventId?: string;
    actorId?: string;
    banId?: string;
    requestId?: string;
    attemptId?: string;
    telegramUpdateId?: number;
    telegramCallbackQueryId?: string;
    clientRequestId?: string;
  } = {
    correlationId: input.correlationId ?? createCorrelationId(),
    source: input.source,
  };
  if (input.actionId !== undefined) context.actionId = input.actionId;
  if (input.eventId !== undefined) context.eventId = input.eventId;
  if (input.actorId !== undefined) context.actorId = input.actorId;
  if (input.banId !== undefined) context.banId = input.banId;
  if (input.requestId !== undefined) context.requestId = input.requestId;
  if (input.attemptId !== undefined) context.attemptId = input.attemptId;
  if (input.telegramUpdateId !== undefined) context.telegramUpdateId = input.telegramUpdateId;
  if (input.telegramCallbackQueryId !== undefined) {
    context.telegramCallbackQueryId = input.telegramCallbackQueryId;
  }
  if (input.clientRequestId !== undefined) context.clientRequestId = input.clientRequestId;
  return context;
}

export function getDiagnosticContext(): DiagnosticContext | undefined {
  return storage.getStore();
}

export function runWithDiagnosticContext<T>(context: DiagnosticContext, fn: () => T): T {
  return storage.run(context, fn);
}

export async function runWithDiagnosticContextAsync<T>(
  context: DiagnosticContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn);
}

/** Merge fields into the current context for the remainder of the async scope. */
export function bindDiagnosticContext(
  patch: Partial<Omit<DiagnosticContext, "correlationId" | "source">> & {
    source?: DiagnosticSource;
  },
): DiagnosticContext | undefined {
  const current = storage.getStore();
  if (!current) {
    return undefined;
  }
  const next: DiagnosticContext = {
    ...current,
    ...patch,
    correlationId: current.correlationId,
    source: patch.source ?? current.source,
  };
  storage.enterWith(next);
  return next;
}

/** Buffer of staged materializer outcomes for the active transaction. */
export type StagedMaterializerOutcome = Readonly<{
  eventName:
    | "status.materializer.created"
    | "status.materializer.reused"
    | "status.materializer.remapped"
    | "status.materializer.failed"
    | "status.materializer.started"
    | "status.priority.cleared";
  meta: DiagnosticSafeMeta;
}>;

type TxLocalState = {
  stagedMaterializer: StagedMaterializerOutcome[];
  transactionStartedAt: number;
};

const txLocal = new AsyncLocalStorage<TxLocalState>();

export function runWithTransactionDiagnosticsLocal<T>(fn: () => T): T {
  return txLocal.run({ stagedMaterializer: [], transactionStartedAt: Date.now() }, fn);
}

export async function runWithTransactionDiagnosticsLocalAsync<T>(
  fn: () => Promise<T>,
): Promise<T> {
  return txLocal.run({ stagedMaterializer: [], transactionStartedAt: Date.now() }, fn);
}

export function stageMaterializerOutcome(outcome: StagedMaterializerOutcome): void {
  const state = txLocal.getStore();
  if (state) {
    state.stagedMaterializer.push(outcome);
  }
}

export function takeStagedMaterializerOutcomes(): readonly StagedMaterializerOutcome[] {
  const state = txLocal.getStore();
  if (!state) {
    return [];
  }
  const copy = [...state.stagedMaterializer];
  state.stagedMaterializer.length = 0;
  return copy;
}

export function peekStagedMaterializerOutcomes(): readonly StagedMaterializerOutcome[] {
  const state = txLocal.getStore();
  return state ? [...state.stagedMaterializer] : [];
}

export function transactionLocalStartedAt(): number | undefined {
  return txLocal.getStore()?.transactionStartedAt;
}
