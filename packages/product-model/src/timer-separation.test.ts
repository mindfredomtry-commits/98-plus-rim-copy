import { describe, expect, it } from "vitest";
import {
  APP_FULL_CLOSE_FORBIDDEN_EFFECT_TYPES,
  APP_FULL_CLOSE_GLOBAL_EFFECTS,
  assertsNoDomainTimerMutation,
  composeAppFullCloseDeclaredEffects,
  E42_DURATION_EXPIRED_EFFECTS,
  lookupDomainTimer,
  markTimerNotificationItemProcessed,
  type BanId,
  type DomainTimer,
  type DomainTimerId,
  type DurationMinutes,
  type Instant,
  type NotificationItemId,
  type ProductSnapshot,
  type TimerNotificationItem,
  type UserId,
} from "./index.ts";

function sampleDomainTimer(id: DomainTimerId, banId: BanId): DomainTimer {
  return {
    id,
    banId,
    startedAt: {} as Instant,
    durationMinutes: 3 as DurationMinutes,
    state: "RUNNING",
    checkPairCreated: false,
  };
}

function sampleTimerNotificationItem(
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

describe("Timer Notification Item vs DomainTimer", () => {
  it("processes only the Timer Notification Item on the E-32 global overlay", () => {
    const domainTimerId = "domain-timer-1" as DomainTimer["id"];
    const banId = "ban-1" as DomainTimer["banId"];
    const domainTimer = Object.freeze(sampleDomainTimer(domainTimerId, banId));
    const item = sampleTimerNotificationItem(
      "item-1" as never,
      "user-1" as never,
      banId,
      domainTimerId,
    );

    const processed = markTimerNotificationItemProcessed(item);
    const composed = composeAppFullCloseDeclaredEffects([]);

    expect(processed.lifecycle).toEqual({ status: "PROCESSED" });
    expect(processed.domainTimerId).toBe(domainTimer.id);
    expect(domainTimer.state).toBe("RUNNING");
    expect(domainTimer.checkPairCreated).toBe(false);
    expect(composed.map((effect) => effect.type)).toEqual([
      "PROCESS_TIMER_NOTIFICATION_ITEM",
      "CLEAR_TIMER_PRIORITY",
      "END_SESSION",
    ]);
    expect(assertsNoDomainTimerMutation(composed.map((effect) => effect.type))).toBe(true);
    expect(APP_FULL_CLOSE_FORBIDDEN_EFFECT_TYPES).toEqual(["UPSERT_DOMAIN_TIMER"]);
    expect(
      (APP_FULL_CLOSE_GLOBAL_EFFECTS.map((effect) => effect.type) as readonly string[]).includes(
        "UPSERT_DOMAIN_TIMER",
      ),
    ).toBe(false);
  });

  it("leaves DomainTimer lookup intact after Notification Item processing", () => {
    const domainTimerId = "domain-timer-2" as DomainTimer["id"];
    const banId = "ban-2" as DomainTimer["banId"];
    const domainTimer = sampleDomainTimer(domainTimerId, banId);
    const snapshot: ProductSnapshot = {
      controlState: "RIM.LOBBY",
      runtime: {
        connection: "ONLINE",
        session: "ACTIVE",
        bootstrap: { status: "COMPLETE" },
        transitionInFlight: null,
        pendingOperations: {},
      },
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
        telegramPersistentReentryEligible: false,
        telegramPersistentReentryEstablished: false,
        telegramPersistentReentryActiveRequestId: null,
        entities: {
          bans: {},
          notificationItems: {},
          checkPairs: {},
          domainTimers: { [domainTimerId]: domainTimer },
          shareOperations: {},
        },
      },
    };

    const processed = markTimerNotificationItemProcessed(
      sampleTimerNotificationItem("item-2" as never, "user-2" as never, banId, domainTimerId),
    );
    expect(processed.lifecycle.status).toBe("PROCESSED");
    expect(lookupDomainTimer(snapshot, domainTimerId)).toBe(domainTimer);
    expect(lookupDomainTimer(snapshot, domainTimerId)?.state).toBe("RUNNING");
    expect(
      E42_DURATION_EXPIRED_EFFECTS.some((effect) => effect.type === "UPSERT_DOMAIN_TIMER"),
    ).toBe(true);
  });
});
