import {
  DIAGNOSTIC_SCHEMA_VERSION,
  type DiagnosticContext,
  type DiagnosticEventName,
  type DiagnosticLevel,
  type DiagnosticRecord,
  type DiagnosticSafeMeta,
  type DiagnosticSink,
  type DiagnosticSource,
} from "./types.ts";
import {
  compactDiagnosticMeta,
  DIAGNOSTIC_RECORD_MAX_CHARS,
  sanitizeDiagnosticMeta,
} from "./privacy.ts";
import { getDiagnosticContext } from "./context.ts";

const defaultSink: DiagnosticSink = (line) => {
  // Keep Vitest / unit suites quiet unless a test sink or capture is installed.
  if (process.env.VITEST === "true" || process.env.VITEST === "1") {
    return;
  }
  process.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
};

let sink: DiagnosticSink = defaultSink;

let captureBuffer: DiagnosticRecord[] | null = null;

/** Replace the process sink (tests / local harness). Failures must not break Product. */
export function setDiagnosticSink(next: DiagnosticSink | null): void {
  sink = next ?? defaultSink;
}

/** Capture emitted records in-memory for tests. Does not disable stdout unless sink replaced. */
export function beginDiagnosticCapture(): void {
  captureBuffer = [];
}

export function endDiagnosticCapture(): readonly DiagnosticRecord[] {
  const records = captureBuffer ?? [];
  captureBuffer = null;
  return records;
}

export function getCapturedDiagnostics(): readonly DiagnosticRecord[] {
  return captureBuffer ?? [];
}

function levelFor(eventName: DiagnosticEventName): DiagnosticLevel {
  if (
    eventName.endsWith(".failed") ||
    eventName === "persistence.cas.conflict" ||
    eventName === "persistence.transaction.rolled_back" ||
    eventName === "persistence.transaction.commit_uncertain"
  ) {
    return "error";
  }
  if (eventName.includes("duplicate") || eventName.includes("rejected") || eventName.includes("stale") || eventName.includes("timeout")) {
    return "warn";
  }
  return "info";
}

function mergeContextMeta(
  context: DiagnosticContext | undefined,
  meta: DiagnosticSafeMeta | undefined,
): DiagnosticSafeMeta {
  const fromContext: DiagnosticSafeMeta = {};
  const base: Record<string, unknown> = { ...fromContext };
  if (context?.actionId !== undefined) base.actionId = context.actionId;
  if (context?.eventId !== undefined) base.eventId = context.eventId;
  if (context?.actorId !== undefined) base.actorId = context.actorId;
  if (context?.banId !== undefined) base.banId = context.banId;
  if (context?.requestId !== undefined) base.requestId = context.requestId;
  if (context?.attemptId !== undefined) base.attemptId = context.attemptId;
  if (context?.telegramUpdateId !== undefined) base.telegramUpdateId = context.telegramUpdateId;
  if (context?.telegramCallbackQueryId !== undefined) {
    base.telegramCallbackQueryId = context.telegramCallbackQueryId;
  }
  if (context?.clientRequestId !== undefined) base.clientRequestId = context.clientRequestId;
  return sanitizeDiagnosticMeta({ ...(base as DiagnosticSafeMeta), ...(meta ?? {}) });
}

/**
 * Emit one structured diagnostic record as a single JSON line.
 * Never throws to callers — logging failure is isolated from Product outcomes.
 */
export function emitDiagnostic(input: {
  eventName: DiagnosticEventName;
  meta?: { [K in keyof DiagnosticSafeMeta]?: DiagnosticSafeMeta[K] | undefined };
  context?: DiagnosticContext;
  source?: DiagnosticSource;
  level?: DiagnosticLevel;
  correlationId?: string;
}): void {
  try {
    const context = input.context ?? getDiagnosticContext();
    const correlationId =
      input.correlationId ?? context?.correlationId ?? "00000000-0000-0000-0000-000000000000";
    const record: DiagnosticRecord = {
      timestamp: new Date().toISOString(),
      level: input.level ?? levelFor(input.eventName),
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      eventName: input.eventName,
      correlationId,
      source: input.source ?? context?.source ?? "system",
      meta: mergeContextMeta(context, input.meta === undefined ? undefined : compactDiagnosticMeta(input.meta)),
    };
    let line = JSON.stringify(record);
    if (line.length > DIAGNOSTIC_RECORD_MAX_CHARS) {
      const trimmed: DiagnosticRecord = {
        ...record,
        meta: compactDiagnosticMeta({
          errorCode: "DIAGNOSTIC_TRUNCATED",
          errorMessage: "diagnostic payload exceeded size bound",
          eventId: record.meta.eventId,
          actionId: record.meta.actionId,
        }),
      };
      line = JSON.stringify(trimmed);
    }
    if (captureBuffer) {
      captureBuffer.push(record);
    }
    sink(`${line}\n`);
  } catch {
    // Isolation: diagnostic failures must not affect Product / HTTP outcomes.
  }
}
