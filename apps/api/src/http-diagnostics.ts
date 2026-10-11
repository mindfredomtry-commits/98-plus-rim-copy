import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createCorrelationId,
  createDiagnosticContext,
  emitDiagnostic,
  runWithDiagnosticContextAsync,
  validateClientRequestId,
  type DiagnosticContext,
} from "@98plus/diagnostics";

export const CORRELATION_HEADER = "X-Correlation-ID";

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim().length > 0) {
    return value[0].trim();
  }
  return null;
}

export function beginHttpDiagnostics(
  req: IncomingMessage,
  res: ServerResponse,
): DiagnosticContext {
  const correlationId = createCorrelationId();
  const clientRequestId = validateClientRequestId(
    headerValue(req, "x-client-request-id") ?? headerValue(req, "x-request-id"),
  );
  const context = createDiagnosticContext({
    source: "http",
    correlationId,
    ...(clientRequestId === undefined ? {} : { clientRequestId }),
  });
  try {
    res.setHeader(CORRELATION_HEADER, correlationId);
  } catch {
    // Headers may already be sent — do not fail the request.
  }
  return context;
}

/**
 * Write JSON and emit request.completed / request.failed for response lifecycle.
 * Persistence COMMIT is independent — callers must already have committed before this.
 */
export function jsonWithDiagnostics(
  res: ServerResponse,
  status: number,
  body: unknown,
  meta: Readonly<{
    httpMethod?: string;
    httpPath?: string;
    startedAtMs: number;
  }>,
): void {
  const payload = JSON.stringify(body);
  const durationMs = Math.max(0, Date.now() - meta.startedAtMs);
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    });
  } catch (error) {
    emitDiagnostic({
      eventName: "request.failed",
      source: "http",
      meta: {
        httpMethod: meta.httpMethod,
        httpPath: meta.httpPath,
        httpStatus: status,
        durationMs,
        responseOutcome: "failed",
        errorMessage: error instanceof Error ? error.message.slice(0, 128) : "writeHead failed",
      },
    });
    throw error;
  }
  res.end(payload, () => {
    emitDiagnostic({
      eventName: "request.completed",
      source: "http",
      meta: {
        httpMethod: meta.httpMethod,
        httpPath: meta.httpPath,
        httpStatus: status,
        durationMs: Math.max(0, Date.now() - meta.startedAtMs),
        responseOutcome: "completed",
      },
    });
  });
  res.once("error", (error) => {
    emitDiagnostic({
      eventName: "request.failed",
      source: "http",
      meta: {
        httpMethod: meta.httpMethod,
        httpPath: meta.httpPath,
        httpStatus: status,
        durationMs: Math.max(0, Date.now() - meta.startedAtMs),
        responseOutcome: "failed",
        errorMessage: error.message.slice(0, 128),
      },
    });
  });
}

/**
 * Simulate: persistence already committed; HTTP response write fails.
 * Used by OBS-2 tests only — does not alter Product semantics.
 */
export function emitCommittedThenResponseFailed(input: {
  correlationId: string;
  httpPath: string;
  errorMessage: string;
}): void {
  emitDiagnostic({
    eventName: "persistence.transaction.committed",
    source: "persistence",
    correlationId: input.correlationId,
    meta: { storeKind: "memory", phase: "committed", persistenceOutcome: "COMMITTED" },
  });
  emitDiagnostic({
    eventName: "request.failed",
    source: "http",
    correlationId: input.correlationId,
    meta: {
      httpPath: input.httpPath,
      responseOutcome: "failed",
      errorMessage: input.errorMessage.slice(0, 128),
      persistenceOutcome: "COMMITTED",
    },
  });
}

export async function withHttpDiagnostics<T>(
  req: IncomingMessage,
  res: ServerResponse,
  fn: (ctx: DiagnosticContext, startedAtMs: number) => Promise<T>,
): Promise<T> {
  const context = beginHttpDiagnostics(req, res);
  const startedAtMs = Date.now();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  return runWithDiagnosticContextAsync(context, async () => {
    emitDiagnostic({
      eventName: "request.received",
      source: "http",
      meta: {
        httpMethod: req.method ?? "GET",
        httpPath: url.pathname,
      },
    });
    try {
      return await fn(context, startedAtMs);
    } catch (error) {
      emitDiagnostic({
        eventName: "request.failed",
        source: "http",
        meta: {
          httpMethod: req.method ?? "GET",
          httpPath: url.pathname,
          durationMs: Math.max(0, Date.now() - startedAtMs),
          responseOutcome: "failed",
          errorMessage:
            error instanceof Error ? error.message.slice(0, 128) : "request handler failure",
        },
      });
      throw error;
    }
  });
}
