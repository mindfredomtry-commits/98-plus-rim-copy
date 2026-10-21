/**
 * OBS-3 — blind diagnostic reconstruction.
 * Operates only on allowlisted DiagnosticRecord JSON + schema semantics.
 * Must not receive scenario IDs, fixtures, or expected answers.
 */
import type {
  DiagnosticClassification,
  DiagnosticEventName,
  DiagnosticRecord,
} from "./types.ts";

export type ReconstructionBoundary =
  | "http.request"
  | "product.engine"
  | "persistence.cas"
  | "persistence.transaction"
  | "status.materializer"
  | "status.priority"
  | "telegram.callback"
  | "rim.request"
  | "unknown";

export type ReconstructionVerdict = Readonly<{
  correlationId: string;
  firstObservableBoundary: ReconstructionBoundary;
  classification: DiagnosticClassification | "INSUFFICIENT_EVIDENCE" | "OK";
  evidence: readonly DiagnosticEventName[];
  transactionOutcome: "committed" | "rolled_back" | "commit_uncertain" | "none" | "mixed";
  rootCauseEstablished: boolean;
  limitations: readonly string[];
  /** Safe summary for investigators — never includes scenario identity. */
  summary: string;
}>;

const FAILURE_EVENT_PRIORITY: readonly DiagnosticEventName[] = [
  "status.materializer.failed",
  "persistence.cas.conflict",
  "persistence.transaction.rolled_back",
  "persistence.transaction.commit_uncertain",
  "product.event.failed",
  "product.event.rejected",
  "telegram.callback.failed",
  "telegram.callback.duplicate",
  "rim.request.timeout",
  "rim.request.stale",
  "rim.request.failed",
  "request.failed",
];

function boundaryOf(eventName: DiagnosticEventName): ReconstructionBoundary {
  if (eventName.startsWith("request.")) return "http.request";
  if (eventName.startsWith("product.")) return "product.engine";
  if (eventName === "persistence.cas.conflict") return "persistence.cas";
  if (eventName.startsWith("persistence.")) return "persistence.transaction";
  if (eventName.startsWith("status.materializer.")) return "status.materializer";
  if (eventName === "status.priority.cleared") return "status.priority";
  if (eventName.startsWith("telegram.")) return "telegram.callback";
  if (eventName.startsWith("rim.")) return "rim.request";
  return "unknown";
}

function transactionOutcomeOf(
  records: readonly DiagnosticRecord[],
): ReconstructionVerdict["transactionOutcome"] {
  const committed = records.some((r) => r.eventName === "persistence.transaction.committed");
  const rolled = records.some((r) => r.eventName === "persistence.transaction.rolled_back");
  const uncertain = records.some(
    (r) => r.eventName === "persistence.transaction.commit_uncertain",
  );
  if (uncertain) return "commit_uncertain";
  if (committed && rolled) return "mixed";
  if (committed) return "committed";
  if (rolled) return "rolled_back";
  return "none";
}

function classificationFrom(record: DiagnosticRecord): DiagnosticClassification | "OK" {
  if (record.meta.classification) {
    return record.meta.classification;
  }
  switch (record.eventName) {
    case "product.event.rejected":
      return "PRODUCT_GUARD_REJECTED";
    case "product.event.failed":
      return "KERNEL_INVARIANT";
    case "persistence.cas.conflict":
      return "SESSION_CAS_CONFLICT";
    case "persistence.transaction.rolled_back":
      return "PG_TRANSACTION_ROLLBACK";
    case "telegram.callback.duplicate":
      return "TELEGRAM_CALLBACK_FAILURE";
    case "telegram.callback.failed":
      return "TELEGRAM_CALLBACK_FAILURE";
    case "rim.request.timeout":
      return "AI_TIMEOUT";
    case "rim.request.stale":
      return "STALE_AI_RESULT";
    case "rim.request.failed":
      return "INFRASTRUCTURE_FAILURE";
    case "status.priority.cleared":
      return "OK";
    case "status.materializer.remapped":
    case "status.materializer.created":
    case "status.materializer.reused":
    case "product.event.applied":
    case "persistence.transaction.committed":
      return "OK";
    default:
      return "INFRASTRUCTURE_FAILURE";
  }
}

function limitationsFor(
  first: DiagnosticRecord | undefined,
  records: readonly DiagnosticRecord[],
  tx: ReconstructionVerdict["transactionOutcome"],
): string[] {
  const limits: string[] = [];
  if (!first) {
    limits.push("No failure or success terminal event found in the capture window");
    return limits;
  }
  if (first.eventName === "status.materializer.failed") {
    limits.push(
      "Duplicate/remap failure is observed at materializer time; historical creator of prior durable rows is UNKNOWN",
    );
  }
  if (first.eventName === "persistence.cas.conflict") {
    limits.push(
      "CAS conflict proves revision mismatch; does not prove whether the client retried the same action",
    );
  }
  if (first.eventName === "telegram.callback.duplicate") {
    limits.push("Duplicate callback recognized; does not prove Telegram delivery of earlier callback");
  }
  if (
    first.eventName === "request.failed" &&
    records.some((r) => r.eventName === "persistence.transaction.committed")
  ) {
    limits.push(
      "Server observed response failure after COMMIT; client receipt is not proven by server-side evidence alone",
    );
  }
  if (tx === "commit_uncertain") {
    limits.push("COMMIT outcome ambiguous due to connection failure during commit");
  }
  if (first.eventName === "telegram.callback.received" && !records.some((r) => r.eventName.startsWith("telegram.callback.") && r.eventName !== "telegram.callback.received")) {
    limits.push("Callback received without applied/failed/duplicate terminal — incomplete Telegram continuation");
  }
  return limits;
}

/**
 * Blind investigator: given diagnostic records for one opaque correlationId,
 * identify the first observable failure/success boundary.
 */
export function reconstructIncident(
  records: readonly DiagnosticRecord[],
  correlationId: string,
): ReconstructionVerdict {
  const scoped = records.filter((r) => r.correlationId === correlationId);
  if (scoped.length === 0) {
    return {
      correlationId,
      firstObservableBoundary: "unknown",
      classification: "INSUFFICIENT_EVIDENCE",
      evidence: [],
      transactionOutcome: "none",
      rootCauseEstablished: false,
      limitations: ["No diagnostic records for correlationId"],
      summary: "INSUFFICIENT_EVIDENCE",
    };
  }

  const tx = transactionOutcomeOf(scoped);
  const evidence = scoped.map((r) => r.eventName);

  // Prefer earliest failure in capture order among prioritized failure events.
  let firstFailure: DiagnosticRecord | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (let i = 0; i < scoped.length; i += 1) {
    const record = scoped[i]!;
    const rank = FAILURE_EVENT_PRIORITY.indexOf(record.eventName);
    if (rank === -1) continue;
    // First occurrence in stream among failure types (stream order is primary).
    if (firstFailure === undefined) {
      firstFailure = record;
      bestRank = rank;
      continue;
    }
    // Keep the earliest in stream (lower index); only replace if somehow missing.
    void bestRank;
    break;
  }

  // RIM ownership terminals outrank intermediate persistence fencing noise in the
  // same correlation window (CAS/rollback during stale-result rejection).
  if (
    firstFailure &&
    (firstFailure.eventName.startsWith("persistence.transaction.") ||
      firstFailure.eventName === "persistence.cas.conflict")
  ) {
    const rimOwnership = scoped.find(
      (r) =>
        r.eventName === "rim.request.timeout" ||
        r.eventName === "rim.request.stale" ||
        r.eventName === "rim.request.failed",
    );
    if (rimOwnership) {
      firstFailure = rimOwnership;
    }
  }

  // Special case: COMMIT + later request.failed → response delivery after durable success.
  const committedIdx = scoped.findIndex((r) => r.eventName === "persistence.transaction.committed");
  const requestFailedIdx = scoped.findIndex((r) => r.eventName === "request.failed");
  if (
    committedIdx >= 0 &&
    requestFailedIdx > committedIdx &&
    (firstFailure === undefined ||
      firstFailure.eventName === "request.failed" ||
      scoped.indexOf(firstFailure) > committedIdx)
  ) {
    const reqFail = scoped[requestFailedIdx]!;
    return {
      correlationId,
      firstObservableBoundary: "http.request",
      classification: "INFRASTRUCTURE_FAILURE",
      evidence,
      transactionOutcome: "committed",
      rootCauseEstablished: false,
      limitations: limitationsFor(reqFail, scoped, "committed"),
      summary:
        "Persistence COMMITTED; HTTP response failed afterward. Database mutation succeeded; client receipt unproven.",
    };
  }

  // Success paths of interest (not failures): remap/create/reuse/priority clear.
  if (!firstFailure) {
    const rimCompleted = scoped.find((r) => r.eventName === "rim.request.completed");
    if (rimCompleted) {
      return {
        correlationId,
        firstObservableBoundary: "rim.request",
        classification: "OK",
        evidence,
        transactionOutcome: tx,
        rootCauseEstablished: true,
        limitations: [],
        summary: "RIM AI request completed under current ownership.",
      };
    }
    const remapped = scoped.find(
      (r) => r.eventName === "status.materializer.remapped" && r.meta.phase === "committed",
    );
    const created = scoped.filter(
      (r) => r.eventName === "status.materializer.created" && r.meta.phase === "committed",
    );
    const reused = scoped.filter(
      (r) => r.eventName === "status.materializer.reused" && r.meta.phase === "committed",
    );
    const priorityCleared = scoped.find(
      (r) => r.eventName === "status.priority.cleared" && r.meta.phase === "committed",
    );
    const applied = scoped.filter((r) => r.eventName === "product.event.applied");
    const telegramDupAbsent = scoped.some((r) => r.eventName === "telegram.callback.applied");

    if (priorityCleared) {
      return {
        correlationId,
        firstObservableBoundary: "status.priority",
        classification: "OK",
        evidence,
        transactionOutcome: tx,
        rootCauseEstablished: true,
        limitations: [],
        summary: "PROCESSED Status cleared from actionable priority during materialization.",
      };
    }
    if (remapped && created.length === 0 && reused.length >= 0) {
      return {
        correlationId,
        firstObservableBoundary: "status.materializer",
        classification: "OK",
        evidence,
        transactionOutcome: tx,
        rootCauseEstablished: true,
        limitations: [],
        summary: `Kernel→durable ID remap observed (${remapped.meta.kernelItemId ?? "?"} → ${remapped.meta.durableItemId ?? "?"}).`,
      };
    }
    if (created.length > 0 || reused.length > 0) {
      const createdRoles = created.map((r) => r.meta.logicalStatusKey).filter(Boolean);
      const reusedRoles = reused.map((r) => r.meta.logicalStatusKey).filter(Boolean);
      return {
        correlationId,
        firstObservableBoundary: "status.materializer",
        classification: "OK",
        evidence,
        transactionOutcome: tx,
        rootCauseEstablished: true,
        limitations: [],
        summary: `Status materializer: created=${created.length} (${createdRoles.join(";")}), reused=${reused.length} (${reusedRoles.join(";")}), remapped=${remapped ? 1 : 0}.`,
      };
    }
    if (applied.length >= 2) {
      const eventIds = applied.map((r) => r.meta.eventId).filter(Boolean);
      return {
        correlationId,
        firstObservableBoundary: "product.engine",
        classification: "OK",
        evidence,
        transactionOutcome: tx,
        rootCauseEstablished: true,
        limitations: [],
        summary: `Multiple Product actions applied under one correlation (${eventIds.join(",")}).`,
      };
    }
    if (applied.length === 1 || telegramDupAbsent) {
      return {
        correlationId,
        firstObservableBoundary: applied.length === 1 ? "product.engine" : "telegram.callback",
        classification: "OK",
        evidence,
        transactionOutcome: tx,
        rootCauseEstablished: true,
        limitations: [],
        summary: "Successful Product/Telegram terminal without failure events.",
      };
    }
    // Observation window with HTTP activity but no Telegram callback events.
    if (
      scoped.some((r) => r.eventName === "request.received" || r.eventName === "request.completed") &&
      !scoped.some((r) => r.eventName.startsWith("telegram.callback."))
    ) {
      return {
        correlationId,
        firstObservableBoundary: "telegram.callback",
        classification: "INSUFFICIENT_EVIDENCE",
        evidence,
        transactionOutcome: tx,
        rootCauseEstablished: false,
        limitations: [
          "No telegram.callback.* events in the observation window; does not prove Telegram lost a callback",
          "Does not infer successful message delivery from share initiation alone",
        ],
        summary: "No Telegram callback observed in local capture window.",
      };
    }
    return {
      correlationId,
      firstObservableBoundary: "unknown",
      classification: "INSUFFICIENT_EVIDENCE",
      evidence,
      transactionOutcome: tx,
      rootCauseEstablished: false,
      limitations: limitationsFor(undefined, scoped, tx),
      summary: "INSUFFICIENT_EVIDENCE",
    };
  }

  const classification = classificationFrom(firstFailure);
  const limits = limitationsFor(firstFailure, scoped, tx);
  const rootCauseEstablished =
    classification === "PRODUCT_GUARD_REJECTED" ||
    classification === "SESSION_CAS_CONFLICT" ||
    classification === "STATUS_LOGICAL_DUPLICATE" ||
    classification === "AI_TIMEOUT" ||
    classification === "STALE_AI_RESULT" ||
    firstFailure.eventName === "telegram.callback.duplicate";

  return {
    correlationId,
    firstObservableBoundary: boundaryOf(firstFailure.eventName),
    classification,
    evidence,
    transactionOutcome: tx,
    rootCauseEstablished,
    limitations: limits,
    summary: `${firstFailure.eventName} → ${classification}`,
  };
}

/** Filter capture to one correlation and reconstruct. */
export function reconstructFromCapture(
  records: readonly DiagnosticRecord[],
  correlationId: string,
): ReconstructionVerdict {
  return reconstructIncident(records, correlationId);
}
