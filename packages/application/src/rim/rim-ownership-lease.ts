import type { UserId } from "@98plus/product-model";
import type {
  ProductStore,
  RimOwnershipOperationKind,
  RimProviderOwnership,
} from "@98plus/persistence";

/**
 * Approved Class C + Class U lease.
 * The 30-second lease is the grace period. There is no extra delay after lapse.
 * Renewal-lapsed is not proof the process died. Fencing decides which result commits.
 */
export const RIM_OWNERSHIP_LEASE_SECONDS = 30;
export const RIM_OWNERSHIP_HEARTBEAT_MS = 10_000;

type TrackedLease = Readonly<{
  currentUserId: UserId;
  operationKind: RimOwnershipOperationKind;
  attemptId: string;
  ownerToken: string;
}>;

const trackedLeases = new Map<number, TrackedLease>();
let nextLeaseId = 1;

export function tokensEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Owner-observed failure may recover while the lease is still held.
 * A peer may recover only after owner-terminated release or lease lapse.
 * A missing row is owner-unknown and authorizes nothing.
 */
export function rimOwnershipRecoveryPermitted(
  ownership: RimProviderOwnership | null,
  ownerToken: string | undefined,
): boolean {
  if (!ownership) {
    return false;
  }
  if (
    ownerToken !== undefined &&
    tokensEqual(ownership.ownerToken, ownerToken) &&
    ownership.phase !== "released"
  ) {
    return true;
  }
  if (ownership.phase === "held") {
    return false;
  }
  if (ownership.phase === "renewal-lapsed") {
    return true;
  }
  return (
    ownership.phase === "released" &&
    (ownership.releaseReason === "owner-terminated" ||
      ownership.releaseReason === "superseded" ||
      ownership.releaseReason === "chat-abandoned")
  );
}

export function startRimOwnershipHeartbeat(
  store: ProductStore,
  lease: TrackedLease,
): () => void {
  const id = nextLeaseId;
  nextLeaseId += 1;
  trackedLeases.set(id, lease);
  const timer = setInterval(() => {
    void store
      .renewRimProviderOwnership({
        currentUserId: lease.currentUserId,
        operationKind: lease.operationKind,
        attemptId: lease.attemptId,
        ownerToken: lease.ownerToken,
        leaseSeconds: RIM_OWNERSHIP_LEASE_SECONDS,
      })
      .then((result) => {
        if (result.status === "REJECTED") {
          clearInterval(timer);
        }
      }, () => undefined);
  }, RIM_OWNERSHIP_HEARTBEAT_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return () => {
    clearInterval(timer);
    trackedLeases.delete(id);
  };
}

/**
 * Confirmed process shutdown. Releases only tokens this process still tracks.
 * A token mismatch or a lapsed row cannot be transferred. Release after lapse
 * is owner-terminated, not a new exclusive owner.
 */
export async function releaseTrackedRimOwnershipForShutdown(store: ProductStore): Promise<void> {
  const rows = [...trackedLeases.values()];
  trackedLeases.clear();
  for (const row of rows) {
    try {
      await store.releaseRimProviderOwnership({
        currentUserId: row.currentUserId,
        operationKind: row.operationKind,
        attemptId: row.attemptId,
        ownerToken: row.ownerToken,
        releaseReason: "owner-terminated",
      });
    } catch {
      // A failed shutdown release leaves the lease to lapse. It does not transfer it.
    }
  }
}
