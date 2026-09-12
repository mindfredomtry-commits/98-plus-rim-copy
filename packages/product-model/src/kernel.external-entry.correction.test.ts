import { describe, expect, it } from "vitest";
import { PENDING_EXTERNAL_ENTRY_TTL_MS, reduce } from "./index.ts";
import type { Ban, CheckPair } from "./entities.ts";
import type { CanonicalEvent } from "./events.ts";
import type { ProductSnapshot } from "./extended-state.ts";
import type { BanId, CheckPairId, DurationMinutes, OperationId } from "./ids.ts";
import {
  CONTACT_A,
  BAN_ID,
  CHECK_ITEM_ID,
  CHECK_SENDER_ITEM_ID,
  INCOMING_ITEM_ID,
  OP_ID,
  OTHER_USER,
  REPLY_BAN_ID,
  USER_ID,
  branded,
  checkItem,
  defaultEvent,
  eventOf,
  incomingItem,
  kernelContext,
  makeBan,
  pendingOp,
  validCreateDraft,
  withControlState,
  withEntities,
  withItems,
  withOperation,
} from "./kernel.fixtures.ts";
import { emptySnapshot, instantValue } from "./kernel/snapshot.ts";

const PAIR_ID = branded<CheckPairId>("pair-1");
const OP_AFTER = branded<OperationId>("op-after-e45");

function applied(snapshot: ProductSnapshot, event: CanonicalEvent, now = 1_000_000) {
  return reduce(snapshot, event, kernelContext(now));
}

function pairOf(overrides: Partial<CheckPair> = {}): CheckPair {
  return {
    id: PAIR_ID,
    banId: BAN_ID,
    receiverItemId: CHECK_ITEM_ID,
    senderItemId: CHECK_SENDER_ITEM_ID,
    receiverAnswer: null,
    senderAnswer: null,
    resultingStatus: null,
    ...overrides,
  };
}

function statusItems(snapshot: ProductSnapshot) {
  return Object.values(snapshot.extended.entities.notificationItems).filter(
    (item) => item.kind === "STATUS",
  );
}

function firstLaunchPendingWorld(): ProductSnapshot {
  const opened = applied(emptySnapshot(), defaultEvent("TELEGRAM_SHARE_LINK.OPENED"));
  expect(opened.outcome).toBe("APPLIED");
  return opened.snapshot;
}

function guardAResolvedEvent() {
  return defaultEvent("TELEGRAM_SHARE_LINK.RESOLVED");
}

function externalEntryIncomingWorld(options?: {
  controlState?: ProductSnapshot["controlState"];
  ban?: Partial<Ban>;
  incomingLifecycle?: "UNPROCESSED" | "PROCESSED";
  pending?: ReturnType<typeof pendingOp>;
}): ProductSnapshot {
  const lifecycle =
    options?.incomingLifecycle === "PROCESSED"
      ? ({ status: "PROCESSED" } as const)
      : ({ status: "UNPROCESSED", display: "WAITING" } as const);
  let snapshot = withControlState(emptySnapshot(), options?.controlState ?? "CREATE_BAN.WHAT.RIM");
  snapshot = withEntities(snapshot, {
    bans: {
      [BAN_ID]: makeBan({
        senderId: OTHER_USER,
        receiverId: USER_ID,
        acceptance: "PENDING",
        status: null,
        ...options?.ban,
      }),
    },
  });
  snapshot = withItems(snapshot, [incomingItem({ lifecycle })]);
  if (options?.pending) {
    snapshot = withOperation(snapshot, options.pending);
  }
  return snapshot;
}

function checkWorld(role: "RECEIVER" | "SENDER", firstAnswerSet: boolean): ProductSnapshot {
  const ban = makeBan({
    senderId: role === "SENDER" ? USER_ID : OTHER_USER,
    receiverId: role === "RECEIVER" ? USER_ID : OTHER_USER,
    acceptance: "ACCEPTED",
  });
  const pair = pairOf({
    receiverAnswer: firstAnswerSet && role === "SENDER" ? "FULFILLED" : null,
    senderAnswer: firstAnswerSet && role === "RECEIVER" ? "FULFILLED" : null,
  });
  const active = checkItem(role, {
    ownerId: USER_ID,
    lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
  });
  const other = checkItem(role === "RECEIVER" ? "SENDER" : "RECEIVER", { ownerId: OTHER_USER });
  let snapshot = withControlState(
    emptySnapshot(),
    role === "RECEIVER" ? "NOTIFICATIONS.CHECK.RECEIVER" : "NOTIFICATIONS.CHECK.SENDER",
  );
  snapshot = withEntities(snapshot, {
    bans: { [BAN_ID]: ban },
    checkPairs: { [PAIR_ID]: pair },
    notificationItems: { [active.id]: active, [other.id]: other },
  });
  snapshot = {
    ...snapshot,
    extended: { ...snapshot.extended, activeNotificationItemId: active.id },
  };
  return withOperation(
    snapshot,
    pendingOp({
      kind: "CHECK_ANSWER",
      originatingState: snapshot.controlState!,
      originatingItemId: active.id,
    }),
  );
}

function replyWorld(): ProductSnapshot {
  const sourceItem = incomingItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } });
  let snapshot = withControlState(emptySnapshot(), "REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
  snapshot = withEntities(snapshot, {
    bans: {
      [BAN_ID]: makeBan({
        senderId: OTHER_USER,
        receiverId: USER_ID,
        acceptance: "PENDING",
        durationMinutes: 12 as DurationMinutes,
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
      replySource: { kind: "INCOMING_BAN", itemId: sourceItem.id, banId: BAN_ID },
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

function createBanPendingWorld(): ProductSnapshot {
  let snapshot = withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.CONTACT");
  snapshot = {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      createBanDraft: validCreateDraft("CONTACT"),
    },
  };
  return withOperation(
    snapshot,
    pendingOp({
      kind: "CREATE_BAN_SEND",
      originatingState: "CREATE_BAN.CONFIRM.CONTACT",
      sendDraft: {
        banText: "no phones",
        durationMinutes: 3 as DurationMinutes,
        selectedContactId: CONTACT_A,
        origin: "CONTACT",
      },
    }),
  );
}

function applySuccessfulE45From(snapshot: ProductSnapshot) {
  const incoming = incomingItem({ lifecycle: { status: "UNPROCESSED", display: "WAITING" } });
  const withIncoming = withEntities(snapshot, {
    notificationItems: {
      ...snapshot.extended.entities.notificationItems,
      [incoming.id]: incoming,
    },
  });
  const withBan =
    withIncoming.extended.entities.bans[BAN_ID] !== undefined
      ? withIncoming
      : withEntities(withIncoming, {
          bans: {
            [BAN_ID]: makeBan({
              senderId: OTHER_USER,
              receiverId: null,
              acceptance: "PENDING",
              status: null,
            }),
          },
        });
  return applied(withBan, guardAResolvedEvent());
}

describe("MVP7 External Entry Kernel correction D1–D3", () => {
  describe("D1 first-launch bootstrap", () => {
    it("real E-44 with null controlState establishes FIRST_LAUNCH_EXTERNAL_ENTRY", () => {
      const snapshot = emptySnapshot();
      expect(snapshot.controlState).toBeNull();
      expect(snapshot.runtime.bootstrap.status).toBe("COMPLETE");
      const result = applied(snapshot, defaultEvent("TELEGRAM_SHARE_LINK.OPENED"));
      expect(result.outcome).toBe("APPLIED");
      expect(result.controlState).toBeNull();
      expect(result.snapshot.extended.pendingExternalEntry).toMatchObject({
        firstLaunch: true,
        shareTargetBanId: BAN_ID,
      });
      expect(result.snapshot.runtime.bootstrap.status).toBe("FIRST_LAUNCH_EXTERNAL_ENTRY");
    });

    it("E-33 does not create RIM.LOBBY while first-launch External Entry context is current", () => {
      const pending = firstLaunchPendingWorld();
      const result = applied(pending, defaultEvent("APP.NORMAL_OPEN"));
      expect(result.outcome).toBe("APPLIED");
      expect(result.result).toBe("STAY");
      expect(result.controlState).toBeNull();
      expect(result.snapshot.runtime.bootstrap.status).toBe("FIRST_LAUNCH_EXTERNAL_ENTRY");
    });

    it("E-45 Guard A / first-launch-resolved yields first Product Control State N-01", () => {
      let snapshot = firstLaunchPendingWorld();
      snapshot = withEntities(snapshot, {
        bans: {
          [BAN_ID]: makeBan({
            senderId: OTHER_USER,
            receiverId: null,
            acceptance: "PENDING",
            status: null,
          }),
        },
        notificationItems: {
          [INCOMING_ITEM_ID]: incomingItem({
            lifecycle: { status: "UNPROCESSED", display: "WAITING" },
          }),
        },
      });
      const result = applied(snapshot, guardAResolvedEvent());
      expect(result.outcome).toBe("APPLIED");
      expect(result.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
      expect(result.snapshot.runtime.bootstrap.status).toBe("COMPLETE");
      expect(result.snapshot.extended.entities.notificationItems[INCOMING_ITEM_ID]?.kind).toBe(
        "INCOMING_BAN",
      );
      expect(result.snapshot.extended.activeNotificationItemId).toBe(INCOMING_ITEM_ID);
    });

    it("E-41 before resolution clears pending/first-launch context and opens RIM.LOBBY", () => {
      const pending = firstLaunchPendingWorld();
      const entryAt = pending.extended.pendingExternalEntry!.entryTimestamp;
      const expiredNow = instantValue(entryAt) + PENDING_EXTERNAL_ENTRY_TTL_MS;
      const result = applied(pending, defaultEvent("EXTERNAL_ENTRY.PENDING_EXPIRED"), expiredNow);
      expect(result.outcome).toBe("APPLIED");
      expect(result.controlState).toBe("RIM.LOBBY");
      expect(result.snapshot.extended.pendingExternalEntry).toBeNull();
      expect(result.snapshot.runtime.bootstrap.status).toBe("COMPLETE");
    });

    it("expired first-launch context cannot later auto-resolve via leftover pending", () => {
      const pending = firstLaunchPendingWorld();
      const entryAt = pending.extended.pendingExternalEntry!.entryTimestamp;
      const expiredNow = instantValue(entryAt) + PENDING_EXTERNAL_ENTRY_TTL_MS;
      const expired = applied(pending, defaultEvent("EXTERNAL_ENTRY.PENDING_EXPIRED"), expiredNow);
      expect(expired.snapshot.extended.pendingExternalEntry).toBeNull();
      expect(expired.snapshot.runtime.bootstrap.status).toBe("COMPLETE");
      expect(expired.controlState).toBe("RIM.LOBBY");
      // No pending External Entry remains for reconnect auto-resolution after expiry.
      expect(expired.snapshot.extended.pendingExternalEntry).toBeNull();
    });
  });

  describe("D2 EXTERNAL_ENTRY_GUARD_B", () => {
    it("current user + processed Incoming → Guard B STAY without new Incoming or reactivation", () => {
      const snapshot = externalEntryIncomingWorld({
        incomingLifecycle: "PROCESSED",
        ban: { receiverId: USER_ID },
      });
      const beforeItems = Object.keys(snapshot.extended.entities.notificationItems).length;
      const result = applied(snapshot, guardAResolvedEvent());
      expect(result.outcome).toBe("APPLIED");
      expect(result.result).toBe("STAY");
      expect(result.controlState).toBe("CREATE_BAN.WHAT.RIM");
      expect(Object.keys(result.snapshot.extended.entities.notificationItems)).toHaveLength(
        beforeItems,
      );
      expect(
        result.snapshot.extended.entities.notificationItems[INCOMING_ITEM_ID]?.lifecycle.status,
      ).toBe("PROCESSED");
      expect(result.snapshot.extended.activeNotificationItemId).toBeNull();
    });

    it("processed Incoming but Ban bound to a different user → Guard B false", () => {
      const snapshot = externalEntryIncomingWorld({
        incomingLifecycle: "PROCESSED",
        ban: { receiverId: OTHER_USER },
      });
      const result = applied(snapshot, guardAResolvedEvent());
      expect(result.result).not.toBe("STAY");
      expect(result.outcome).not.toBe("APPLIED");
    });

    it("Ban bound to current user but Incoming unprocessed → Guard A, not Guard B", () => {
      const snapshot = externalEntryIncomingWorld({
        incomingLifecycle: "UNPROCESSED",
        ban: { receiverId: USER_ID },
      });
      const result = applied(snapshot, guardAResolvedEvent());
      expect(result.outcome).toBe("APPLIED");
      expect(result.result).toBe("TRANSITION");
      expect(result.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    });

    it("missing receiver binding + processed Incoming → Guard B false", () => {
      const snapshot = externalEntryIncomingWorld({
        incomingLifecycle: "PROCESSED",
        ban: { receiverId: null },
      });
      const result = applied(snapshot, guardAResolvedEvent());
      expect(result.outcome).not.toBe("APPLIED");
    });
  });

  describe("D3 supersededByExternalEntry on successful E-45", () => {
    it("marks older CREATE_BAN_SEND and late E-10 applies facts without restoring Success UI", () => {
      const createdBanId = branded<BanId>("ban-created-contact");
      const before = createBanPendingWorld();
      expect(before.runtime.pendingOperations[OP_ID]?.supersededByExternalEntry).toBe(false);
      const afterE45 = applySuccessfulE45From(before);
      expect(afterE45.outcome).toBe("APPLIED");
      expect(afterE45.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
      expect(afterE45.snapshot.runtime.pendingOperations[OP_ID]?.supersededByExternalEntry).toBe(
        true,
      );

      const late = applied(
        afterE45.snapshot,
        eventOf("CREATE_BAN.SEND_CONFIRMED", {
          operationId: OP_ID,
          createdBanId,
        }),
      );
      expect(late.outcome).toBe("APPLIED");
      expect(late.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
      expect(late.snapshot.extended.entities.bans[createdBanId]?.banText).toBe("no phones");
      expect(late.snapshot.extended.entities.bans[createdBanId]?.receiverId).toBe(CONTACT_A);
      expect(late.controlState).not.toBe("CREATE_BAN.SUCCESS");
    });

    it("marks older OVERBOARD and late E-20 applies once without Status Priority displace", () => {
      let snapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.INCOMING_BAN");
      snapshot = withEntities(snapshot, {
        bans: {
          [BAN_ID]: makeBan({
            senderId: OTHER_USER,
            receiverId: USER_ID,
            acceptance: "PENDING",
            status: null,
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
      snapshot = withOperation(
        snapshot,
        pendingOp({
          kind: "OVERBOARD",
          originatingState: "NOTIFICATIONS.INCOMING_BAN",
          originatingItemId: INCOMING_ITEM_ID,
        }),
      );

      const afterE45 = applied(snapshot, guardAResolvedEvent());
      expect(afterE45.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
      expect(afterE45.snapshot.runtime.pendingOperations[OP_ID]?.supersededByExternalEntry).toBe(
        true,
      );

      const late = applied(afterE45.snapshot, defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"));
      expect(late.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
      expect(late.snapshot.extended.entities.bans[BAN_ID]?.status).toBe("OVERBOARD");
      expect(late.snapshot.extended.priorities.statusItemId).toBeNull();
      expect(
        statusItems(late.snapshot).every(
          (item) => item.lifecycle.status === "UNPROCESSED" && item.lifecycle.display === "WAITING",
        ),
      ).toBe(true);
    });

    it("marks older CHECK_ANSWER and late E-22 applies FIRST facts without restoring Check UI", () => {
      const check = checkWorld("SENDER", false);
      const afterE45 = applySuccessfulE45From(check);
      expect(afterE45.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
      expect(afterE45.snapshot.runtime.pendingOperations[OP_ID]?.supersededByExternalEntry).toBe(
        true,
      );

      const late = applied(
        afterE45.snapshot,
        eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
          checkItemId: CHECK_SENDER_ITEM_ID,
          answer: "FULFILLED",
          checkPairId: PAIR_ID,
        }),
      );
      expect(late.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
      expect(late.snapshot.extended.entities.checkPairs[PAIR_ID]?.senderAnswer).toBe("FULFILLED");
      expect(late.snapshot.extended.priorities.statusItemId).toBeNull();
      expect(statusItems(late.snapshot)).toEqual([]);
    });

    it("marks older CHECK_ANSWER and late E-23 applies SECOND facts without Status Priority displace", () => {
      const check = checkWorld("RECEIVER", true);
      const afterE45 = applySuccessfulE45From(check);
      expect(afterE45.snapshot.runtime.pendingOperations[OP_ID]?.supersededByExternalEntry).toBe(
        true,
      );

      const late = applied(
        afterE45.snapshot,
        eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND", {
          checkItemId: CHECK_ITEM_ID,
          answer: "FULFILLED",
          checkPairId: PAIR_ID,
          resultingStatus: "BANTASTIC",
        }),
      );
      expect(late.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
      expect(late.snapshot.extended.entities.checkPairs[PAIR_ID]?.resultingStatus).toBe(
        "BANTASTIC",
      );
      expect(statusItems(late.snapshot)).toHaveLength(2);
      expect(late.snapshot.extended.priorities.statusItemId).toBeNull();
    });

    it("marks older REPLY_BAN_SEND and late E-30 applies Ban facts without restoring Reply UI", () => {
      const reply = replyWorld();
      const afterE45 = applySuccessfulE45From(reply);
      expect(afterE45.snapshot.runtime.pendingOperations[OP_ID]?.supersededByExternalEntry).toBe(
        true,
      );

      const late = applied(
        afterE45.snapshot,
        eventOf("REPLY_BAN.SEND_CONFIRMED", {
          operationId: OP_ID,
          replyBanId: REPLY_BAN_ID,
          source: { kind: "INCOMING_BAN", itemId: INCOMING_ITEM_ID, banId: BAN_ID },
        }),
      );
      expect(late.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
      expect(late.snapshot.extended.entities.bans[REPLY_BAN_ID]?.banText).toBe("reply text");
      expect(late.snapshot.extended.priorities.timerItemId).toBeNull();
      expect(Object.values(late.snapshot.extended.entities.domainTimers)).toHaveLength(1);
    });

    it("operation started after successful E-45 is not marked superseded", () => {
      const afterE45 = applySuccessfulE45From(
        withControlState(emptySnapshot(), "CREATE_BAN.WHAT.RIM"),
      );
      expect(afterE45.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
      expect(afterE45.snapshot.runtime.pendingOperations[OP_AFTER]).toBeUndefined();

      const withNewOp = withOperation(
        afterE45.snapshot,
        pendingOp({
          operationId: OP_AFTER,
          kind: "OVERBOARD",
          originatingState: "NOTIFICATIONS.INCOMING_BAN",
          originatingItemId: INCOMING_ITEM_ID,
          supersededByExternalEntry: false,
        }),
      );
      expect(withNewOp.runtime.pendingOperations[OP_AFTER]?.supersededByExternalEntry).toBe(false);
      expect(
        Object.values(withNewOp.runtime.pendingOperations).every(
          (operation) =>
            operation.operationId !== OP_AFTER || operation.supersededByExternalEntry === false,
        ),
      ).toBe(true);
    });
  });
});
