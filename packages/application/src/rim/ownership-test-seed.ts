import { randomUUID } from "node:crypto";
import {
  InMemoryProductStore,
  type PersistenceSqlClient,
  type RimOwnershipOperationKind,
} from "@98plus/persistence";
import type { ProductStore } from "@98plus/persistence";

function memoryStore(store: ProductStore): InMemoryProductStore {
  if (!(store instanceof InMemoryProductStore)) {
    throw new Error("ownership seed requires the in-memory product store");
  }
  return store;
}

function insertMemoryOwnership(
  store: ProductStore,
  userId: string,
  operationKind: RimOwnershipOperationKind,
  attemptId: string,
  requestId: string | null,
  released: "lapsed" | "owner-terminated",
): void {
  memoryStore(store).inspect().insertOwnership({
    userId,
    operationKind,
    attemptId,
    requestId,
    ownerToken: randomUUID(),
    leasedUntilMs: released === "lapsed" ? Date.now() - 1_000 : Date.now() + 30_000,
    releasedAtMs: released === "lapsed" ? null : Date.now(),
    releaseReason: released === "lapsed" ? null : "owner-terminated",
  });
}

/** Class U: renewal-lapsed ownership. Absence of a row is not this state. */
export function seedLapsedOwnership(
  store: ProductStore,
  userId: string,
  operationKind: RimOwnershipOperationKind,
  attemptId: string,
  requestId: string | null = null,
): void {
  insertMemoryOwnership(store, userId, operationKind, attemptId, requestId, "lapsed");
}

/** Class C: the owner committed owner-terminated and did not persist a provider id. */
export function seedOwnerTerminatedOwnership(
  store: ProductStore,
  userId: string,
  operationKind: RimOwnershipOperationKind,
  attemptId: string,
  requestId: string | null = null,
): void {
  insertMemoryOwnership(store, userId, operationKind, attemptId, requestId, "owner-terminated");
}

export async function insertPostgresOwnership(
  sql: PersistenceSqlClient,
  input: Readonly<{
    userId: string;
    operationKind: RimOwnershipOperationKind;
    attemptId: string;
    requestId: string | null;
    phase: "lapsed" | "owner-terminated" | "held";
  }>,
): Promise<void> {
  const leasedUntil =
    input.phase === "lapsed"
      ? "clock_timestamp() - INTERVAL '1 second'"
      : "clock_timestamp() + INTERVAL '30 seconds'";
  const released =
    input.phase === "owner-terminated"
      ? "clock_timestamp(), 'owner-terminated'"
      : "NULL, NULL";
  await sql.query(
    `
INSERT INTO rim_provider_ownership (
  user_id, operation_kind, attempt_id, request_id, owner_token, leased_until, released_at, release_reason
) VALUES (
  $1, $2, $3, $4, $5::uuid, ${leasedUntil}, ${released}
)
`.trim(),
    [input.userId, input.operationKind, input.attemptId, input.requestId, randomUUID()],
  );
}
