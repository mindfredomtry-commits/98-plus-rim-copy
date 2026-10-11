import type { DiagnosticSafeMeta } from "./types.ts";

/** Maximum length for any string field emitted to diagnostics. */
export const DIAGNOSTIC_STRING_MAX = 128;

/** Maximum total JSON payload size (characters) for one record. */
export const DIAGNOSTIC_RECORD_MAX_CHARS = 4096;

const META_KEYS = new Set<keyof DiagnosticSafeMeta>([
  "actionId",
  "eventId",
  "eventName",
  "actorId",
  "banId",
  "requestId",
  "attemptId",
  "clientRequestId",
  "telegramUpdateId",
  "telegramCallbackQueryId",
  "callbackResultCode",
  "pcsBefore",
  "pcsAfter",
  "matrixRuleId",
  "matrixBranch",
  "kernelOutcome",
  "guardResult",
  "classification",
  "sessionRevisionBefore",
  "sessionRevisionAfter",
  "expectedRevision",
  "actualRevision",
  "effectTypes",
  "effectCount",
  "pendingOperationId",
  "banWriteCount",
  "itemWriteCount",
  "timerWriteCount",
  "pairWriteCount",
  "lockBanCount",
  "lockSessionCount",
  "lockPairCount",
  "lockTimerCount",
  "logicalStatusKey",
  "kernelItemId",
  "durableItemId",
  "durableStatusCount",
  "materializerCreatedCount",
  "materializerUpdatedCount",
  "materializerRemapCount",
  "phase",
  "transactionKind",
  "httpMethod",
  "httpPath",
  "httpStatus",
  "durationMs",
  "responseOutcome",
  "persistenceOutcome",
  "errorCode",
  "errorMessage",
  "storeKind",
]);

const FORBIDDEN_SUBSTRINGS = [
  "initdata",
  "init_data",
  "bot_token",
  "apitoken",
  "api_key",
  "authorization",
  "bearer ",
  "openai",
  "prompt",
  "bantext",
  "ban_text",
] as const;

export function truncateDiagnosticString(value: string, max = DIAGNOSTIC_STRING_MAX): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function sanitizeString(value: string): string {
  const clipped = truncateDiagnosticString(value);
  const lower = clipped.toLowerCase();
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(forbidden)) {
      return "[redacted]";
    }
  }
  return clipped;
}

/**
 * Strip unknown keys and coerce values to allowlisted safe shapes.
 * Never accepts arbitrary objects (Error, request, snapshot, traces).
 */
/** Drop keys whose values are `undefined` (exactOptionalPropertyTypes-safe). */
export function compactDiagnosticMeta(
  input: { [K in keyof DiagnosticSafeMeta]?: DiagnosticSafeMeta[K] | undefined },
): DiagnosticSafeMeta {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (raw !== undefined) {
      out[key] = raw;
    }
  }
  return sanitizeDiagnosticMeta(out as DiagnosticSafeMeta);
}

export function sanitizeDiagnosticMeta(input: DiagnosticSafeMeta | undefined): DiagnosticSafeMeta {
  if (input === undefined) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!META_KEYS.has(key as keyof DiagnosticSafeMeta) || raw === undefined) {
      continue;
    }
    if (typeof raw === "string") {
      out[key] = sanitizeString(raw);
      continue;
    }
    if (typeof raw === "number") {
      if (Number.isFinite(raw)) {
        out[key] = raw;
      }
      continue;
    }
    if (raw === null && key === "actualRevision") {
      out[key] = null;
      continue;
    }
    if (Array.isArray(raw) && key === "effectTypes") {
      out[key] = raw
        .filter((item): item is string => typeof item === "string")
        .slice(0, 32)
        .map((item) => sanitizeString(item));
      continue;
    }
  }
  return out as DiagnosticSafeMeta;
}

/** True if a serialized diagnostic line appears to contain forbidden content. */
export function diagnosticLineLooksSensitive(line: string): boolean {
  const lower = line.toLowerCase();
  return FORBIDDEN_SUBSTRINGS.some((item) => lower.includes(item));
}
