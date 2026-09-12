import {
  CANONICAL_EVENT_DEFINITIONS,
  PRODUCT_CONTROL_STATE_DEFINITIONS,
  type CanonicalEventId,
  type DomainTimer,
  type DurationMinutes,
  type Instant,
  type NotificationItemId,
  type TimerNotificationItem,
  type UserId,
  type BanId,
  type DomainTimerId,
} from "@98plus/product-model";

export function everyStateHasReferenceMetadata(): boolean {
  return PRODUCT_CONTROL_STATE_DEFINITIONS.every((definition) => definition.references.length > 0);
}

export function everyEventHasReferenceMetadata(): boolean {
  return CANONICAL_EVENT_DEFINITIONS.every((definition) => definition.references.length > 0);
}

export function sampleDomainTimer(id: DomainTimerId, banId: BanId): DomainTimer {
  return {
    id,
    banId,
    startedAt: {} as Instant,
    durationMinutes: 3 as DurationMinutes,
    state: "RUNNING",
    checkPairCreated: false,
  };
}

export function sampleTimerNotificationItem(
  id: NotificationItemId,
  ownerId: UserId,
  banId: BanId,
  domainTimerId: DomainTimerId,
): TimerNotificationItem {
  return {
    id,
    ownerId,
    banId,
    fifoSequence: 1,
    kind: "TIMER",
    domainTimerId,
    lifecycle: { status: "UNPROCESSED", display: "WAITING" },
  };
}

export function isRejectedEventId(value: string): boolean {
  return (
    value === "E-36" || value === "E-37" || value === "E-38" || value === "E-39" || value === "E-40"
  );
}

export function asEventId(value: CanonicalEventId): CanonicalEventId {
  return value;
}
