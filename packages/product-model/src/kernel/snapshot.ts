import type {
  NotificationItem,
  StatusNotificationItem,
  TimerNotificationItem,
} from "../entities.ts";
import type { ProductSnapshot } from "../extended-state.ts";
import type { Instant } from "../primitives.ts";
import { PENDING_EXTERNAL_ENTRY_TTL_MS } from "../primitives.ts";
import type { BanStatus, Role } from "../primitives.ts";
import type { BanId, UserId } from "../ids.ts";
import type { ProductControlState } from "../states.ts";
import type { ExecutionContext } from "./types.ts";

export function asInstant(ms: number): Instant {
  return ms as unknown as Instant;
}

export function instantValue(instant: Instant): number {
  return instant as unknown as number;
}

export function emptySnapshot(): ProductSnapshot {
  return {
    controlState: null,
    extended: {
      rimChat: null,
      savedFrozenRimChat: null,
      createBanDraft: null,
      replyBanDraft: null,
      replySource: null,
      successfulBanId: null,
      activeNotificationItemId: null,
      priorities: { statusItemId: null, timerItemId: null },
      pendingExternalEntry: null,
      entities: {
        bans: {},
        notificationItems: {},
        checkPairs: {},
        domainTimers: {},
        shareOperations: {},
      },
    },
    runtime: {
      connection: "ONLINE",
      session: "ACTIVE",
      bootstrap: { status: "COMPLETE" },
      transitionInFlight: null,
      pendingOperations: {},
    },
  };
}

export function counterAllocator(start = 1): ExecutionContext["allocateId"] {
  let n = start;
  return (kind: string) => `${kind}-${n++}`;
}

export function unprocessedItems(snapshot: ProductSnapshot, ownerId?: UserId): NotificationItem[] {
  return Object.values(snapshot.extended.entities.notificationItems)
    .filter((item) => item.lifecycle.status === "UNPROCESSED")
    .filter((item) => ownerId === undefined || item.ownerId === ownerId)
    .sort((a, b) => a.fifoSequence - b.fifoSequence);
}

export function fifoHead(snapshot: ProductSnapshot, ownerId?: UserId): NotificationItem | null {
  return unprocessedItems(snapshot, ownerId)[0] ?? null;
}

export function unprocessedTimerItems(
  snapshot: ProductSnapshot,
  ownerId?: UserId,
): TimerNotificationItem[] {
  return unprocessedItems(snapshot, ownerId).filter(
    (item): item is TimerNotificationItem => item.kind === "TIMER",
  );
}

/** Exactly one Timer NotificationItem per Ban for an owner. */
export function timerNotificationItemForBan(
  snapshot: ProductSnapshot,
  banId: BanId,
  ownerId: UserId,
): TimerNotificationItem | undefined {
  return Object.values(snapshot.extended.entities.notificationItems).find(
    (item): item is TimerNotificationItem =>
      item.kind === "TIMER" && item.banId === banId && item.ownerId === ownerId,
  );
}

export function sourceReplyBanTimerItem(
  snapshot: ProductSnapshot,
  ownerId: UserId,
): TimerNotificationItem | undefined {
  const banId = snapshot.extended.replySource?.banId;
  if (!banId) {
    return undefined;
  }
  return timerNotificationItemForBan(snapshot, banId, ownerId);
}

export function sourceReplyBanTimerIsUnprocessed(
  snapshot: ProductSnapshot,
  ownerId: UserId,
): boolean {
  return sourceReplyBanTimerItem(snapshot, ownerId)?.lifecycle.status === "UNPROCESSED";
}

export function activeItem(snapshot: ProductSnapshot): NotificationItem | null {
  const id = snapshot.extended.activeNotificationItemId;
  return id ? (snapshot.extended.entities.notificationItems[id] ?? null) : null;
}

export function pendingOfKind(snapshot: ProductSnapshot, kind: string) {
  return Object.values(snapshot.runtime.pendingOperations).filter(
    (operation) => operation.kind === kind && !operation.resultApplied,
  );
}

export function ttlExpired(snapshot: ProductSnapshot, now: Instant): boolean {
  const entry = snapshot.extended.pendingExternalEntry;
  if (!entry) {
    return false;
  }
  return instantValue(now) - instantValue(entry.entryTimestamp) >= PENDING_EXTERNAL_ENTRY_TTL_MS;
}

export function statusControlState(status: BanStatus, role: Role): ProductControlState {
  return `NOTIFICATIONS.STATUS.${status}.${role}`;
}

export function isStatusItem(item: NotificationItem): item is StatusNotificationItem {
  return item.kind === "STATUS";
}

export function nextFifoSequence(snapshot: ProductSnapshot): number {
  const items = Object.values(snapshot.extended.entities.notificationItems);
  return items.reduce((max, item) => Math.max(max, item.fifoSequence), 0) + 1;
}

export function cloneSnapshot(snapshot: ProductSnapshot): ProductSnapshot {
  return structuredClone(snapshot);
}
