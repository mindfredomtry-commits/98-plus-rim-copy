/**
 * Synthetic unit tests for the blind investigator (not integration evidence).
 */
import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_SCHEMA_VERSION, type DiagnosticRecord } from "./types.ts";
import { reconstructIncident } from "./reconstruct.ts";

function rec(
  correlationId: string,
  eventName: DiagnosticRecord["eventName"],
  meta: DiagnosticRecord["meta"] = {},
): DiagnosticRecord {
  return {
    timestamp: new Date().toISOString(),
    level: "info",
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    eventName,
    correlationId,
    source: "system",
    meta,
  };
}

describe("OBS-3 reconstructIncident (synthetic unit — not integration)", () => {
  it("returns INSUFFICIENT_EVIDENCE for empty capture", () => {
    const v = reconstructIncident([], "corr-x");
    expect(v.classification).toBe("INSUFFICIENT_EVIDENCE");
    expect(v.rootCauseEstablished).toBe(false);
  });

  it("identifies PRODUCT_GUARD_REJECTED from product.event.rejected", () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const v = reconstructIncident(
      [
        rec(id, "product.event.received", { eventId: "E-15" }),
        rec(id, "product.event.rejected", {
          eventId: "E-15",
          classification: "PRODUCT_GUARD_REJECTED",
          guardResult: "REJECTED",
        }),
      ],
      id,
    );
    expect(v.classification).toBe("PRODUCT_GUARD_REJECTED");
    expect(v.firstObservableBoundary).toBe("product.engine");
    expect(v.rootCauseEstablished).toBe(true);
  });

  it("identifies COMMIT then request.failed as response failure after durable success", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const v = reconstructIncident(
      [
        rec(id, "persistence.transaction.started"),
        rec(id, "persistence.transaction.committed", { phase: "committed" }),
        rec(id, "request.failed", { responseOutcome: "failed", persistenceOutcome: "COMMITTED" }),
      ],
      id,
    );
    expect(v.transactionOutcome).toBe("committed");
    expect(v.firstObservableBoundary).toBe("http.request");
    expect(v.rootCauseEstablished).toBe(false);
    expect(v.limitations.some((l) => l.includes("client receipt"))).toBe(true);
  });

  it("does not invent historical creator for STATUS_LOGICAL_DUPLICATE", () => {
    const id = "99999999-aaaa-bbbb-cccc-dddddddddddd";
    const v = reconstructIncident(
      [
        rec(id, "status.materializer.failed", {
          classification: "STATUS_LOGICAL_DUPLICATE",
          logicalStatusKey: "ban/OVERBOARD/RECEIVER",
        }),
        rec(id, "persistence.transaction.rolled_back", { phase: "rolled_back" }),
      ],
      id,
    );
    expect(v.classification).toBe("STATUS_LOGICAL_DUPLICATE");
    expect(v.transactionOutcome).toBe("rolled_back");
    expect(v.limitations.some((l) => l.includes("UNKNOWN"))).toBe(true);
  });
});
