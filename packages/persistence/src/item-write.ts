import type { NotificationItem } from "@98plus/product-model";
import { PersistenceError } from "./errors.ts";

export function mergeNotificationItem(
  dbCurrent: NotificationItem | undefined,
  next: NotificationItem,
): NotificationItem {
  if (!dbCurrent) {
    return { ...next };
  }
  if (dbCurrent.id !== next.id) {
    throw new PersistenceError("INVARIANT", "NotificationItem id mismatch");
  }
  if (dbCurrent.ownerId !== next.ownerId) {
    throw new PersistenceError("INVARIANT", "NotificationItem ownerId is immutable");
  }
  if (dbCurrent.banId !== next.banId) {
    throw new PersistenceError("INVARIANT", "NotificationItem banId is immutable");
  }
  if (dbCurrent.kind !== next.kind) {
    throw new PersistenceError("INVARIANT", "NotificationItem kind is immutable");
  }
  if (dbCurrent.fifoSequence !== next.fifoSequence) {
    throw new PersistenceError("INVARIANT", "NotificationItem fifoSequence is immutable");
  }
  if ("role" in dbCurrent || "role" in next) {
    const left = "role" in dbCurrent ? dbCurrent.role : undefined;
    const right = "role" in next ? next.role : undefined;
    if (left !== right) {
      throw new PersistenceError("INVARIANT", "NotificationItem role is immutable");
    }
  }

  if (
    dbCurrent.lifecycle.status === "PROCESSED" &&
    next.lifecycle.status === "UNPROCESSED"
  ) {
    // Monotonic: keep PROCESSED
    return { ...dbCurrent };
  }

  return {
    ...dbCurrent,
    ...next,
    id: dbCurrent.id,
    ownerId: dbCurrent.ownerId,
    banId: dbCurrent.banId,
    kind: dbCurrent.kind,
    fifoSequence: dbCurrent.fifoSequence,
  } as NotificationItem;
}
