import type { UserId } from "@98plus/product-model";
import { PersistenceError } from "./errors.ts";
import type {
  RimOwnershipOperationKind,
  RimOwnershipPhase,
  RimOwnershipReleaseReason,
  RimProviderOwnership,
} from "./types.ts";

const OPERATION_KINDS = new Set<RimOwnershipOperationKind>(["initialization", "user-attempt"]);
const TOKEN_RELEASE_REASONS = new Set<RimOwnershipReleaseReason>(["completed", "owner-terminated"]);
const INVALIDATION_REASONS = new Set<RimOwnershipReleaseReason>(["chat-abandoned", "superseded"]);
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RimOwnershipSqlRow = {
  user_id: string;
  operation_kind: string;
  attempt_id: string;
  request_id: string | null;
  owner_token: string;
  leased_until: Date | string;
  released_at: Date | string | null;
  release_reason: string | null;
  lease_active: boolean;
  token_matches?: boolean;
};

export function assertRimOwnershipOperationKind(value: string): RimOwnershipOperationKind {
  if (!OPERATION_KINDS.has(value as RimOwnershipOperationKind)) {
    throw new PersistenceError("INVARIANT", "rim ownership operation_kind is not allowed");
  }
  return value as RimOwnershipOperationKind;
}

export function assertRimOwnershipAttemptId(value: string): string {
  if (value.trim() !== value || value.length === 0) {
    throw new PersistenceError("INVARIANT", "rim ownership attempt_id must be non-empty");
  }
  return value;
}

export function assertRimOwnershipRequestId(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (value.trim() !== value || value.length === 0) {
    throw new PersistenceError("INVARIANT", "rim ownership request_id must be null or non-empty");
  }
  return value;
}

export function assertRimOwnershipLeaseSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 3600) {
    throw new PersistenceError(
      "INVARIANT",
      "rim ownership lease must be a whole number of seconds",
    );
  }
  return value;
}

export function isRimOwnershipToken(value: string): boolean {
  return UUID_TEXT.test(value);
}

export function assertRimOwnershipTokenReleaseReason(
  value: string,
): "completed" | "owner-terminated" {
  if (!TOKEN_RELEASE_REASONS.has(value as RimOwnershipReleaseReason)) {
    throw new PersistenceError(
      "INVARIANT",
      "token release accepts only completed or owner-terminated",
    );
  }
  return value as "completed" | "owner-terminated";
}

export function assertRimOwnershipInvalidationReason(
  value: string,
): "chat-abandoned" | "superseded" {
  if (!INVALIDATION_REASONS.has(value as RimOwnershipReleaseReason)) {
    throw new PersistenceError(
      "INVARIANT",
      "ownership invalidation accepts only chat-abandoned or superseded",
    );
  }
  return value as "chat-abandoned" | "superseded";
}

export function ownershipFromSqlRow(row: RimOwnershipSqlRow): RimProviderOwnership {
  const operationKind = assertRimOwnershipOperationKind(row.operation_kind);
  const releaseReason = row.release_reason;
  if (
    releaseReason !== null &&
    releaseReason !== "completed" &&
    releaseReason !== "owner-terminated" &&
    releaseReason !== "chat-abandoned" &&
    releaseReason !== "superseded"
  ) {
    throw new PersistenceError("INVARIANT", "rim ownership release_reason is not allowed");
  }
  const released = row.released_at !== null;
  if (released !== (releaseReason !== null)) {
    throw new PersistenceError("INVARIANT", "rim ownership release columns disagree");
  }
  return {
    userId: row.user_id as UserId,
    operationKind,
    attemptId: row.attempt_id,
    requestId: row.request_id,
    ownerToken: row.owner_token,
    leasedUntil: instantText(row.leased_until),
    releasedAt: row.released_at === null ? null : instantText(row.released_at),
    releaseReason,
    phase: released ? "released" : row.lease_active ? "held" : "renewal-lapsed",
  };
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function instantText(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new PersistenceError("INVARIANT", "rim ownership timestamp is unreadable");
  }
  return parsed.toISOString();
}

export function ownershipPhase(released: boolean, leaseActive: boolean): RimOwnershipPhase {
  if (released) {
    return "released";
  }
  return leaseActive ? "held" : "renewal-lapsed";
}
