import { describe, expect, it } from "vitest";
import { reduce } from "./index.ts";
import type { Ban } from "./entities.ts";
import type { CanonicalEvent } from "./events.ts";
import type { ProductSnapshot } from "./extended-state.ts";
import type { DurationMinutes } from "./ids.ts";
import {
  BAN_ID,
  INCOMING_ITEM_ID,
  OP_ID,
  OTHER_USER,
  REPLY_BAN_ID,
  STATUS_ITEM_ID,
  USER_ID,
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
import { PRODUCT_CONTROL_STATES } from "./states.ts";
import {
  shouldShowTelegramPersistentReentryCta,
  TELEGRAM_PERSISTENT_REENTRY_CTA_STATES,
} from "./telegram-persistent-reentry-cta.ts";

const REQUEST_ID = "reentry-request-1";
const CANONICAL_EVENT_NAMES_WITHOUT_CTA = [
  "TELEGRAM_PERSISTENT_REENTRY.GRANTED",
  "TELEGRAM_PERSISTENT_REENTRY.DECLINED",
] as const;

const CTA_WHITELIST = new Set<string>(TELEGRAM_PERSISTENT_REENTRY_CTA_STATES);

function applied(snapshot: ProductSnapshot, event: CanonicalEvent, now = 1_000_000) {
  return reduce(snapshot, event, kernelContext(now));
}

function withReentry(
  snapshot: ProductSnapshot,
  patch: Partial<{
    eligible: boolean;
    established: boolean;
    activeRequestId: string | null;
    surfaceGeneration: number;
    consumedSurfaceGeneration: number | null;
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
      ...(patch.surfaceGeneration !== undefined
        ? { telegramPersistentReentryCtaSurfaceGeneration: patch.surfaceGeneration }
        : {}),
      ...(patch.consumedSurfaceGeneration !== undefined
        ? {
            telegramPersistentReentryCtaConsumedSurfaceGeneration: patch.consumedSurfaceGeneration,
          }
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
        proposalId: null,
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

describe("MVP10 Telegram Persistent Re-entry", () => {
  it("1. qualifying E-20: eligible false → true", () => {
    const before = overboardWorld({ ban: shareBoundBan() });
    expect(before.extended.telegramPersistentReentryEligible).toBe(false);
    const result = applied(before, defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
    expect(result.snapshot.extended.telegramPersistentReentryEstablished).toBe(false);
  });

  it("2. qualifying E-30 FROM_INCOMING_BAN: eligible false → true", () => {
    const result = applied(
      replyWorld("INCOMING_BAN", {
        ban: shareBoundBan({ durationMinutes: 12 as DurationMinutes }),
      }),
      confirmReply("INCOMING_BAN"),
    );
    expect(result.outcome).toBe("APPLIED");
    expect(result.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
  });

  it("3. E-30 FROM_STATUS does not create eligibility", () => {
    const result = applied(
      replyWorld("STATUS", { ban: shareBoundBan({ durationMinutes: 12 as DurationMinutes }) }),
      confirmReply("STATUS"),
    );
    expect(result.outcome).toBe("APPLIED");
    expect(result.snapshot.extended.telegramPersistentReentryEligible).toBe(false);
  });

  it("4. E-45 alone does not create eligibility", () => {
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
  });

  it("5–8. eligible=true shows CTA only on the four whitelist surfaces", () => {
    for (const state of TELEGRAM_PERSISTENT_REENTRY_CTA_STATES) {
      const snapshot = withReentry(withControlState(emptySnapshot(), state), { eligible: true });
      expect(shouldShowTelegramPersistentReentryCta(snapshot)).toBe(true);
    }
  });

  it("9. eligible=true on every other canonical Product Control State: CTA hidden", () => {
    expect(PRODUCT_CONTROL_STATES).toHaveLength(30);
    for (const state of PRODUCT_CONTROL_STATES) {
      const snapshot = withReentry(withControlState(emptySnapshot(), state), { eligible: true });
      expect(shouldShowTelegramPersistentReentryCta(snapshot)).toBe(CTA_WHITELIST.has(state));
    }
  });

  it("10–12. E-62: eligible remains true, established false, no bootstrap, state unchanged", () => {
    const snapshot = withReentry(
      withControlState(emptySnapshot(), "NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER"),
      {
        eligible: true,
        activeRequestId: REQUEST_ID,
      },
    );
    const result = applied(snapshot, defaultEvent("TELEGRAM_PERSISTENT_REENTRY.DECLINED"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.result).toBe("STAY");
    expect(result.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(result.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
    expect(result.snapshot.extended.telegramPersistentReentryEstablished).toBe(false);
    expect(result.snapshot.extended.telegramPersistentReentryActiveRequestId).toBeNull();
    expect(
      result.effects.some(
        (effect) => effect.type === "SEND_TELEGRAM_PERSISTENT_REENTRY_BOOTSTRAP_MESSAGE",
      ),
    ).toBe(false);
    expect(
      result.effects.some(
        (effect) => effect.type === "CONSUME_TELEGRAM_PERSISTENT_REENTRY_CTA_OPPORTUNITY",
      ),
    ).toBe(true);
  });

  it("13–14. E-62 consumes current CTA opportunity; same surface CTA hidden", () => {
    const snapshot = withReentry(
      withControlState(emptySnapshot(), "NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER"),
      {
        eligible: true,
        activeRequestId: REQUEST_ID,
      },
    );
    expect(shouldShowTelegramPersistentReentryCta(snapshot)).toBe(true);
    const declined = applied(snapshot, defaultEvent("TELEGRAM_PERSISTENT_REENTRY.DECLINED"));
    expect(declined.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
    expect(declined.snapshot.extended.telegramPersistentReentryCtaConsumedSurfaceGeneration).toBe(
      declined.snapshot.extended.telegramPersistentReentryCtaSurfaceGeneration,
    );
    expect(shouldShowTelegramPersistentReentryCta(declined.snapshot)).toBe(false);
  });

  it("15–17. later new allowed CTA surface shows CTA again without another E-20/E-30", () => {
    const declined = applied(
      withReentry(withControlState(emptySnapshot(), "NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER"), {
        eligible: true,
        activeRequestId: REQUEST_ID,
      }),
      defaultEvent("TELEGRAM_PERSISTENT_REENTRY.DECLINED"),
    );
    expect(shouldShowTelegramPersistentReentryCta(declined.snapshot)).toBe(false);

    const laterRim = withControlState(declined.snapshot, "RIM.LOBBY");
    expect(laterRim.extended.telegramPersistentReentryEligible).toBe(true);
    expect(shouldShowTelegramPersistentReentryCta(laterRim)).toBe(true);

    const laterCb = withControlState(declined.snapshot, "CREATE_BAN.SUCCESS");
    expect(shouldShowTelegramPersistentReentryCta(laterCb)).toBe(true);
  });

  it("18. E-61: established=true, eligible=false", () => {
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
  });

  it("19. established=true on all four allowed surfaces: CTA hidden", () => {
    for (const state of TELEGRAM_PERSISTENT_REENTRY_CTA_STATES) {
      const snapshot = withReentry(withControlState(emptySnapshot(), state), {
        eligible: false,
        established: true,
      });
      expect(shouldShowTelegramPersistentReentryCta(snapshot)).toBe(false);
    }
  });

  it("20. established=true: later qualifying E-20/E-30 must not reactivate acquisition CTA", () => {
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
    expect(
      shouldShowTelegramPersistentReentryCta(
        withControlState(afterQualifying.snapshot, "NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER"),
      ),
    ).toBe(false);
  });

  it("21. application close/open: eligible=true persists until establishment", () => {
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

  it("22. late qualifying E-20: eligibility applied without restoring old UI", () => {
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
    expect(shouldShowTelegramPersistentReentryCta(result.snapshot)).toBe(true);
  });

  it("23. late qualifying E-30 FROM_INCOMING_BAN: same invariant", () => {
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
            proposalId: null,
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
    expect(shouldShowTelegramPersistentReentryCta(result.snapshot)).toBe(false);
  });

  it("24. duplicate/stale E-61/E-62 preserve existing idempotency/stale-result rules", () => {
    const granted = applied(
      withReentry(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        eligible: true,
        activeRequestId: REQUEST_ID,
      }),
      defaultEvent("TELEGRAM_PERSISTENT_REENTRY.GRANTED"),
    );
    const duplicateGranted = applied(
      withReentry(granted.snapshot, { activeRequestId: REQUEST_ID }),
      defaultEvent("TELEGRAM_PERSISTENT_REENTRY.GRANTED"),
    );
    expect(duplicateGranted.result).toBe("IGNORE_NOT_ALLOWED");
    expect(duplicateGranted.effects).toEqual([]);
    expect(duplicateGranted.snapshot.extended.telegramPersistentReentryEstablished).toBe(true);
    expect(duplicateGranted.snapshot.extended.telegramPersistentReentryEligible).toBe(false);

    const declined = applied(
      withReentry(withControlState(emptySnapshot(), "RIM.LOBBY"), {
        eligible: true,
        activeRequestId: REQUEST_ID,
      }),
      defaultEvent("TELEGRAM_PERSISTENT_REENTRY.DECLINED"),
    );
    const staleDeclined = applied(
      declined.snapshot,
      defaultEvent("TELEGRAM_PERSISTENT_REENTRY.DECLINED"),
    );
    expect(staleDeclined.result).toBe("IGNORE_NOT_ALLOWED");
    expect(staleDeclined.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
  });

  it("25. bootstrap message is external effect, not a Notification Item / Ban mutation", () => {
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
  });

  it("preserves non-Share E-20 / failed actions / CTA is not a canonical event", () => {
    expect(
      applied(overboardWorld(), defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED")).snapshot.extended
        .telegramPersistentReentryEligible,
    ).toBe(false);

    const overboardFail = applied(
      overboardWorld({ ban: shareBoundBan() }),
      defaultEvent("NOTIFICATIONS.ACTION_FAILED"),
    );
    expect(overboardFail.snapshot.extended.telegramPersistentReentryEligible).toBe(false);

    expect(CANONICAL_EVENT_NAMES_WITHOUT_CTA).not.toContain("CTA");
  });

  it("after E-62, eligibility does not require a new qualifying action", () => {
    const declined = applied(
      withReentry(withControlState(emptySnapshot(), "NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER"), {
        eligible: true,
        activeRequestId: REQUEST_ID,
      }),
      defaultEvent("TELEGRAM_PERSISTENT_REENTRY.DECLINED"),
    );
    expect(declined.snapshot.extended.telegramPersistentReentryEligible).toBe(true);
    // No second E-20 — navigation alone reopens CTA opportunity.
    expect(
      shouldShowTelegramPersistentReentryCta(withControlState(declined.snapshot, "RIM.LOBBY")),
    ).toBe(true);
  });
});
