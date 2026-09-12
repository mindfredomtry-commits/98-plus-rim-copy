import type {
  DomainTimer,
  DomainTimerMutatingEffectType,
  Effect,
  TimerNotificationItemProcessingEffectType,
} from "./index.ts";

type AssertNever<T extends never> = T;
type Overlap = Extract<TimerNotificationItemProcessingEffectType, DomainTimerMutatingEffectType>;
export type ProcessingCannotMutateDomainTimer = AssertNever<Overlap>;

type ForbiddenDomainTimerKeys = Extract<keyof DomainTimer, "processed" | "lifecycle">;
export type DomainTimerHasNoNotificationLifecycle = AssertNever<ForbiddenDomainTimerKeys>;

declare const validProcessing: Extract<Effect, { type: "PROCESS_TIMER_NOTIFICATION_ITEM" }>;
export const processingItemId = validProcessing.itemId;

declare const domainTimer: DomainTimer;
export const runningState = domainTimer.state;

export function rejectProcessedFieldOnDomainTimer(): void {
  // @ts-expect-error DomainTimer has no processed field; that belongs to TimerNotificationItem.
  domainTimer.processed = true;
}

export function rejectDomainTimerOnProcessingEffect(): void {
  const effect: Extract<Effect, { type: "PROCESS_TIMER_NOTIFICATION_ITEM" }> = {
    type: "PROCESS_TIMER_NOTIFICATION_ITEM",
    itemId: validProcessing.itemId,
    cause: "APP_FULL_CLOSE",
    // @ts-expect-error processing a Timer Notification Item cannot carry or mutate a DomainTimer.
    timer: domainTimer,
  };
  void effect;
}
