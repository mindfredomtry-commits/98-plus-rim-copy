/**
 * OBS-3 test capture harness — same schema as production stdout sink.
 * Bounded in-memory only; never writes Product DB.
 */
import {
  beginDiagnosticCapture,
  endDiagnosticCapture,
  getCapturedDiagnostics,
  setDiagnosticSink,
  type DiagnosticRecord,
} from "./index.ts";

const CAPTURE_MAX_RECORDS = 2_000;

export type DiagnosticCaptureSession = Readonly<{
  /** Opaque correlation id for this incident (caller-supplied UUID). */
  correlationId: string;
  records: () => readonly DiagnosticRecord[];
  recordsFor: (correlationId: string) => readonly DiagnosticRecord[];
  stop: () => readonly DiagnosticRecord[];
}>;

/**
 * Begin capturing diagnostic JSON records (production schema).
 * Suppresses stdout via null sink; capture buffer still receives records.
 */
export function startDiagnosticCapture(correlationId: string): DiagnosticCaptureSession {
  beginDiagnosticCapture();
  setDiagnosticSink(() => undefined);
  return {
    correlationId,
    records: () => getCapturedDiagnostics().slice(0, CAPTURE_MAX_RECORDS),
    recordsFor: (id) =>
      getCapturedDiagnostics()
        .filter((r) => r.correlationId === id)
        .slice(0, CAPTURE_MAX_RECORDS),
    stop: () => {
      const all = endDiagnosticCapture();
      setDiagnosticSink(null);
      return all.slice(0, CAPTURE_MAX_RECORDS);
    },
  };
}

/** Strip capture to JSON-clone of allowlisted fields only (simulates log drain). */
export function serializeCaptureForInvestigator(
  records: readonly DiagnosticRecord[],
): DiagnosticRecord[] {
  return records.map((r) => JSON.parse(JSON.stringify(r)) as DiagnosticRecord);
}
