import type { DiagnosticClassification } from "./types.ts";

/**
 * Map typed PersistenceError codes to diagnostic classifications.
 * Prefer typed codes over free-form message parsing.
 */
export function classifyPersistenceError(
  code: string,
  message?: string,
): DiagnosticClassification {
  switch (code) {
    case "REVISION_CONFLICT":
      return "SESSION_CAS_CONFLICT";
    case "CHECK_PAIR_CONFLICT":
      return "SESSION_CAS_CONFLICT";
    case "INVARIANT": {
      const text = message ?? "";
      if (text.includes("Duplicate durable Status")) {
        return "STATUS_LOGICAL_DUPLICATE";
      }
      if (
        text.includes("Status ID remap") ||
        text.includes("Multiple Kernel Status Item IDs") ||
        text.includes("Refusing Status ID remap")
      ) {
        return "STATUS_ID_REMAP_FAILED";
      }
      if (text.includes("lock") || text.includes("Lock") || text.includes("held lock")) {
        return "LOCK_PLAN_VIOLATION";
      }
      if (text.includes("Ban mutation") || text.includes("ban field") || text.includes("Ban field")) {
        return "BAN_MUTATION_REJECTED";
      }
      return "PERSISTENCE_INVARIANT";
    }
    case "TRANSACTION_FAILED": {
      const text = (message ?? "").toLowerCase();
      if (text.includes("deadlock")) {
        return "PG_DEADLOCK";
      }
      return "PG_TRANSACTION_ROLLBACK";
    }
    case "MISSING_FACT":
    case "IDENTITY_REQUIRED":
    case "APPLIED_TRANSITION_REQUIRED":
      return "PERSISTENCE_INVARIANT";
    default:
      return "PERSISTENCE_FAILURE";
  }
}

export function classifyApplicationStatus(
  status: string,
  errorCode?: string | null,
): DiagnosticClassification {
  switch (status) {
    case "NOT_APPLIED":
      return "PRODUCT_GUARD_REJECTED";
    case "KERNEL_INVARIANT":
      return "KERNEL_INVARIANT";
    case "REVISION_CONFLICT":
      return "SESSION_CAS_CONFLICT";
    case "PERSISTENCE_ERROR":
      if (errorCode === "PERSISTENCE_INVARIANT") {
        return "PERSISTENCE_INVARIANT";
      }
      return "PERSISTENCE_FAILURE";
    case "INFRASTRUCTURE_ERROR":
      return "INFRASTRUCTURE_FAILURE";
    case "APPLIED":
      return "OK";
    default:
      return "INFRASTRUCTURE_FAILURE";
  }
}

export function classifyDriverError(error: unknown): DiagnosticClassification {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("deadlock")) {
    return "PG_DEADLOCK";
  }
  return "PG_TRANSACTION_ROLLBACK";
}
