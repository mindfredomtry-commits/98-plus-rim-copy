import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  beginDiagnosticCapture,
  createActionId,
  createCorrelationId,
  createDiagnosticContext,
  diagnosticLineLooksSensitive,
  emitDiagnostic,
  endDiagnosticCapture,
  runWithDiagnosticContext,
  runWithTransactionDiagnosticsLocal,
  sanitizeDiagnosticMeta,
  setDiagnosticSink,
  stageMaterializerOutcome,
  takeStagedMaterializerOutcomes,
  truncateDiagnosticString,
  validateClientRequestId,
  DIAGNOSTIC_RECORD_MAX_CHARS,
  DIAGNOSTIC_STRING_MAX,
} from "./index.ts";

describe("OBS-2 diagnostic core", () => {
  beforeEach(() => {
    beginDiagnosticCapture();
    setDiagnosticSink(() => undefined);
  });
  afterEach(() => {
    endDiagnosticCapture();
    setDiagnosticSink(null);
  });

  it("O1 creates unique correlation ids", () => {
    const a = createCorrelationId();
    const b = createCorrelationId();
    expect(a).not.toBe(b);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("O14 emitter failure does not throw to caller", () => {
    setDiagnosticSink(() => {
      throw new Error("sink broken");
    });
    expect(() =>
      emitDiagnostic({
        eventName: "request.received",
        correlationId: createCorrelationId(),
        source: "http",
      }),
    ).not.toThrow();
  });

  it("O17 strips forbidden and unknown meta fields", () => {
    const sanitized = sanitizeDiagnosticMeta({
      eventId: "E-20",
      errorMessage: "ok",
      ...({ banText: "secret ban", prompt: "user prompt" } as object),
    } as never);
    expect(sanitized.eventId).toBe("E-20");
    expect((sanitized as { banText?: string }).banText).toBeUndefined();
    expect(Object.keys(sanitized)).not.toContain("prompt");
  });

  it("O17 redacts sensitive substrings in strings", () => {
    const sanitized = sanitizeDiagnosticMeta({
      errorMessage: "Authorization bearer token leaked",
    });
    expect(sanitized.errorMessage).toBe("[redacted]");
  });

  it("O18 truncates long strings and bounds records", () => {
    const long = "x".repeat(DIAGNOSTIC_STRING_MAX + 50);
    expect(truncateDiagnosticString(long).length).toBeLessThanOrEqual(DIAGNOSTIC_STRING_MAX);
    const lines: string[] = [];
    setDiagnosticSink((line) => lines.push(line));
    emitDiagnostic({
      eventName: "request.received",
      correlationId: createCorrelationId(),
      source: "http",
      meta: {
        errorMessage: "y".repeat(DIAGNOSTIC_RECORD_MAX_CHARS),
      },
    });
    expect(lines[0]!.length).toBeLessThanOrEqual(DIAGNOSTIC_RECORD_MAX_CHARS + 8);
  });

  it("does not treat client request id as authoritative correlation", () => {
    expect(validateClientRequestId("client-1")).toBe("client-1");
    expect(validateClientRequestId("bad id with spaces")).toBeUndefined();
    expect(validateClientRequestId("x".repeat(100))).toBeUndefined();
    const ctx = createDiagnosticContext({
      source: "http",
      clientRequestId: "client-1",
    });
    expect(ctx.correlationId).not.toBe("client-1");
    expect(ctx.clientRequestId).toBe("client-1");
  });

  it("stages materializer outcomes until taken", () => {
    runWithTransactionDiagnosticsLocal(() => {
      stageMaterializerOutcome({
        eventName: "status.materializer.created",
        meta: { phase: "staged", durableItemId: "i1" },
      });
      expect(takeStagedMaterializerOutcomes()).toHaveLength(1);
      expect(takeStagedMaterializerOutcomes()).toHaveLength(0);
    });
  });

  it("propagates correlation through AsyncLocalStorage", () => {
    const correlationId = createCorrelationId();
    const actionId = createActionId();
    runWithDiagnosticContext(
      createDiagnosticContext({ source: "product", correlationId, actionId }),
      () => {
        emitDiagnostic({
          eventName: "product.event.received",
          source: "product",
          meta: { eventId: "E-15" },
        });
      },
    );
    const records = endDiagnosticCapture();
    beginDiagnosticCapture();
    expect(records[0]?.correlationId).toBe(correlationId);
    expect(records[0]?.meta.actionId).toBe(actionId);
    expect(records[0]?.meta.eventId).toBe("E-15");
  });

  it("O17 diagnostic lines do not look sensitive for normal events", () => {
    emitDiagnostic({
      eventName: "product.event.applied",
      correlationId: createCorrelationId(),
      source: "product",
      meta: { eventId: "E-20", pcsBefore: "NOTIFICATIONS.INCOMING_BAN", pcsAfter: "NOTIFICATIONS.STATUS" },
    });
    const records = endDiagnosticCapture();
    beginDiagnosticCapture();
    const line = JSON.stringify(records[0]);
    expect(diagnosticLineLooksSensitive(line)).toBe(false);
  });
});
