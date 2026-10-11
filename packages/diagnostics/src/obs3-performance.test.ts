import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  createCorrelationId,
  emitDiagnostic,
  setDiagnosticSink,
  startDiagnosticCapture,
} from "./index.ts";

describe("OBS-3 diagnostic performance (local)", () => {
  it("measures null sink, capture sink, and JSON serialization overhead", () => {
    const n = 2_000;
    const id = createCorrelationId();

    setDiagnosticSink(() => undefined);
    const t0 = performance.now();
    for (let i = 0; i < n; i += 1) {
      emitDiagnostic({
        eventName: "request.received",
        correlationId: id,
        source: "http",
        meta: { httpPath: "/api/events" },
      });
    }
    const nullMs = performance.now() - t0;

    const capture = startDiagnosticCapture(id);
    const t1 = performance.now();
    for (let i = 0; i < n; i += 1) {
      emitDiagnostic({
        eventName: "product.event.received",
        correlationId: id,
        source: "product",
        meta: { eventId: "E-20", actionId: createCorrelationId() },
      });
    }
    const captureMs = performance.now() - t1;
    const records = capture.stop();
    const bytes = Buffer.byteLength(JSON.stringify(records), "utf8");

    let serializedBytes = 0;
    setDiagnosticSink((line) => {
      serializedBytes += Buffer.byteLength(line, "utf8");
    });
    // Force stdout-like serialization path even under VITEST by custom sink.
    const t2 = performance.now();
    for (let i = 0; i < n; i += 1) {
      emitDiagnostic({
        eventName: "persistence.transaction.committed",
        correlationId: id,
        source: "persistence",
        meta: { phase: "committed", storeKind: "memory" },
      });
    }
    const jsonMs = performance.now() - t2;
    setDiagnosticSink(null);

    // Soft bounds — flag only extreme regressions (not Railway latency claims).
    expect(nullMs / n).toBeLessThan(0.5);
    expect(captureMs / n).toBeLessThan(1);
    expect(jsonMs / n).toBeLessThan(1);
    expect(bytes).toBeGreaterThan(0);
    expect(serializedBytes).toBeGreaterThan(0);

    // Keep one structured summary line for the report (not thousands of events).
    // eslint-disable-next-line no-console
    console.info(
      JSON.stringify({
        sampleSize: n,
        nullSinkMeanUs: +((nullMs * 1000) / n).toFixed(2),
        captureSinkMeanUs: +((captureMs * 1000) / n).toFixed(2),
        jsonSinkMeanUs: +((jsonMs * 1000) / n).toFixed(2),
        captureTotalBytes: bytes,
        jsonTotalBytes: serializedBytes,
        approxEventsPerProductAction: 5,
      }),
    );
  });
});
