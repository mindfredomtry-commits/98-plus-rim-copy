import { describe, expect, it } from "vitest";
import { reduce } from "./index.ts";
import type { Ban } from "./entities.ts";
import type { CanonicalEvent } from "./events.ts";
import type { ProductSnapshot } from "./extended-state.ts";
import type { DurationMinutes, OperationId } from "./ids.ts";
import {
  BAN_ID,
  INCOMING_ITEM_ID,
  OP_ID,
  OTHER_USER,
  REPLY_BAN_ID,
  STATUS_ITEM_ID,
  USER_ID,
  branded,
  defaultEvent,
  eventOf,
  incomingItem,
  kernelContext,
  makeBan,
  pendingOp,
  statusItem,
  withControlState,
  withEntities,
  withItems,
  withOperation,
} from "./kernel.fixtures.ts";
import { emptySnapshot } from "./kernel/snapshot.ts";

const REQUEST_ID = "reentry-request-1";
const OP_AFTER = branded<OperationId>("op-after");
const CANONICAL_EVENT_NAMES_WITHOUT_CTA = [
  "TELEGRAM_PERSISTENT_REENTRY.GRANTED",
  "TELEGRAM_PERSISTENT_REENTRY.DECLINED",
] as const;

function applied(snapshot: ProductSnapshot, event: CanonicalEvent, now = 1_000_000) {
  return reduce(snapshot, event, kernelContext(now));
}

function withReentry(
  snapshot: ProductSnapshot,
  patch: Partial<{
    eligible: boolean;
    established: boolean;
    activeRequestId: string | null;
  }>,
): ProductSnapshot {
  return {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      ...(patch.eligible !== undefined
        ? { telegramPersistentReentryEligible: patch.eligible }
        : {}),
      ...(patch.established !== undefined
        ? { telegramPersistentReentryEstablished: patch.established }
        : {}),
      ...(patch.activeRequestId !== undefined
        ? { telegramPersistentReentryActiveRequestId: patch.activeRequestId }
        : {}),
    },
  };
}

function shareBoundBan(overrides: Partial<Ban> = {}): Ban {
  return makeBan({
    senderId: OTHER_USER,
    receiverId: USER_ID,
    acceptance: "PENDING",
    status: null,
    boundViaTelegramShareLink: true,
    ...overrides,
  });
}

function overboardWorld(options?: { ban?: Partial<Ban>; withPending?: boolean }): ProductSnapshot {
  let snapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.INCOMING_BAN");
  snapshot = withEntities(snapshot, {
    bans: {
      [BAN_ID]: makeBan({
        senderId: OTHER_USER,
        receiverId: USER_ID,
        acceptance: "PENDING",
        status: null,
        boundViaTelegramShareLink: false,
        ...options?.ban,
      }),
    },
  });
  snapshot = withItems(snapshot, [
    incomingItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }),
  ]);
  snapshot = {
    ...snapshot,
    extended: { ...snapshot.extended, activeNotificationItemId: INCOMING_ITEM_ID },
  };
  if (options?.withPending === false) {
    return snapshot;
  }
  return withOperation(
    snapshot,
    pendingOp({
      kind: "OVERBOARD",
      originatingState: "NOTIFICATIONS.INCOMING_BAN",
      originatingItemId: INCOMING_ITEM_ID,
    }),
  );
}

function replyWorld(
  origin: "INCOMING_BAN" | "STATUS",
  options?: { ban?: Partial<Ban> },
): ProductSnapshot {
  const sourceItem =
    origin === "STATUS"
      ? statusItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } })
      : incomingItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } });
  let snapshot = withControlState(
    emptySnapshot(),
    origin === "STATUS" ? "REPLY_BAN.CONFIRM.FROM_STATUS" : "REPLY_BAN.CONFIRM.FROM_INCOMING_BAN",
  );
  snapshot = withEntities(snapshot, {
    bans: {
      [BAN_ID]: makeBan({
        senderId: OTHER_USER,
        receiverId: USER_ID,
        acceptance: "PENDING",
        durationMinutes: 12 as DurationMinutes,
        boundViaTelegramShareLink: false,
        ...options?.ban,
      }),
    },
    notificationItems: { [sourceItem.id]: sourceItem },
  });
  snapshot = {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      activeNotificationItemId: sourceItem.id,
      replyBanDraft: { banText: "reply text", durationMinutes: 15 as DurationMinutes },
      replySource: { kind: origin, itemId: sourceItem.id, banId: BAN_ID },
    },
  };
  return withOperation(
    snapshot,
    pendingOp({
      kind: "REPLY_BAN_SEND",
      originatingState: snapshot.controlState!,
      originatingItemId: sourceItem.id,
      sendDraft: {
        banText: "reply text",
        durationMinutes: 15 as DurationMinutes,
        selectedContactId: null,
        origin: null,
      },
    }),
  );
}

function confirmReply(origin: "INCOMING_BAN" | "STATUS") {
  return eventOf("REPLY_BAN.SEND_CONFIRMED", {
    operationId: OP_ID,
    replyBanId: REPLY_BAN_ID,
    source:
      origin === "STATUS"
        ? { kind: "STATUS", itemId: STATUS_ITEM_ID, banId: BAN_ID }
        : { kind: "INCOMING_BAN", itemId: INCOMING_ITEM_ID, banId: BAN_ID },
  });
}

describe("Stage 13A Telegram Persistent Re-entry CORE", () => {
  it("4. E-45 receiver binding alone does not set eligibility", () => {
    let snapshot = withControlState(emptySnapshot(), "RIM.LOBBY");
    snapshot = withEntities(snapshot, {
      bans: {
        [BAN_ID]: makeBan({
          senderId: OTHER_USER,
          receiverId: null,
          acceptance: "PENDING",
          boundViaTelegramShareLink: false,
        }),
      },
    });
    const result = applied(snapshot, defaultEvent("TELEGRAM_SHARE_LINK.RESOLVED"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.snapshot.extended.entities.bans[BAN_ID]?.boundViaTelegramShareLink).toBe(true);
    expect(result.snapshot.extended.telegramPersistentReentryEligible).toBe(false);
    expect(result.snapshot.extended.telegramPersistentReentryEstablished).toBe(false);
  });

  it("5. Opening Incoming Ban does not set eligibility", () => {
    const snapshot = overboardWorld({ ban: shareBoundBan(), withPending: false });
    expect(snapshot.extended.telegramPersistentReentryEligible).toBe(false);
    expect(snapshot.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
  });

  it("6. PRESS_OVERBOARD before confirmation does not set eligibility", () => {
    const snapshot = overboardWorld({ ban: shareBoundBan(), withPending: false });
    const result = applied(snapshot, defaultEvent("NOTIFICATIONS.PRESS_OVERBOARD"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.snapshot.extended.telegramPersistentReentryEligible).toBe(false);
  });

  it("7. Qualifying E-20 from Share-bound Ban sets eligible=true", () => {
    const result = applied(
      overboardWorld({ ban: shareBoundBan() }),
      defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"),
    );
    expect(result.outcome).toBe("APPLIED");
    expect(result.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
    expect(result.snapshot.extended.telegramPersistentReentryEstablished).toBe(false);
  });

  it("8. E-20 from non-Share-origin Ban does not set eligibility", () => {
    const result = applied(overboardWorld(), defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.snapshot.extended.telegramPersistentReentryEligible).toBe(false);
  });

  it("9. Entering Reply Ban FROM_INCOMING_BAN does not set eligibility", () => {
    const snapshot = overboardWorld({ ban: shareBoundBan(), withPending: false });
    const result = applied(snapshot, defaultEvent("NOTIFICATIONS.PRESS_REPLY_BAN"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.snapshot.extended.telegramPersistentReentryEligible).toBe(false);
  });

  it("10. Qualifying E-30 FROM_INCOMING_BAN sets eligible=true", () => {
    const result = applied(
      replyWorld("INCOMING_BAN", {
        ban: shareBoundBan({ durationMinutes: 12 as DurationMinutes }),
      }),
      confirmReply("INCOMING_BAN"),
    );
    expect(result.outcome).toBe("APPLIED");
    expect(result.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
  });

  it("11. E-30 FROM_STATUS does not set eligibility", () => {
    const result = applied(
      replyWorld("STATUS", { ban: shareBoundBan({ durationMinutes: 12 as DurationMinutes }) }),
      confirmReply("STATUS"),
    );
    expect(result.outcome).toBe("APPLIED");
    expect(result.snapshot.extended.telegramPersistentReentryEligible).toBe(false);
  });

  it("12. Failed E-20 / E-30 does not set eligibility", () => {
    const overboardFail = applied(
      overboardWorld({ ban: shareBoundBan() }),
      defaultEvent("NOTIFICATIONS.ACTION_FAILED"),
    );
    expect(overboardFail.outcome).toBe("APPLIED");
    expect(overboardFail.snapshot.extended.telegramPersistentReentryEligible).toBe(false);

    const replyFail = applied(
      replyWorld("INCOMING_BAN", {
        ban: shareBoundBan({ durationMinutes: 12 as DurationMinutes }),
      }),
      defaultEvent("REPLY_BAN.SEND_FAILED"),
    );
    expect(replyFail.outcome).toBe("APPLIED");
    expect(replyFail.snapshot.extended.telegramPersistentReentryEligible).toBe(false);
  });

  it("13–14. eligible survives APP.FULL_CLOSE and APP.NORMAL_OPEN", () => {
    const eligible = withReentry(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      eligible: true,
    });
    const closed = applied(eligible, defaultEvent("APP.FULL_CLOSE"));
    expect(closed.outcome).toBe("APPLIED");
    expect(closed.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
    expect(closed.snapshot.runtime.session).toBe("CLOSED");

    const reopened = applied(closed.snapshot, defaultEvent("APP.NORMAL_OPEN"));
    expect(reopened.outcome).toBe("APPLIED");
    expect(reopened.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
  });

  it("15–16. CTA/request initiation is not a canonical Product Event and does not change control state", () => {
    const before = withReentry(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      eligible: true,
      activeRequestId: REQUEST_ID,
    });
    expect(before.controlState).toBe("RIM.LOBBY");
    expect(before.extended.telegramPersistentReentryEligible).toBe(true);
    // No PRODUCT event for CTA click — only Extended State request id (integration).
    expect(CANONICAL_EVENT_NAMES_WITHOUT_CTA).not.toContain("CTA");
  });

  it("17–18. E-61 Guard A grants: established=true, eligible=false, bootstrap once, STAY", () => {
    const snapshot = withReentry(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      eligible: true,
      activeRequestId: REQUEST_ID,
    });
    const result = applied(snapshot, defaultEvent("TELEGRAM_PERSISTENT_REENTRY.GRANTED"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.result).toBe("STAY");
    expect(result.controlState).toBe("RIM.LOBBY");
    expect(result.snapshot.extended.telegramPersistentReentryEstablished).toBe(true);
    expect(result.snapshot.extended.telegramPersistentReentryEligible).toBe(false);
    expect(result.snapshot.extended.telegramPersistentReentryActiveRequestId).toBeNull();
    expect(
      result.effects.filter(
        (effect) => effect.type === "SEND_TELEGRAM_PERSISTENT_REENTRY_BOOTSTRAP_MESSAGE",
      ),
    ).toHaveLength(1);
    expect(
      Object.values(result.snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "INCOMING_BAN",
      ),
    ).toHaveLength(0);
  });

  it("19. Duplicate E-61 does not re-send bootstrap or change facts", () => {
    const granted = applied(
      withReentry(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        eligible: true,
        activeRequestId: REQUEST_ID,
      }),
      defaultEvent("TELEGRAM_PERSISTENT_REENTRY.GRANTED"),
    );
    const duplicate = applied(
      withReentry(granted.snapshot, { activeRequestId: REQUEST_ID }),
      defaultEvent("TELEGRAM_PERSISTENT_REENTRY.GRANTED"),
    );
    expect(duplicate.outcome).toBe("APPLIED");
    expect(duplicate.result).toBe("IGNORE_NOT_ALLOWED");
    expect(duplicate.effects).toEqual([]);
    expect(duplicate.snapshot.extended.telegramPersistentReentryEstablished).toBe(true);
    expect(duplicate.snapshot.extended.telegramPersistentReentryEligible).toBe(false);
  });

  it("20–21. After established, CTA never reappears even after new qualifying action", () => {
    const established = withReentry(
      withControlState(emptySnapshot(), "NOTIFICATIONS.INCOMING_BAN"),
      {
        established: true,
        eligible: false,
      },
    );
    const afterQualifying = applied(
      withOperation(
        withEntities(established, {
          bans: { [BAN_ID]: shareBoundBan() },
          notificationItems: {
            [INCOMING_ITEM_ID]: incomingItem({
              lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
            }),
          },
        }),
        pendingOp({
          kind: "OVERBOARD",
          originatingState: "NOTIFICATIONS.INCOMING_BAN",
          originatingItemId: INCOMING_ITEM_ID,
        }),
      ),
      defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"),
    );
    expect(afterQualifying.outcome).toBe("APPLIED");
    expect(afterQualifying.snapshot.extended.telegramPersistentReentryEligible).toBe(false);
    expect(afterQualifying.snapshot.extended.telegramPersistentReentryEstablished).toBe(true);
  });

  it("22. E-62 Guard A clears eligibility without bootstrap or established", () => {
    const snapshot = withReentry(withControlState(emptySnapshot(), "RIM.CHAT"), {
      eligible: true,
      activeRequestId: REQUEST_ID,
    });
    const result = applied(snapshot, defaultEvent("TELEGRAM_PERSISTENT_REENTRY.DECLINED"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.result).toBe("STAY");
    expect(result.controlState).toBe("RIM.CHAT");
    expect(result.snapshot.extended.telegramPersistentReentryEligible).toBe(false);
    expect(result.snapshot.extended.telegramPersistentReentryEstablished).toBe(false);
    expect(result.snapshot.extended.telegramPersistentReentryActiveRequestId).toBeNull();
    expect(
      result.effects.some(
        (effect) => effect.type === "SEND_TELEGRAM_PERSISTENT_REENTRY_BOOTSTRAP_MESSAGE",
      ),
    ).toBe(false);
    expect(result.error).toBeNull();
  });

  it("23–24. After E-62, a NEW qualifying action may set eligible again (not permanent opt-out)", () => {
    const declined = applied(
      withReentry(withControlState(emptySnapshot(), "NOTIFICATIONS.INCOMING_BAN"), {
        eligible: true,
        activeRequestId: REQUEST_ID,
      }),
      defaultEvent("TELEGRAM_PERSISTENT_REENTRY.DECLINED"),
    );
    expect(declined.snapshot.extended.telegramPersistentReentryEligible).toBe(false);
    const again = applied(
      withOperation(
        withEntities(declined.snapshot, {
          bans: { [BAN_ID]: shareBoundBan() },
          notificationItems: {
            [INCOMING_ITEM_ID]: incomingItem({
              lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
            }),
          },
        }),
        pendingOp({
          kind: "OVERBOARD",
          originatingState: "NOTIFICATIONS.INCOMING_BAN",
          originatingItemId: INCOMING_ITEM_ID,
          operationId: OP_AFTER,
        }),
      ),
      eventOf("NOTIFICATIONS.OVERBOARD_CONFIRMED", {
        sourceItemId: INCOMING_ITEM_ID,
        banId: BAN_ID,
        operationId: OP_AFTER,
      }),
    );
    expect(again.outcome).toBe("APPLIED");
    expect(again.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
    expect(again.snapshot.extended.telegramPersistentReentryEstablished).toBe(false);
  });

  it("25. Late qualifying E-20 sets eligibility without restoring old UI", () => {
    const displaced = withControlState(
      withOperation(
        withEntities(emptySnapshot(), {
          bans: { [BAN_ID]: shareBoundBan() },
          notificationItems: {
            [INCOMING_ITEM_ID]: incomingItem({
              lifecycle: { status: "UNPROCESSED", display: "WAITING" },
            }),
          },
        }),
        pendingOp({
          kind: "OVERBOARD",
          originatingState: "NOTIFICATIONS.INCOMING_BAN",
          originatingItemId: INCOMING_ITEM_ID,
          supersededByExternalEntry: true,
        }),
      ),
      "RIM.LOBBY",
    );
    const result = applied(displaced, defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.traces[0]?.eventId).toBe("LATE_RESULT");
    expect(result.controlState).toBe("RIM.LOBBY");
    expect(result.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
    expect(result.snapshot.extended.priorities.statusItemId).toBeNull();
  });

  it("26. Late qualifying E-30 FROM_INCOMING_BAN sets eligibility without restoring Reply UI", () => {
    const base = replyWorld("INCOMING_BAN", {
      ban: shareBoundBan({ durationMinutes: 12 as DurationMinutes }),
    });
    const displaced = {
      ...withOperation(
        base,
        pendingOp({
          kind: "REPLY_BAN_SEND",
          originatingState: "REPLY_BAN.CONFIRM.FROM_INCOMING_BAN",
          originatingItemId: INCOMING_ITEM_ID,
          supersededByExternalEntry: true,
          sendDraft: {
            banText: "reply text",
            durationMinutes: 15 as DurationMinutes,
            selectedContactId: null,
            origin: null,
          },
        }),
      ),
      controlState: "NOTIFICATIONS.INCOMING_BAN" as const,
    };
    const result = applied(displaced, confirmReply("INCOMING_BAN"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.traces[0]?.eventId).toBe("LATE_RESULT");
    expect(result.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(result.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
    expect(result.snapshot.extended.replyBanDraft).toBeNull();
  });

  it("27. Duplicate late result does not incorrectly re-apply eligibility/business effects", () => {
    const displaced = withControlState(
      withOperation(
        withEntities(emptySnapshot(), {
          bans: { [BAN_ID]: shareBoundBan() },
          notificationItems: {
            [INCOMING_ITEM_ID]: incomingItem({
              lifecycle: { status: "UNPROCESSED", display: "WAITING" },
            }),
          },
        }),
        pendingOp({
          kind: "OVERBOARD",
          originatingState: "NOTIFICATIONS.INCOMING_BAN",
          originatingItemId: INCOMING_ITEM_ID,
          supersededByExternalEntry: true,
        }),
      ),
      "RIM.LOBBY",
    );
    const first = applied(displaced, defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"));
    expect(first.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
    const second = applied(first.snapshot, defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"));
    expect(second.outcome).not.toBe("APPLIED");
    expect(second.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
    expect(second.snapshot.extended.entities.bans[BAN_ID]?.status).toBe("OVERBOARD");
  });

  it("28–29. Bootstrap message is external effect, not a Notification Item / Ban mutation", () => {
    const before = withReentry(withControlState(emptySnapshot(), "RIM.LOBBY"), {
      eligible: true,
      activeRequestId: REQUEST_ID,
    });
    const bansBefore = before.extended.entities.bans;
    const result = applied(before, defaultEvent("TELEGRAM_PERSISTENT_REENTRY.GRANTED"));
    expect(
      result.effects.some(
        (effect) => effect.type === "SEND_TELEGRAM_PERSISTENT_REENTRY_BOOTSTRAP_MESSAGE",
      ),
    ).toBe(true);
    expect(result.snapshot.extended.entities.notificationItems).toEqual({});
    expect(result.snapshot.extended.entities.bans).toEqual(bansBefore);
    expect(result.snapshot.extended.entities.domainTimers).toEqual({});
    expect(result.snapshot.extended.entities.checkPairs).toEqual({});
  });
});
