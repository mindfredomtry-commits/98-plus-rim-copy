import { describe, expect, it } from "vitest";
import { MATRIX_CONTRACT_ROWS, reduce } from "./index.ts";
import type { Ban, CheckPair } from "./entities.ts";
import type { CanonicalEvent } from "./events.ts";
import type { ProductSnapshot } from "./extended-state.ts";
import type {
  BanId,
  CheckPairId,
  DomainTimerId,
  DurationMinutes,
  NotificationItemId,
} from "./ids.ts";
import type { CheckDerivedStatus } from "./primitives.ts";
import {
  BAN_ID,
  CHECK_ITEM_ID,
  CHECK_SENDER_ITEM_ID,
  CONTACT_A,
  CONTACT_B,
  INCOMING_ITEM_ID,
  OP_ID,
  OTHER_USER,
  REPLY_BAN_ID,
  SHARE_ATTEMPT_ID,
  STATUS_ITEM_ID,
  TIMER_ITEM_ID,
  USER_ID,
  branded,
  checkItem,
  defaultEvent,
  eventOf,
  incomingItem,
  kernelContext,
  makeBan,
  makeChat,
  makeTimer,
  pendingOp,
  readyContext,
  shareOp,
  statusItem,
  timerItem,
  validCreateDraft,
  withChat,
  withControlState,
  withEntities,
  withItems,
  withOperation,
} from "./kernel.fixtures.ts";
import { asInstant, emptySnapshot } from "./kernel/snapshot.ts";

const PAIR_ID = branded<CheckPairId>("pair-1");

function applied(snapshot: ProductSnapshot, event: CanonicalEvent) {
  return reduce(snapshot, event, kernelContext());
}

function durationWorld(options?: {
  ban?: Partial<Ban>;
  includeTimer?: boolean;
  timerStartedAt?: number;
}): ProductSnapshot {
  let snapshot = withControlState(emptySnapshot(), "RIM.LOBBY");
  snapshot = withEntities(snapshot, {
    bans: { [BAN_ID]: makeBan(options?.ban) },
    ...(options?.includeTimer === false
      ? {}
      : {
          domainTimers: {
            "timer-1": makeTimer({
              startedAt: asInstant(options?.timerStartedAt ?? 0),
            }),
          },
        }),
  });
  return snapshot;
}

function expectNoE42Mutation(before: ProductSnapshot, result: ReturnType<typeof applied>) {
  expect(result.outcome).toBe("KERNEL_INVARIANT");
  expect(result.error?.code).toBe("NO_BRANCH_MATCHED");
  expect(result.traces.some((trace) => trace.eventId === "E-42")).toBe(false);
  expect(Object.values(result.snapshot.extended.entities.checkPairs)).toEqual(
    Object.values(before.extended.entities.checkPairs),
  );
  expect(
    Object.values(result.snapshot.extended.entities.notificationItems).filter(
      (item) => item.kind === "CHECK",
    ),
  ).toHaveLength(
    Object.values(before.extended.entities.notificationItems).filter(
      (item) => item.kind === "CHECK",
    ).length,
  );
  expect(result.snapshot.extended.entities.bans[BAN_ID]).toEqual(
    before.extended.entities.bans[BAN_ID],
  );
  expect(result.snapshot.extended.entities.domainTimers).toEqual(
    before.extended.entities.domainTimers,
  );
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

function statusItems(snapshot: ProductSnapshot) {
  return Object.values(snapshot.extended.entities.notificationItems).filter(
    (item) => item.kind === "STATUS",
  );
}

function replyIncomingItems(snapshot: ProductSnapshot, replyBanId: BanId = REPLY_BAN_ID) {
  return Object.values(snapshot.extended.entities.notificationItems).filter(
    (item) =>
      item.kind === "INCOMING_BAN" && item.banId === replyBanId && item.ownerId === OTHER_USER,
  );
}

function incomingOverboardWorld(options?: { withPending?: boolean }): ProductSnapshot {
  let snapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.INCOMING_BAN");
  snapshot = withEntities(snapshot, {
    bans: {
      [BAN_ID]: makeBan({ senderId: OTHER_USER, receiverId: USER_ID, acceptance: "PENDING" }),
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

function pendingOverboard(snapshot: ProductSnapshot) {
  return Object.values(snapshot.runtime.pendingOperations).find(
    (operation) => operation.kind === "OVERBOARD",
  );
}

function replyWorld(origin: "INCOMING_BAN" | "STATUS"): ProductSnapshot {
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
    }),
  );
}

describe("Stage 2 semantic effect audit", () => {
  it("E-22 FIRST persists the first Check answer without Status and marks CHECK_ANSWER applied", () => {
    const snapshot = checkWorld("RECEIVER", false);
    const event = eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
      checkItemId: CHECK_ITEM_ID,
      answer: "FULFILLED",
      checkPairId: PAIR_ID,
    });
    const result = applied(snapshot, event);
    expect(result.outcome).toBe("APPLIED");
    expect(result.traces.some((trace) => trace.eventId === "E-22")).toBe(true);
    const pair = result.snapshot.extended.entities.checkPairs[PAIR_ID];
    expect(
      result.snapshot.extended.entities.notificationItems[CHECK_ITEM_ID]?.lifecycle.status,
    ).toBe("PROCESSED");
    expect(pair?.receiverAnswer).toBe("FULFILLED");
    expect(pair?.senderAnswer).toBeNull();
    expect(pair?.resultingStatus).toBeNull();
    expect(result.snapshot.extended.entities.bans[BAN_ID]?.status).toBeNull();
    expect(statusItems(result.snapshot)).toEqual([]);
    expect(result.snapshot.runtime.pendingOperations[OP_ID]?.resultApplied).toBe(true);
    expect(result.effects.some((effect) => effect.type === "MARK_OPERATION_RESULT_APPLIED")).toBe(
      true,
    );

    const duplicate = applied(result.snapshot, event);
    expect(duplicate.outcome).not.toBe("APPLIED");
    expect(duplicate.snapshot.extended.entities.checkPairs[PAIR_ID]?.receiverAnswer).toBe(
      "FULFILLED",
    );
    expect(duplicate.snapshot.extended.entities.checkPairs[PAIR_ID]?.senderAnswer).toBeNull();
    expect(duplicate.snapshot.extended.entities.checkPairs[PAIR_ID]?.resultingStatus).toBeNull();
    expect(
      duplicate.snapshot.extended.entities.notificationItems[CHECK_ITEM_ID]?.lifecycle.status,
    ).toBe("PROCESSED");
    expect(statusItems(duplicate.snapshot)).toEqual([]);
    expect(duplicate.snapshot.runtime.pendingOperations[OP_ID]?.resultApplied).toBe(true);
  });

  it("late E-22 applies FIRST facts once, marks CHECK_ANSWER applied, and does not restore Check UI", () => {
    const check = checkWorld("SENDER", false);
    const snapshot = {
      ...withOperation(
        check,
        pendingOp({
          kind: "CHECK_ANSWER",
          originatingState: "NOTIFICATIONS.CHECK.SENDER",
          originatingItemId: CHECK_SENDER_ITEM_ID,
          supersededByExternalEntry: true,
        }),
      ),
      controlState: "NOTIFICATIONS.INCOMING_BAN" as const,
    };
    const result = applied(
      snapshot,
      eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
        checkItemId: CHECK_SENDER_ITEM_ID,
        answer: "FULFILLED",
        checkPairId: PAIR_ID,
      }),
    );
    expect(result.outcome).toBe("APPLIED");
    expect(result.composition).toBe("GLOBAL_THEN_LOCAL");
    expect(result.traces[0]?.eventId).toBe("LATE_RESULT");
    expect(result.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(result.controlState).not.toBe("NOTIFICATIONS.CHECK.SENDER");
    expect(result.snapshot.extended.entities.checkPairs[PAIR_ID]?.senderAnswer).toBe("FULFILLED");
    expect(result.snapshot.extended.entities.checkPairs[PAIR_ID]?.receiverAnswer).toBeNull();
    expect(result.snapshot.extended.entities.checkPairs[PAIR_ID]?.resultingStatus).toBeNull();
    expect(statusItems(result.snapshot)).toEqual([]);
    expect(
      result.snapshot.extended.entities.notificationItems[CHECK_SENDER_ITEM_ID]?.lifecycle.status,
    ).toBe("PROCESSED");
    expect(result.snapshot.runtime.pendingOperations[OP_ID]?.resultApplied).toBe(true);
  });

  it.each([
    ["BANTASTIC", "FULFILLED", "NOTIFICATIONS.STATUS.BANTASTIC.RECEIVER"],
    ["BANFLICT", "NOT_FULFILLED", "NOTIFICATIONS.STATUS.BANFLICT.RECEIVER"],
    ["FAIR_ENOUGH", "NOT_FULFILLED", "NOTIFICATIONS.STATUS.FAIR_ENOUGH.RECEIVER"],
  ] as const)(
    "E-23 SECOND determines %s and creates two Status Items",
    (status, secondAnswer, nextState) => {
      const snapshot = checkWorld("RECEIVER", true);
      const event = eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND", {
        checkItemId: CHECK_ITEM_ID,
        answer: secondAnswer,
        checkPairId: PAIR_ID,
        resultingStatus: status as CheckDerivedStatus,
      });
      const result = applied(snapshot, event);
      expect(result.outcome).toBe("APPLIED");
      const pair = result.snapshot.extended.entities.checkPairs[PAIR_ID];
      expect(pair?.senderAnswer).toBe("FULFILLED");
      expect(pair?.receiverAnswer).toBe(secondAnswer);
      expect(pair?.resultingStatus).toBe(status);
      expect(result.snapshot.extended.entities.bans[BAN_ID]?.status).toBe(status);
      const items = statusItems(result.snapshot);
      expect(items).toHaveLength(2);
      const receiver = items.find((item) => item.kind === "STATUS" && item.role === "RECEIVER");
      const sender = items.find((item) => item.kind === "STATUS" && item.role === "SENDER");
      expect(receiver?.ownerId).toBe(USER_ID);
      expect(sender?.ownerId).toBe(OTHER_USER);
      expect(receiver?.banId).toBe(BAN_ID);
      expect(sender?.banId).toBe(BAN_ID);
      expect(receiver?.status).toBe(status);
      expect(sender?.status).toBe(status);
      expect(receiver?.id).not.toBe(sender?.id);
      expect(result.controlState).toBe(nextState);
      expect(result.snapshot.extended.priorities.statusItemId).toBe(receiver?.id);
      expect(result.snapshot.extended.activeNotificationItemId).toBe(receiver?.id);
      expect(receiver?.lifecycle).toEqual({ status: "UNPROCESSED", display: "ACTIVE" });
      expect(sender?.lifecycle).toEqual({ status: "UNPROCESSED", display: "WAITING" });
      expect(result.snapshot.runtime.pendingOperations[OP_ID]?.resultApplied).toBe(true);

      const duplicate = applied(result.snapshot, event);
      expect(statusItems(duplicate.snapshot)).toHaveLength(2);
      expect(Object.keys(duplicate.snapshot.extended.entities.checkPairs)).toEqual([PAIR_ID]);
      expect(
        Object.values(duplicate.snapshot.extended.entities.bans).filter(
          (ban) => ban.status === status,
        ),
      ).toHaveLength(1);
    },
  );

  function e23Second(status: CheckDerivedStatus = "BANTASTIC") {
    return eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND", {
      checkItemId: CHECK_ITEM_ID,
      answer: "FULFILLED",
      checkPairId: PAIR_ID,
      resultingStatus: status,
    });
  }

  function expectNoE23Mutation(before: ProductSnapshot, result: ReturnType<typeof applied>) {
    expect(result.snapshot.extended.entities.checkPairs).toEqual(
      before.extended.entities.checkPairs,
    );
    expect(result.snapshot.extended.entities.bans[BAN_ID]?.status).toBe(
      before.extended.entities.bans[BAN_ID]?.status ?? null,
    );
    expect(statusItems(result.snapshot)).toEqual(statusItems(before));
    expect(result.snapshot.extended.priorities.statusItemId).toBe(
      before.extended.priorities.statusItemId,
    );
    expect(result.effects).toEqual([]);
  }

  it("E-23 VALID requires a matching unapplied CHECK_ANSWER and then marks it applied", () => {
    const snapshot = checkWorld("RECEIVER", true);
    expect(snapshot.runtime.pendingOperations[OP_ID]?.kind).toBe("CHECK_ANSWER");
    expect(snapshot.runtime.pendingOperations[OP_ID]?.resultApplied).toBe(false);
    expect(snapshot.runtime.pendingOperations[OP_ID]?.originatingItemId).toBe(CHECK_ITEM_ID);
    const result = applied(snapshot, e23Second());
    expect(result.outcome).toBe("APPLIED");
    expect(result.snapshot.extended.entities.checkPairs[PAIR_ID]?.resultingStatus).toBe(
      "BANTASTIC",
    );
    expect(statusItems(result.snapshot)).toHaveLength(2);
    expect(result.snapshot.extended.priorities.statusItemId).not.toBeNull();
    expect(result.snapshot.runtime.pendingOperations[OP_ID]?.resultApplied).toBe(true);
  });

  it("E-23 with no matching CHECK_ANSWER does not apply resultingStatus alone", () => {
    const base = checkWorld("RECEIVER", true);
    const snapshot = {
      ...base,
      runtime: { ...base.runtime, pendingOperations: {} },
    };
    const result = applied(snapshot, e23Second());
    expect(result.outcome).toBe("KERNEL_INVARIANT");
    expect(result.error?.code).toBe("NO_BRANCH_MATCHED");
    expectNoE23Mutation(snapshot, result);
  });

  it("E-23 with a different CHECK_ANSWER operation does not mutate Check/Status", () => {
    const snapshot = withOperation(
      checkWorld("RECEIVER", true),
      pendingOp({
        kind: "CHECK_ANSWER",
        originatingState: "NOTIFICATIONS.CHECK.RECEIVER",
        originatingItemId: CHECK_SENDER_ITEM_ID,
      }),
    );
    const result = applied(snapshot, e23Second());
    expect(result.outcome).toBe("KERNEL_INVARIANT");
    expect(result.error?.code).toBe("NO_BRANCH_MATCHED");
    expectNoE23Mutation(snapshot, result);
  });

  it("E-23 whose matching operation is already applied does not replay Status effects", () => {
    const snapshot = withOperation(
      checkWorld("RECEIVER", true),
      pendingOp({
        kind: "CHECK_ANSWER",
        originatingState: "NOTIFICATIONS.CHECK.RECEIVER",
        originatingItemId: CHECK_ITEM_ID,
        resultApplied: true,
      }),
    );
    const result = applied(snapshot, e23Second());
    expect(result.outcome).toBe("KERNEL_INVARIANT");
    expect(result.error?.code).toBe("NO_BRANCH_MATCHED");
    expectNoE23Mutation(snapshot, result);
  });

  it("E-23 stale/superseded follows the late-result rule", () => {
    const check = checkWorld("RECEIVER", true);
    const snapshot = {
      ...withOperation(
        check,
        pendingOp({
          kind: "CHECK_ANSWER",
          originatingState: "NOTIFICATIONS.CHECK.RECEIVER",
          originatingItemId: CHECK_ITEM_ID,
          supersededByExternalEntry: true,
        }),
      ),
      controlState: "NOTIFICATIONS.INCOMING_BAN" as const,
    };
    const result = applied(snapshot, e23Second());
    expect(result.outcome).toBe("APPLIED");
    expect(result.composition).toBe("GLOBAL_THEN_LOCAL");
    expect(result.traces[0]?.eventId).toBe("LATE_RESULT");
    expect(result.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(result.snapshot.extended.entities.checkPairs[PAIR_ID]?.resultingStatus).toBe(
      "BANTASTIC",
    );
    expect(statusItems(result.snapshot)).toHaveLength(2);
    expect(result.snapshot.extended.priorities.statusItemId).toBeNull();
    expect(
      statusItems(result.snapshot).every(
        (item) => item.lifecycle.status === "UNPROCESSED" && item.lifecycle.display === "WAITING",
      ),
    ).toBe(true);
    expect(result.snapshot.runtime.pendingOperations[OP_ID]?.resultApplied).toBe(true);
  });

  it("E-30 FROM_INCOMING_BAN creates the Reply Ban from replyBanDraft and starts the original Timer", () => {
    const snapshot = replyWorld("INCOMING_BAN");
    const result = applied(
      snapshot,
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId: OP_ID,
        replyBanId: REPLY_BAN_ID,
        source: { kind: "INCOMING_BAN", itemId: INCOMING_ITEM_ID, banId: BAN_ID },
      }),
    );
    expect(result.outcome).toBe("APPLIED");
    expect(result.controlState).toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
    const reply = result.snapshot.extended.entities.bans[REPLY_BAN_ID];
    expect(reply?.banText).toBe("reply text");
    expect(reply?.durationMinutes).toBe(15);
    expect(reply?.senderId).toBe(USER_ID);
    expect(reply?.receiverId).toBe(OTHER_USER);
    const replyIncoming = replyIncomingItems(result.snapshot);
    expect(replyIncoming).toHaveLength(1);
    expect(replyIncoming[0]?.kind).toBe("INCOMING_BAN");
    expect(replyIncoming[0]?.ownerId).toBe(OTHER_USER);
    expect(replyIncoming[0]?.ownerId).toBe(reply?.receiverId);
    expect(replyIncoming[0]?.banId).toBe(REPLY_BAN_ID);
    expect(replyIncoming[0]?.banId).toBe(reply?.id);
    expect(replyIncoming[0]?.lifecycle).toEqual({ status: "UNPROCESSED", display: "WAITING" });
    expect(result.snapshot.extended.activeNotificationItemId).not.toBe(replyIncoming[0]?.id);
    expect(result.controlState).not.toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(
      result.snapshot.extended.entities.notificationItems[INCOMING_ITEM_ID]?.lifecycle.status,
    ).toBe("PROCESSED");
    expect(result.snapshot.extended.entities.bans[BAN_ID]?.acceptance).toBe("ACCEPTED");
    const timers = Object.values(result.snapshot.extended.entities.domainTimers);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.banId).toBe(BAN_ID);
    expect(timers[0]?.banId).not.toBe(REPLY_BAN_ID);
    expect(timers[0]?.durationMinutes).toBe(12);
    expect(timers[0]?.startedAt).toBe(kernelContext().now);
    const timerItems = Object.values(result.snapshot.extended.entities.notificationItems).filter(
      (item) => item.kind === "TIMER",
    );
    expect(timerItems).toHaveLength(1);
    expect(timerItems[0]?.banId).toBe(BAN_ID);
    expect(timerItems[0]?.banId).not.toBe(REPLY_BAN_ID);
    expect(timerItems[0]?.id).not.toBe(replyIncoming[0]?.id);
    expect(result.snapshot.extended.priorities.timerItemId).toBe(timerItems[0]?.id);
    expect(result.snapshot.extended.priorities.timerItemId).not.toBe(replyIncoming[0]?.id);
    expect(result.snapshot.runtime.pendingOperations[OP_ID]).toBeUndefined();
    expect(result.snapshot.extended.replyBanDraft).toBeNull();
  });

  it("duplicate E-30 FROM_INCOMING_BAN does not create a second reply Incoming", () => {
    const event = eventOf("REPLY_BAN.SEND_CONFIRMED", {
      operationId: OP_ID,
      replyBanId: REPLY_BAN_ID,
      source: { kind: "INCOMING_BAN", itemId: INCOMING_ITEM_ID, banId: BAN_ID },
    });
    const first = applied(replyWorld("INCOMING_BAN"), event);
    expect(first.outcome).toBe("APPLIED");
    expect(replyIncomingItems(first.snapshot)).toHaveLength(1);
    const second = applied(first.snapshot, event);
    expect(second.outcome).toBe("UNDEFINED");
    expect(
      Object.values(second.snapshot.extended.entities.bans).filter(
        (ban) => ban.id === REPLY_BAN_ID,
      ),
    ).toHaveLength(1);
    expect(replyIncomingItems(second.snapshot)).toHaveLength(1);
    expect(second.snapshot.extended.replyBanDraft).toBeNull();
    expect(
      Object.values(second.snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "TIMER" && item.banId === BAN_ID,
      ),
    ).toHaveLength(1);

    const existingIncoming = incomingItem({
      id: branded<NotificationItemId>("reply-incoming-existing"),
      ownerId: OTHER_USER,
      banId: REPLY_BAN_ID,
      fifoSequence: 40,
      lifecycle: { status: "UNPROCESSED", display: "WAITING" },
    });
    const seeded = withItems(replyWorld("INCOMING_BAN"), [
      incomingItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }),
      existingIncoming,
    ]);
    const withExisting = applied(seeded, event);
    expect(withExisting.outcome).toBe("APPLIED");
    expect(replyIncomingItems(withExisting.snapshot)).toHaveLength(1);
    expect(replyIncomingItems(withExisting.snapshot)[0]?.id).toBe(existingIncoming.id);
    expect(
      Object.values(withExisting.snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "TIMER" && item.banId === BAN_ID,
      ),
    ).toHaveLength(1);
  });

  it("E-29 timer-still-unprocessed activates the created Timer Notification Item", () => {
    const confirmed = applied(
      replyWorld("INCOMING_BAN"),
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId: OP_ID,
        replyBanId: REPLY_BAN_ID,
        source: { kind: "INCOMING_BAN", itemId: INCOMING_ITEM_ID, banId: BAN_ID },
      }),
    );
    const more = applied(confirmed.snapshot, defaultEvent("REPLY_BAN.PRESS_FORBID_MORE"));
    expect(more.outcome).toBe("APPLIED");
    expect(more.controlState).toBe("NOTIFICATIONS.TIMER");
    const createdTimer = Object.values(more.snapshot.extended.entities.notificationItems).find(
      (item) => item.kind === "TIMER",
    );
    expect(createdTimer?.lifecycle.status).toBe("UNPROCESSED");
    expect(more.snapshot.extended.priorities.timerItemId).toBe(createdTimer?.id);
    expect(more.snapshot.extended.activeNotificationItemId).toBe(createdTimer?.id);
  });

  it("E-29 follows the source Ban Timer, not an unrelated unprocessed Timer", () => {
    const BAN_A_ID = branded<BanId>("ban-a");
    const TIMER_A_ITEM_ID = branded<NotificationItemId>("timer-item-a");
    const TIMER_A_ID = branded<DomainTimerId>("timer-a");

    const success = applied(
      replyWorld("INCOMING_BAN"),
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId: OP_ID,
        replyBanId: REPLY_BAN_ID,
        source: { kind: "INCOMING_BAN", itemId: INCOMING_ITEM_ID, banId: BAN_ID },
      }),
    ).snapshot;
    expect(success.extended.replySource?.banId).toBe(BAN_ID);

    const sourceTimer = Object.values(success.extended.entities.notificationItems).find(
      (item) => item.kind === "TIMER" && item.banId === BAN_ID && item.ownerId === USER_ID,
    );
    expect(sourceTimer?.lifecycle.status).toBe("UNPROCESSED");

    const timerFacts = (snapshot: ProductSnapshot) => {
      const items = Object.values(snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "TIMER",
      );
      const domain = Object.values(snapshot.extended.entities.domainTimers);
      return {
        items: items.map((item) => ({
          id: item.id,
          banId: item.banId,
          status: item.lifecycle.status,
        })),
        domain: domain.map((timer) => ({ id: timer.id, banId: timer.banId })),
      };
    };

    const withUnrelatedTimerA = (
      snapshot: ProductSnapshot,
      status: "UNPROCESSED" | "PROCESSED",
    ): ProductSnapshot => {
      const item = timerItem({
        id: TIMER_A_ITEM_ID,
        banId: BAN_A_ID,
        fifoSequence: 0,
        lifecycle:
          status === "UNPROCESSED"
            ? { status: "UNPROCESSED", display: "WAITING" }
            : { status: "PROCESSED" },
        domainTimerId: TIMER_A_ID,
      });
      return {
        ...snapshot,
        extended: {
          ...snapshot.extended,
          entities: {
            ...snapshot.extended.entities,
            bans: {
              ...snapshot.extended.entities.bans,
              [BAN_A_ID]: makeBan({
                id: BAN_A_ID,
                senderId: OTHER_USER,
                receiverId: USER_ID,
              }),
            },
            domainTimers: {
              ...snapshot.extended.entities.domainTimers,
              [TIMER_A_ID]: makeTimer({ id: TIMER_A_ID, banId: BAN_A_ID }),
            },
            notificationItems: {
              ...snapshot.extended.entities.notificationItems,
              [item.id]: item,
            },
          },
        },
      };
    };

    const withSourceTimerProcessed = (snapshot: ProductSnapshot): ProductSnapshot => ({
      ...snapshot,
      extended: {
        ...snapshot.extended,
        entities: {
          ...snapshot.extended.entities,
          notificationItems: {
            ...snapshot.extended.entities.notificationItems,
            [sourceTimer!.id]: { ...sourceTimer!, lifecycle: { status: "PROCESSED" } },
          },
        },
      },
    });

    const pressMore = (snapshot: ProductSnapshot) =>
      applied(snapshot, defaultEvent("REPLY_BAN.PRESS_FORBID_MORE"));

    const unprocessedOnlyB = pressMore(success);
    expect(unprocessedOnlyB.outcome).toBe("APPLIED");
    expect(unprocessedOnlyB.traces.map((trace) => `${trace.eventId}:${trace.branch}`)).toEqual([
      "E-29:timer-still-unprocessed",
    ]);
    expect(unprocessedOnlyB.controlState).toBe("NOTIFICATIONS.TIMER");
    expect(unprocessedOnlyB.snapshot.extended.activeNotificationItemId).toBe(sourceTimer?.id);
    expect(unprocessedOnlyB.snapshot.extended.priorities.timerItemId).toBe(sourceTimer?.id);
    expect(
      unprocessedOnlyB.snapshot.extended.entities.notificationItems[sourceTimer!.id]?.banId,
    ).toBe(BAN_ID);
    expect(timerFacts(unprocessedOnlyB.snapshot).items).toHaveLength(1);
    expect(timerFacts(unprocessedOnlyB.snapshot).domain).toHaveLength(1);

    const bothUnprocessed = pressMore(withUnrelatedTimerA(success, "UNPROCESSED"));
    expect(bothUnprocessed.outcome).toBe("APPLIED");
    expect(bothUnprocessed.traces.map((trace) => `${trace.eventId}:${trace.branch}`)).toEqual([
      "E-29:timer-still-unprocessed",
    ]);
    expect(bothUnprocessed.controlState).toBe("NOTIFICATIONS.TIMER");
    expect(bothUnprocessed.snapshot.extended.activeNotificationItemId).toBe(sourceTimer?.id);
    expect(bothUnprocessed.snapshot.extended.activeNotificationItemId).not.toBe(TIMER_A_ITEM_ID);
    expect(bothUnprocessed.snapshot.extended.priorities.timerItemId).toBe(sourceTimer?.id);
    expect(bothUnprocessed.snapshot.extended.priorities.timerItemId).not.toBe(TIMER_A_ITEM_ID);

    const processedBUnprocessedA = pressMore(
      withSourceTimerProcessed(withUnrelatedTimerA(success, "UNPROCESSED")),
    );
    expect(processedBUnprocessedA.outcome).toBe("APPLIED");
    expect(
      processedBUnprocessedA.traces.some((trace) => trace.branch === "timer-still-unprocessed"),
    ).toBe(false);
    expect(
      processedBUnprocessedA.traces.map((trace) => `${trace.eventId}:${trace.branch}`),
    ).toEqual(["E-29:timer-processed-other-items", "E-43:fifo-timer"]);
    expect(processedBUnprocessedA.controlState).toBe("NOTIFICATIONS.TIMER");
    expect(processedBUnprocessedA.snapshot.extended.activeNotificationItemId).toBe(TIMER_A_ITEM_ID);
    expect(processedBUnprocessedA.snapshot.extended.priorities.timerItemId).toBe(sourceTimer?.id);

    const extraIncoming = incomingItem({
      id: branded<NotificationItemId>("incoming-extra"),
      fifoSequence: 99,
      lifecycle: { status: "UNPROCESSED", display: "WAITING" },
    });
    const processedBIncoming = pressMore({
      ...withSourceTimerProcessed(success),
      extended: {
        ...withSourceTimerProcessed(success).extended,
        entities: {
          ...withSourceTimerProcessed(success).extended.entities,
          notificationItems: {
            ...withSourceTimerProcessed(success).extended.entities.notificationItems,
            [extraIncoming.id]: extraIncoming,
          },
        },
      },
    });
    expect(
      processedBIncoming.traces.some((trace) => trace.branch === "timer-still-unprocessed"),
    ).toBe(false);
    expect(processedBIncoming.traces.map((trace) => `${trace.eventId}:${trace.branch}`)).toEqual([
      "E-29:timer-processed-other-items",
      "E-43:fifo-incoming-ban",
    ]);
    expect(processedBIncoming.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(processedBIncoming.snapshot.extended.activeNotificationItemId).toBe(extraIncoming.id);

    const processedEmpty = pressMore(withSourceTimerProcessed(success));
    expect(processedEmpty.traces.map((trace) => `${trace.eventId}:${trace.branch}`)).toEqual([
      "E-29:timer-processed-queue-empty",
    ]);
    expect(processedEmpty.controlState).toBe("RIM.LOBBY");

    expect(
      timerFacts(bothUnprocessed.snapshot).items.filter((item) => item.banId === BAN_ID),
    ).toHaveLength(1);
    expect(
      timerFacts(bothUnprocessed.snapshot).domain.filter((timer) => timer.banId === BAN_ID),
    ).toHaveLength(1);
  });

  it("E-30 FROM_STATUS creates the Reply Ban without a Timer", () => {
    const snapshot = replyWorld("STATUS");
    const result = applied(
      snapshot,
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId: OP_ID,
        replyBanId: REPLY_BAN_ID,
        source: { kind: "STATUS", itemId: STATUS_ITEM_ID, banId: BAN_ID },
      }),
    );
    expect(result.outcome).toBe("APPLIED");
    expect(result.controlState).toBe("REPLY_BAN.SUCCESS.FROM_STATUS");
    const reply = result.snapshot.extended.entities.bans[REPLY_BAN_ID];
    expect(reply?.banText).toBe("reply text");
    expect(reply?.durationMinutes).toBe(15);
    expect(reply?.receiverId).toBe(OTHER_USER);
    const replyIncoming = replyIncomingItems(result.snapshot);
    expect(replyIncoming).toHaveLength(1);
    expect(replyIncoming[0]?.ownerId).toBe(OTHER_USER);
    expect(replyIncoming[0]?.banId).toBe(REPLY_BAN_ID);
    expect(replyIncoming[0]?.lifecycle).toEqual({ status: "UNPROCESSED", display: "WAITING" });
    expect(result.snapshot.extended.activeNotificationItemId).not.toBe(replyIncoming[0]?.id);
    expect(
      result.snapshot.extended.entities.notificationItems[STATUS_ITEM_ID]?.lifecycle.status,
    ).toBe("PROCESSED");
    expect(Object.values(result.snapshot.extended.entities.domainTimers)).toEqual([]);
    expect(
      Object.values(result.snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "TIMER",
      ),
    ).toEqual([]);
    expect(result.snapshot.extended.replyBanDraft).toBeNull();
    const duplicate = applied(
      result.snapshot,
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId: OP_ID,
        replyBanId: REPLY_BAN_ID,
        source: { kind: "STATUS", itemId: STATUS_ITEM_ID, banId: BAN_ID },
      }),
    );
    expect(duplicate.outcome).toBe("UNDEFINED");
    expect(replyIncomingItems(duplicate.snapshot)).toHaveLength(1);
    expect(Object.values(duplicate.snapshot.extended.entities.domainTimers)).toEqual([]);
    expect(duplicate.snapshot.extended.replyBanDraft).toBeNull();
  });

  it("E-30 without replyBanDraft is KERNEL_INVARIANT and invents no Ban", () => {
    const base = replyWorld("INCOMING_BAN");
    const snapshot = {
      ...base,
      extended: { ...base.extended, replyBanDraft: null },
    };
    const result = applied(
      snapshot,
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId: OP_ID,
        replyBanId: REPLY_BAN_ID,
        source: { kind: "INCOMING_BAN", itemId: INCOMING_ITEM_ID, banId: BAN_ID },
      }),
    );
    expect(result.outcome).toBe("KERNEL_INVARIANT");
    expect(result.error?.code).toBe("MISSING_REQUIRED_DATA");
    expect(result.snapshot.extended.entities.bans[REPLY_BAN_ID]).toBeUndefined();
  });

  it("E-30 without an other participant is KERNEL_INVARIANT and does not self-receive", () => {
    let snapshot = replyWorld("INCOMING_BAN");
    snapshot = withEntities(snapshot, {
      bans: {
        [BAN_ID]: makeBan({
          senderId: USER_ID,
          receiverId: USER_ID,
          acceptance: "PENDING",
          durationMinutes: 12 as DurationMinutes,
        }),
      },
    });
    const result = applied(
      snapshot,
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId: OP_ID,
        replyBanId: REPLY_BAN_ID,
        source: { kind: "INCOMING_BAN", itemId: INCOMING_ITEM_ID, banId: BAN_ID },
      }),
    );
    expect(result.outcome).toBe("KERNEL_INVARIANT");
    expect(result.error?.code).toBe("MISSING_REQUIRED_DATA");
    expect(result.snapshot.extended.entities.bans[REPLY_BAN_ID]).toBeUndefined();
  });

  it("Create Ban CONTACT uses createBanDraft and creates one Incoming Item for the receiver", () => {
    let snapshot = withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.CONTACT");
    const draft = validCreateDraft("CONTACT");
    snapshot = {
      ...snapshot,
      extended: { ...snapshot.extended, createBanDraft: draft },
    };
    snapshot = withOperation(snapshot, pendingOp());
    const result = applied(
      snapshot,
      eventOf("CREATE_BAN.SEND_CONFIRMED", { operationId: OP_ID, createdBanId: BAN_ID }),
    );
    expect(result.outcome).toBe("APPLIED");
    const ban = result.snapshot.extended.entities.bans[BAN_ID];
    expect(ban?.banText).toBe("no phones");
    expect(ban?.durationMinutes).toBe(3);
    expect(ban?.senderId).toBe(USER_ID);
    expect(draft.selectedContactId).toBe(CONTACT_A);
    expect(ban?.receiverId).toBe(draft.selectedContactId);
    expect(ban?.receiverId).toBe(CONTACT_A);
    const incoming = Object.values(result.snapshot.extended.entities.notificationItems).filter(
      (item) => item.kind === "INCOMING_BAN",
    );
    expect(incoming).toHaveLength(1);
    expect(incoming[0]?.ownerId).toBe(ban?.receiverId);
    expect(incoming[0]?.ownerId).toBe(CONTACT_A);
    expect(incoming[0]?.banId).toBe(BAN_ID);
    expect(incoming[0]?.kind).toBe("INCOMING_BAN");
    expect(incoming[0]?.lifecycle).toEqual({ status: "UNPROCESSED", display: "WAITING" });
    expect(result.snapshot.extended.activeNotificationItemId).not.toBe(incoming[0]?.id);
    expect(result.snapshot.extended.priorities.timerItemId).toBeNull();
  });

  it("Template E-12 creates the Ban from the Share draft only once", () => {
    let snapshot = withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    snapshot = {
      ...snapshot,
      extended: { ...snapshot.extended, createBanDraft: validCreateDraft("TEMPLATE") },
    };
    snapshot = withEntities(snapshot, {
      shareOperations: {
        [SHARE_ATTEMPT_ID]: shareOp({
          draft: {
            origin: "TEMPLATE",
            selectedContactId: null,
            banText: "share ban",
            durationMinutes: 21 as DurationMinutes,
          },
        }),
      },
    });
    const first = applied(
      snapshot,
      eventOf("CREATE_BAN.SHARE_CONFIRMED", {
        shareAttemptId: SHARE_ATTEMPT_ID,
        result: {} as import("./primitives.ts").ShareResult,
      }),
    );
    expect(first.outcome).toBe("APPLIED");
    const bans = Object.values(first.snapshot.extended.entities.bans);
    expect(bans).toHaveLength(1);
    expect(bans[0]?.banText).toBe("share ban");
    expect(bans[0]?.durationMinutes).toBe(21);
    expect(bans[0]?.receiverId).toBeNull();
    expect(first.snapshot.extended.entities.shareOperations[SHARE_ATTEMPT_ID]?.status).toBe(
      "CONFIRMED",
    );
    const second = applied(
      first.snapshot,
      eventOf("CREATE_BAN.SHARE_CONFIRMED", {
        shareAttemptId: SHARE_ATTEMPT_ID,
        result: {} as import("./primitives.ts").ShareResult,
      }),
    );
    expect(Object.values(second.snapshot.extended.entities.bans)).toHaveLength(1);

    const cancelled = applied(
      snapshot,
      eventOf("CREATE_BAN.SHARE_CANCELLED", { shareAttemptId: SHARE_ATTEMPT_ID }),
    );
    expect(cancelled.snapshot.extended.entities.shareOperations[SHARE_ATTEMPT_ID]?.status).toBe(
      "CANCELLED",
    );
    expect(cancelled.snapshot.extended.entities.shareOperations[SHARE_ATTEMPT_ID]?.status).not.toBe(
      "INVALIDATED",
    );
    const lateShare = applied(
      cancelled.snapshot,
      eventOf("CREATE_BAN.SHARE_CONFIRMED", {
        shareAttemptId: SHARE_ATTEMPT_ID,
        result: {} as import("./primitives.ts").ShareResult,
      }),
    );
    expect(lateShare.outcome).not.toBe("APPLIED");
    expect(Object.keys(lateShare.snapshot.extended.entities.bans)).toEqual([]);
  });

  it("E-32 processes the Timer Notification Item and leaves the domain Timer unchanged", () => {
    const timer = makeTimer();
    let snapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.TIMER");
    snapshot = withEntities(snapshot, {
      domainTimers: { "timer-1": timer },
      bans: { [BAN_ID]: makeBan() },
    });
    snapshot = withItems(snapshot, [
      timerItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }),
    ]);
    snapshot = {
      ...snapshot,
      extended: {
        ...snapshot.extended,
        activeNotificationItemId: TIMER_ITEM_ID,
        priorities: { statusItemId: null, timerItemId: TIMER_ITEM_ID },
      },
    };
    const result = applied(snapshot, defaultEvent("APP.FULL_CLOSE"));
    expect(result.outcome).toBe("APPLIED");
    expect(
      result.snapshot.extended.entities.notificationItems[TIMER_ITEM_ID]?.lifecycle.status,
    ).toBe("PROCESSED");
    expect(result.snapshot.extended.priorities.timerItemId).toBeNull();
    expect(result.snapshot.extended.entities.domainTimers["timer-1"]).toEqual(timer);
  });

  it("E-42 creates one Check pair with correct owners and is idempotent", () => {
    const snapshot = durationWorld();
    const event = defaultEvent("BAN.DURATION_EXPIRED");
    const first = applied(snapshot, event);
    expect(first.outcome).toBe("APPLIED");
    const pairs = Object.values(first.snapshot.extended.entities.checkPairs);
    expect(pairs).toHaveLength(1);
    const checks = Object.values(first.snapshot.extended.entities.notificationItems).filter(
      (item) => item.kind === "CHECK",
    );
    expect(checks).toHaveLength(2);
    expect(checks.find((item) => item.kind === "CHECK" && item.role === "RECEIVER")?.ownerId).toBe(
      OTHER_USER,
    );
    expect(checks.find((item) => item.kind === "CHECK" && item.role === "SENDER")?.ownerId).toBe(
      USER_ID,
    );
    const second = applied(first.snapshot, event);
    expect(second.outcome).toBe("KERNEL_INVARIANT");
    expect(second.error?.code).toBe("NO_BRANCH_MATCHED");
    expect(Object.values(second.snapshot.extended.entities.checkPairs)).toHaveLength(1);
    expect(
      Object.values(second.snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "CHECK",
      ),
    ).toHaveLength(2);
  });

  describe("E-42 eligible Ban kernel protection", () => {
    it("applies to an ACCEPTED Ban with an elapsed DomainTimer and no Check Pair", () => {
      const result = applied(durationWorld(), defaultEvent("BAN.DURATION_EXPIRED"));
      expect(result.outcome).toBe("APPLIED");
      expect(result.traces.some((trace) => trace.eventId === "E-42")).toBe(true);
      expect(Object.values(result.snapshot.extended.entities.checkPairs)).toHaveLength(1);
      expect(result.snapshot.extended.entities.bans[BAN_ID]?.acceptance).toBe("ACCEPTED");
      expect(result.snapshot.extended.entities.domainTimers["timer-1"]?.state).toBe("EXPIRED");
    });

    it("still applies after E-32 processed the Timer Notification Item", () => {
      const timer = makeTimer();
      let snapshot = durationWorld();
      snapshot = withItems(snapshot, [timerItem()]);
      snapshot = {
        ...snapshot,
        extended: {
          ...snapshot.extended,
          priorities: { statusItemId: null, timerItemId: TIMER_ITEM_ID },
        },
      };
      const closed = applied(snapshot, defaultEvent("APP.FULL_CLOSE"));
      expect(
        closed.snapshot.extended.entities.notificationItems[TIMER_ITEM_ID]?.lifecycle.status,
      ).toBe("PROCESSED");
      expect(closed.snapshot.extended.entities.domainTimers["timer-1"]).toEqual(timer);
      const reopened = withControlState(closed.snapshot, "RIM.LOBBY");
      const expired = applied(reopened, defaultEvent("BAN.DURATION_EXPIRED"));
      expect(expired.outcome).toBe("APPLIED");
      expect(expired.traces.some((trace) => trace.eventId === "E-42")).toBe(true);
      expect(Object.values(expired.snapshot.extended.entities.checkPairs)).toHaveLength(1);
      expect(expired.snapshot.extended.entities.domainTimers["timer-1"]?.state).toBe("EXPIRED");
    });

    it("does not apply to an OVERBOARD Ban", () => {
      const snapshot = durationWorld({
        ban: { acceptance: "PENDING", status: "OVERBOARD" },
      });
      expectNoE42Mutation(snapshot, applied(snapshot, defaultEvent("BAN.DURATION_EXPIRED")));
    });

    it("does not apply to a PENDING Ban that is not OVERBOARD", () => {
      const snapshot = durationWorld({ ban: { acceptance: "PENDING", status: null } });
      expectNoE42Mutation(snapshot, applied(snapshot, defaultEvent("BAN.DURATION_EXPIRED")));
    });

    it("does not apply to an ACCEPTED Ban without an authoritative DomainTimer", () => {
      const snapshot = durationWorld({ includeTimer: false });
      expectNoE42Mutation(snapshot, applied(snapshot, defaultEvent("BAN.DURATION_EXPIRED")));
    });

    it("does not apply before the authoritative DomainTimer has elapsed", () => {
      const snapshot = durationWorld({ timerStartedAt: 1_000_000 });
      expectNoE42Mutation(snapshot, applied(snapshot, defaultEvent("BAN.DURATION_EXPIRED")));
    });
  });

  it("E-15 starts OVERBOARD with resultApplied false", () => {
    const snapshot = incomingOverboardWorld({ withPending: false });
    const result = applied(snapshot, defaultEvent("NOTIFICATIONS.PRESS_OVERBOARD"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    const operation = pendingOverboard(result.snapshot);
    expect(operation).toMatchObject({
      kind: "OVERBOARD",
      originatingState: "NOTIFICATIONS.INCOMING_BAN",
      originatingItemId: INCOMING_ITEM_ID,
      resultApplied: false,
      supersededByExternalEntry: false,
    });
    expect(Object.keys(result.snapshot.runtime.pendingOperations)).toHaveLength(1);
  });

  it("OVERBOARD leaves the original Ban unaccepted and creates two Status Items", () => {
    const snapshot = incomingOverboardWorld();
    const before = pendingOverboard(snapshot);
    expect(before?.resultApplied).toBe(false);
    const result = applied(snapshot, defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"));
    expect(result.outcome).toBe("APPLIED");
    const ban = result.snapshot.extended.entities.bans[BAN_ID];
    expect(ban?.acceptance).toBe("PENDING");
    expect(ban?.status).toBe("OVERBOARD");
    expect(Object.values(result.snapshot.extended.entities.domainTimers)).toEqual([]);
    expect(
      Object.values(result.snapshot.extended.entities.notificationItems).some(
        (item) => item.kind === "TIMER",
      ),
    ).toBe(false);
    expect(Object.values(result.snapshot.extended.entities.checkPairs)).toEqual([]);
    const items = statusItems(result.snapshot);
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.kind === "STATUS" && item.status === "OVERBOARD")).toBe(true);
    expect(items.find((item) => item.kind === "STATUS" && item.role === "RECEIVER")?.ownerId).toBe(
      USER_ID,
    );
    expect(items.find((item) => item.kind === "STATUS" && item.role === "SENDER")?.ownerId).toBe(
      OTHER_USER,
    );
    const receiver = items.find((item) => item.kind === "STATUS" && item.role === "RECEIVER");
    const sender = items.find((item) => item.kind === "STATUS" && item.role === "SENDER");
    expect(result.snapshot.extended.priorities.statusItemId).toBe(receiver?.id);
    expect(result.snapshot.extended.activeNotificationItemId).toBe(receiver?.id);
    expect(result.snapshot.extended.activeNotificationItemId).not.toBe(sender?.id);
    expect(result.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    const after = pendingOverboard(result.snapshot);
    expect(after).toBeDefined();
    expect(after?.operationId).toBe(before?.operationId);
    expect(after).toMatchObject({
      kind: "OVERBOARD",
      originatingState: "NOTIFICATIONS.INCOMING_BAN",
      originatingItemId: INCOMING_ITEM_ID,
      resultApplied: true,
      supersededByExternalEntry: false,
    });
    expect(result.effects.some((effect) => effect.type === "CLEAR_OPERATION")).toBe(false);
    expect(result.effects.some((effect) => effect.type === "START_OPERATION")).toBe(false);
    expect(result.effects.some((effect) => effect.type === "MARK_OPERATION_RESULT_APPLIED")).toBe(
      true,
    );

    const duplicate = applied(result.snapshot, defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"));
    expect(duplicate.effects).toEqual([]);
    expect(statusItems(duplicate.snapshot)).toHaveLength(2);
    expect(Object.keys(duplicate.snapshot.extended.entities.bans)).toEqual([BAN_ID]);
    expect(duplicate.snapshot.extended.entities.bans[BAN_ID]?.acceptance).toBe("PENDING");
    expect(duplicate.snapshot.extended.entities.bans[BAN_ID]?.status).toBe("OVERBOARD");
    expect(duplicate.snapshot.extended.priorities.statusItemId).toBe(receiver?.id);
    expect(duplicate.snapshot.extended.activeNotificationItemId).toBe(receiver?.id);
    expect(duplicate.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(Object.values(duplicate.snapshot.extended.entities.domainTimers)).toEqual([]);
    expect(Object.values(duplicate.snapshot.extended.entities.checkPairs)).toEqual([]);
    expect(pendingOverboard(duplicate.snapshot)?.resultApplied).toBe(true);
    expect(pendingOverboard(duplicate.snapshot)?.operationId).toBe(before?.operationId);
  });

  it("E-19 К ЗАПРЕТАМ processes OVERBOARD RECEIVER Status then E-43 queue-empty to Lobby", () => {
    const overboarded = applied(
      incomingOverboardWorld(),
      defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"),
    );
    const receiver = statusItems(overboarded.snapshot).find((item) => item.role === "RECEIVER");
    const sender = statusItems(overboarded.snapshot).find((item) => item.role === "SENDER");
    expect(receiver?.lifecycle.status).toBe("UNPROCESSED");
    const result = applied(overboarded.snapshot, defaultEvent("NOTIFICATIONS.PRESS_TO_BANS"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.composition).toBe("LOCAL_THEN_E43");
    expect(result.traces.some((trace) => trace.eventId === "E-19")).toBe(true);
    expect(
      result.traces.some((trace) => trace.eventId === "E-43" && trace.branch === "queue-empty"),
    ).toBe(true);
    expect(result.controlState).toBe("RIM.LOBBY");
    expect(result.snapshot.extended.activeNotificationItemId).toBeNull();
    expect(
      result.snapshot.extended.entities.notificationItems[receiver!.id]?.lifecycle.status,
    ).toBe("PROCESSED");
    expect(result.snapshot.extended.entities.notificationItems[sender!.id]?.lifecycle.status).toBe(
      "UNPROCESSED",
    );
    expect(result.snapshot.extended.priorities.statusItemId).toBe(receiver?.id);
    expect(result.snapshot.extended.entities.bans[BAN_ID]?.acceptance).toBe("PENDING");
    expect(result.snapshot.extended.entities.bans[BAN_ID]?.status).toBe("OVERBOARD");
    expect(pendingOverboard(result.snapshot)?.resultApplied).toBe(true);
    expect(Object.values(result.snapshot.extended.entities.domainTimers)).toEqual([]);
    expect(Object.values(result.snapshot.extended.entities.checkPairs)).toEqual([]);
  });

  it("E-19 processes the active Status Item even when leftover replySource points at Incoming", () => {
    const overboarded = applied(
      incomingOverboardWorld(),
      defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"),
    );
    const receiver = statusItems(overboarded.snapshot).find((item) => item.role === "RECEIVER");
    const withLeftoverSource = {
      ...overboarded.snapshot,
      extended: {
        ...overboarded.snapshot.extended,
        replySource: {
          kind: "INCOMING_BAN" as const,
          itemId: INCOMING_ITEM_ID,
          banId: BAN_ID,
        },
      },
    };
    const result = applied(withLeftoverSource, defaultEvent("NOTIFICATIONS.PRESS_TO_BANS"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.controlState).toBe("RIM.LOBBY");
    expect(
      result.snapshot.extended.entities.notificationItems[receiver!.id]?.lifecycle.status,
    ).toBe("PROCESSED");
  });

  it("E-19 then E-43 fifo-incoming-ban when another unprocessed Incoming remains", () => {
    const overboarded = applied(
      incomingOverboardWorld(),
      defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"),
    );
    const extraIncomingId = branded<NotificationItemId>("incoming-2");
    const withSecond = withEntities(overboarded.snapshot, {
      notificationItems: {
        ...overboarded.snapshot.extended.entities.notificationItems,
        [extraIncomingId]: incomingItem({
          id: extraIncomingId,
          fifoSequence: 99,
          lifecycle: { status: "UNPROCESSED", display: "WAITING" },
          banId: branded<BanId>("ban-2"),
        }),
      },
    });
    const result = applied(withSecond, defaultEvent("NOTIFICATIONS.PRESS_TO_BANS"));
    expect(result.outcome).toBe("APPLIED");
    expect(
      result.traces.some(
        (trace) => trace.eventId === "E-43" && trace.branch === "fifo-incoming-ban",
      ),
    ).toBe(true);
    expect(result.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(result.snapshot.extended.activeNotificationItemId).toBe(extraIncomingId);
    expect(
      result.snapshot.extended.entities.notificationItems[INCOMING_ITEM_ID]?.lifecycle.status,
    ).toBe("PROCESSED");
    const receiver = statusItems(result.snapshot).find((item) => item.role === "RECEIVER");
    expect(
      result.snapshot.extended.entities.notificationItems[receiver!.id]?.lifecycle.status,
    ).toBe("PROCESSED");
  });

  it("E-20 whose matching operation is already applied does not replay OVERBOARD effects", () => {
    const snapshot = withOperation(
      incomingOverboardWorld({ withPending: false }),
      pendingOp({
        kind: "OVERBOARD",
        originatingState: "NOTIFICATIONS.INCOMING_BAN",
        originatingItemId: INCOMING_ITEM_ID,
        resultApplied: true,
      }),
    );
    const result = applied(snapshot, defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"));
    expect(result.outcome).toBe("KERNEL_INVARIANT");
    expect(result.error?.code).toBe("NO_BRANCH_MATCHED");
    expect(result.effects).toEqual([]);
    expect(result.snapshot.extended.entities.bans[BAN_ID]?.status).toBeNull();
    expect(statusItems(result.snapshot)).toEqual([]);
    expect(pendingOverboard(result.snapshot)?.resultApplied).toBe(true);
  });

  it("E-21 failure clears the OVERBOARD attempt without applying business results", () => {
    const snapshot = incomingOverboardWorld();
    const result = applied(snapshot, defaultEvent("NOTIFICATIONS.ACTION_FAILED"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(result.effects.some((effect) => effect.type === "CLEAR_OPERATION")).toBe(true);
    expect(result.effects.some((effect) => effect.type === "MARK_OPERATION_RESULT_APPLIED")).toBe(
      false,
    );
    expect(
      result.snapshot.extended.entities.notificationItems[INCOMING_ITEM_ID]?.lifecycle.status,
    ).toBe("UNPROCESSED");
    expect(result.snapshot.extended.entities.bans[BAN_ID]?.acceptance).toBe("PENDING");
    expect(result.snapshot.extended.entities.bans[BAN_ID]?.status).toBeNull();
    expect(statusItems(result.snapshot)).toEqual([]);
    expect(Object.values(result.snapshot.extended.entities.domainTimers)).toEqual([]);
    expect(Object.values(result.snapshot.extended.entities.checkPairs)).toEqual([]);
    expect(pendingOverboard(result.snapshot)).toBeUndefined();
    expect(result.snapshot.runtime.pendingOperations[OP_ID]).toBeUndefined();
  });

  it("E-15 after E-21 starts a new OVERBOARD attempt that E-20 can confirm", () => {
    const failed = applied(incomingOverboardWorld(), defaultEvent("NOTIFICATIONS.ACTION_FAILED"));
    const retry = applied(failed.snapshot, defaultEvent("NOTIFICATIONS.PRESS_OVERBOARD"));
    expect(retry.outcome).toBe("APPLIED");
    expect(retry.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    const attempt2 = pendingOverboard(retry.snapshot);
    expect(attempt2?.kind).toBe("OVERBOARD");
    expect(attempt2?.resultApplied).toBe(false);
    expect(attempt2?.operationId).not.toBe(OP_ID);
    expect(attempt2?.originatingItemId).toBe(INCOMING_ITEM_ID);
    expect(retry.snapshot.runtime.pendingOperations[OP_ID]).toBeUndefined();

    const staleSuccess = applied(
      retry.snapshot,
      eventOf("NOTIFICATIONS.OVERBOARD_CONFIRMED", {
        sourceItemId: INCOMING_ITEM_ID,
        banId: BAN_ID,
        operationId: OP_ID,
      }),
    );
    expect(staleSuccess.outcome).not.toBe("APPLIED");
    expect(staleSuccess.effects).toEqual([]);
    expect(staleSuccess.snapshot.extended.entities.bans[BAN_ID]?.status).toBeNull();
    expect(statusItems(staleSuccess.snapshot)).toEqual([]);
    expect(pendingOverboard(staleSuccess.snapshot)?.operationId).toBe(attempt2?.operationId);
    expect(pendingOverboard(staleSuccess.snapshot)?.resultApplied).toBe(false);

    const staleFailure = applied(retry.snapshot, defaultEvent("NOTIFICATIONS.ACTION_FAILED"));
    expect(staleFailure.outcome).not.toBe("APPLIED");
    expect(pendingOverboard(staleFailure.snapshot)?.operationId).toBe(attempt2?.operationId);
    expect(pendingOverboard(staleFailure.snapshot)?.resultApplied).toBe(false);
    expect(
      staleFailure.snapshot.extended.entities.notificationItems[INCOMING_ITEM_ID]?.lifecycle.status,
    ).toBe("UNPROCESSED");

    const confirmed = applied(
      retry.snapshot,
      eventOf("NOTIFICATIONS.OVERBOARD_CONFIRMED", {
        sourceItemId: INCOMING_ITEM_ID,
        banId: BAN_ID,
        operationId: attempt2!.operationId,
      }),
    );
    expect(confirmed.outcome).toBe("APPLIED");
    expect(confirmed.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(confirmed.snapshot.extended.entities.bans[BAN_ID]?.acceptance).toBe("PENDING");
    expect(confirmed.snapshot.extended.entities.bans[BAN_ID]?.status).toBe("OVERBOARD");
    expect(statusItems(confirmed.snapshot)).toHaveLength(2);
    const receiver = statusItems(confirmed.snapshot).find((item) => item.role === "RECEIVER");
    expect(confirmed.snapshot.extended.priorities.statusItemId).toBe(receiver?.id);
    expect(confirmed.snapshot.extended.activeNotificationItemId).toBe(receiver?.id);
    expect(pendingOverboard(confirmed.snapshot)?.operationId).toBe(attempt2?.operationId);
    expect(pendingOverboard(confirmed.snapshot)?.resultApplied).toBe(true);
  });

  it("E-20 does not match a non-OVERBOARD operation or a mismatched source/ban", () => {
    const wrongKind = withOperation(
      incomingOverboardWorld({ withPending: false }),
      pendingOp({
        kind: "CREATE_BAN_SEND",
        originatingState: "NOTIFICATIONS.INCOMING_BAN",
        originatingItemId: INCOMING_ITEM_ID,
      }),
    );
    const kindMismatch = applied(wrongKind, defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"));
    expect(kindMismatch.outcome).toBe("KERNEL_INVARIANT");
    expect(kindMismatch.snapshot.extended.entities.bans[BAN_ID]?.status).toBeNull();

    const itemMismatch = applied(
      incomingOverboardWorld(),
      eventOf("NOTIFICATIONS.OVERBOARD_CONFIRMED", {
        sourceItemId: branded<NotificationItemId>("incoming-other"),
        banId: BAN_ID,
        operationId: OP_ID,
      }),
    );
    expect(itemMismatch.outcome).toBe("KERNEL_INVARIANT");
    expect(itemMismatch.snapshot.extended.entities.bans[BAN_ID]?.status).toBeNull();

    const banMismatch = applied(
      incomingOverboardWorld(),
      eventOf("NOTIFICATIONS.OVERBOARD_CONFIRMED", {
        sourceItemId: INCOMING_ITEM_ID,
        banId: branded<BanId>("ban-other"),
        operationId: OP_ID,
      }),
    );
    expect(banMismatch.outcome).toBe("KERNEL_INVARIANT");
    expect(banMismatch.snapshot.extended.entities.bans[BAN_ID]?.status).toBeNull();
    expect(statusItems(banMismatch.snapshot)).toEqual([]);
  });

  it("late E-20/E-23/E-30 apply business entities once without displacing control state", () => {
    const incoming = withItems(withControlState(emptySnapshot(), "NOTIFICATIONS.INCOMING_BAN"), [
      incomingItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }),
    ]);

    const lateOverboardBase = {
      ...incoming,
      extended: { ...incoming.extended, activeNotificationItemId: INCOMING_ITEM_ID },
    };
    const lateOverboard = withOperation(
      withEntities(lateOverboardBase, {
        bans: {
          [BAN_ID]: makeBan({ senderId: OTHER_USER, receiverId: USER_ID, acceptance: "PENDING" }),
        },
      }),
      pendingOp({
        kind: "OVERBOARD",
        originatingState: "NOTIFICATIONS.INCOMING_BAN",
        supersededByExternalEntry: true,
      }),
    );
    const e20 = applied(lateOverboard, defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"));
    expect(e20.outcome).toBe("APPLIED");
    expect(e20.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(e20.snapshot.extended.entities.bans[BAN_ID]?.acceptance).toBe("PENDING");
    expect(e20.snapshot.extended.entities.bans[BAN_ID]?.status).toBe("OVERBOARD");
    expect(e20.snapshot.extended.priorities.statusItemId).toBeNull();
    expect(
      statusItems(e20.snapshot).every(
        (item) => item.lifecycle.status === "UNPROCESSED" && item.lifecycle.display === "WAITING",
      ),
    ).toBe(true);
    expect(pendingOverboard(e20.snapshot)).toMatchObject({
      operationId: OP_ID,
      kind: "OVERBOARD",
      originatingState: "NOTIFICATIONS.INCOMING_BAN",
      resultApplied: true,
      supersededByExternalEntry: true,
    });

    const lateCheck = withOperation(
      checkWorld("RECEIVER", true),
      pendingOp({
        kind: "CHECK_ANSWER",
        originatingState: "NOTIFICATIONS.CHECK.RECEIVER",
        originatingItemId: CHECK_ITEM_ID,
        supersededByExternalEntry: true,
      }),
    );
    const displacedCheck = {
      ...lateCheck,
      controlState: "NOTIFICATIONS.INCOMING_BAN" as const,
    };
    const e23 = applied(
      displacedCheck,
      eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND", {
        checkItemId: CHECK_ITEM_ID,
        answer: "FULFILLED",
        checkPairId: PAIR_ID,
        resultingStatus: "BANTASTIC",
      }),
    );
    expect(e23.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(e23.snapshot.extended.entities.checkPairs[PAIR_ID]?.resultingStatus).toBe("BANTASTIC");
    expect(statusItems(e23.snapshot)).toHaveLength(2);
    expect(e23.snapshot.extended.priorities.statusItemId).toBeNull();

    const lateReply = {
      ...replyWorld("INCOMING_BAN"),
      controlState: "NOTIFICATIONS.INCOMING_BAN" as const,
    };
    const lateReplyPending = withOperation(
      lateReply,
      pendingOp({
        kind: "REPLY_BAN_SEND",
        originatingState: "REPLY_BAN.CONFIRM.FROM_INCOMING_BAN",
        originatingItemId: INCOMING_ITEM_ID,
        supersededByExternalEntry: true,
      }),
    );
    const e30 = applied(
      lateReplyPending,
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId: OP_ID,
        replyBanId: REPLY_BAN_ID,
        source: { kind: "INCOMING_BAN", itemId: INCOMING_ITEM_ID, banId: BAN_ID },
      }),
    );
    expect(e30.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(e30.snapshot.extended.entities.bans[REPLY_BAN_ID]?.banText).toBe("reply text");
    expect(e30.snapshot.extended.priorities.timerItemId).toBeNull();
    expect(Object.values(e30.snapshot.extended.entities.domainTimers)).toHaveLength(1);
    const lateIncoming = replyIncomingItems(e30.snapshot);
    expect(lateIncoming).toHaveLength(1);
    expect(lateIncoming[0]?.lifecycle).toEqual({ status: "UNPROCESSED", display: "WAITING" });
    expect(e30.snapshot.extended.activeNotificationItemId).not.toBe(lateIncoming[0]?.id);
    expect(e30.snapshot.extended.activeNotificationItemId).toBe(INCOMING_ITEM_ID);
  });

  it("E-32 SESSION_END then late E-30 then E-33 opens RIM.LOBBY without restoring Reply Ban UI", () => {
    let snapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.INCOMING_BAN");
    snapshot = withEntities(snapshot, {
      bans: {
        [BAN_ID]: makeBan({ senderId: OTHER_USER, receiverId: USER_ID, acceptance: "PENDING" }),
      },
    });
    snapshot = withItems(snapshot, [
      incomingItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }),
    ]);
    snapshot = {
      ...snapshot,
      extended: { ...snapshot.extended, activeNotificationItemId: INCOMING_ITEM_ID },
    };
    snapshot = applied(snapshot, defaultEvent("NOTIFICATIONS.PRESS_REPLY_BAN")).snapshot;
    snapshot = applied(
      snapshot,
      eventOf("REPLY_BAN.CHANGE_BAN_TEXT", { banText: "reply text" }),
    ).snapshot;
    snapshot = applied(
      snapshot,
      eventOf("REPLY_BAN.CHANGE_DURATION", { durationMinutes: 15 as DurationMinutes }),
    ).snapshot;
    snapshot = applied(snapshot, defaultEvent("REPLY_BAN.PRESS_NEXT")).snapshot;
    const started = applied(snapshot, defaultEvent("REPLY_BAN.PRESS_FORBID"));
    expect(started.outcome).toBe("APPLIED");
    const pending = Object.values(started.snapshot.runtime.pendingOperations)[0];
    expect(pending?.kind).toBe("REPLY_BAN_SEND");
    expect(pending?.sendDraft).toMatchObject({ banText: "reply text", durationMinutes: 15 });
    const closed = applied(started.snapshot, defaultEvent("APP.FULL_CLOSE"));
    expect(closed.result).toBe("SESSION_END");
    expect(closed.snapshot.controlState).toBeNull();
    expect(closed.snapshot.runtime.session).toBe("CLOSED");
    expect(closed.snapshot.extended.replyBanDraft).toBeNull();
    const late = applied(
      closed.snapshot,
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId: pending!.operationId,
        replyBanId: REPLY_BAN_ID,
        source: closed.snapshot.extended.replySource!,
      }),
    );
    expect(late.outcome).toBe("APPLIED");
    expect(late.traces[0]?.eventId).toBe("LATE_RESULT");
    expect(late.controlState).toBeNull();
    expect(late.snapshot.extended.entities.bans[REPLY_BAN_ID]?.banText).toBe("reply text");
    expect(late.snapshot.extended.entities.bans[BAN_ID]?.acceptance).toBe("ACCEPTED");
    expect(
      late.snapshot.extended.entities.notificationItems[INCOMING_ITEM_ID]?.lifecycle.status,
    ).toBe("PROCESSED");
    const lateIncoming = replyIncomingItems(late.snapshot);
    expect(lateIncoming).toHaveLength(1);
    expect(lateIncoming[0]?.lifecycle).toEqual({ status: "UNPROCESSED", display: "WAITING" });
    expect(late.snapshot.extended.activeNotificationItemId).not.toBe(lateIncoming[0]?.id);
    const timerItem = Object.values(late.snapshot.extended.entities.notificationItems).find(
      (item) => item.kind === "TIMER",
    );
    expect(timerItem?.lifecycle).toEqual({ status: "UNPROCESSED", display: "WAITING" });
    expect(late.snapshot.extended.priorities.timerItemId).toBeNull();
    expect(Object.values(late.snapshot.extended.entities.domainTimers)[0]?.state).toBe("RUNNING");
    expect(late.snapshot.extended.replyBanDraft).toBeNull();
    const opened = applied(late.snapshot, defaultEvent("APP.NORMAL_OPEN"));
    expect(opened.outcome).toBe("APPLIED");
    expect(opened.controlState).toBe("RIM.LOBBY");
    expect(opened.snapshot.runtime.session).toBe("ACTIVE");
    expect(opened.snapshot.extended.replyBanDraft).toBeNull();
    expect(opened.controlState).not.toBe("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
    expect(opened.controlState).not.toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
    expect(opened.controlState).not.toBe("NOTIFICATIONS.TIMER");
    expect(opened.controlState).not.toBe("NOTIFICATIONS.INCOMING_BAN");
    const staleSource = opened.snapshot.extended.replySource;
    const staleActive = opened.snapshot.extended.activeNotificationItemId;
    expect(staleSource?.itemId).toBe(INCOMING_ITEM_ID);
    expect(staleActive).toBe(INCOMING_ITEM_ID);
    expect(
      opened.snapshot.extended.entities.notificationItems[INCOMING_ITEM_ID]?.lifecycle.status,
    ).toBe("PROCESSED");
    const fromLobby = applied(opened.snapshot, defaultEvent("NOTIFICATIONS.PRESS_REPLY_BAN"));
    expect(fromLobby.outcome).toBe("UNDEFINED");
    const notifications = applied(opened.snapshot, defaultEvent("RIM.PRESS_NOTIFICATIONS"));
    expect(notifications.outcome).toBe("APPLIED");
    expect(notifications.traces.some((trace) => trace.eventId === "E-43")).toBe(true);
    expect(notifications.controlState).toBe("NOTIFICATIONS.TIMER");
    expect(notifications.snapshot.extended.activeNotificationItemId).toBe(timerItem?.id);
    expect(notifications.snapshot.extended.activeNotificationItemId).not.toBe(INCOMING_ITEM_ID);
    expect(notifications.snapshot.extended.activeNotificationItemId).not.toBe(staleActive);
  });

  it("E-14 replaces leftover replySource from the newly active NotificationItem", () => {
    const incomingB = incomingItem({
      id: branded<NotificationItemId>("incoming-2"),
      banId: branded<BanId>("ban-2"),
      fifoSequence: 2,
      lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
    });
    let snapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.INCOMING_BAN");
    snapshot = withEntities(snapshot, {
      bans: {
        [BAN_ID]: makeBan({ senderId: OTHER_USER, receiverId: USER_ID, acceptance: "PENDING" }),
        [incomingB.banId]: makeBan({
          id: incomingB.banId,
          senderId: OTHER_USER,
          receiverId: USER_ID,
          acceptance: "PENDING",
        }),
      },
    });
    snapshot = withItems(snapshot, [
      incomingItem({ lifecycle: { status: "PROCESSED" } }),
      incomingB,
    ]);
    snapshot = {
      ...snapshot,
      extended: {
        ...snapshot.extended,
        activeNotificationItemId: incomingB.id,
        replySource: { kind: "INCOMING_BAN", itemId: INCOMING_ITEM_ID, banId: BAN_ID },
        replyBanDraft: null,
      },
    };
    const result = applied(snapshot, defaultEvent("NOTIFICATIONS.PRESS_REPLY_BAN"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(result.snapshot.extended.replySource).toEqual({
      kind: "INCOMING_BAN",
      itemId: incomingB.id,
      banId: incomingB.banId,
    });
    expect(result.snapshot.extended.replySource?.itemId).not.toBe(INCOMING_ITEM_ID);
    expect(result.snapshot.extended.replyBanDraft).toEqual({
      banText: "",
      durationMinutes: null,
    });
  });

  it("FULL_CLOSE without late E-30 then NORMAL_OPEN starts a new empty Reply Ban from E-43 FIFO", () => {
    let snapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.INCOMING_BAN");
    snapshot = withEntities(snapshot, {
      bans: {
        [BAN_ID]: makeBan({ senderId: OTHER_USER, receiverId: USER_ID, acceptance: "PENDING" }),
      },
    });
    snapshot = withItems(snapshot, [
      incomingItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }),
    ]);
    snapshot = {
      ...snapshot,
      extended: { ...snapshot.extended, activeNotificationItemId: INCOMING_ITEM_ID },
    };
    snapshot = applied(snapshot, defaultEvent("NOTIFICATIONS.PRESS_REPLY_BAN")).snapshot;
    snapshot = applied(
      snapshot,
      eventOf("REPLY_BAN.CHANGE_BAN_TEXT", { banText: "reply text" }),
    ).snapshot;
    snapshot = applied(
      snapshot,
      eventOf("REPLY_BAN.CHANGE_DURATION", { durationMinutes: 15 as DurationMinutes }),
    ).snapshot;
    snapshot = applied(snapshot, defaultEvent("REPLY_BAN.PRESS_NEXT")).snapshot;
    const started = applied(snapshot, defaultEvent("REPLY_BAN.PRESS_FORBID"));
    const closed = applied(started.snapshot, defaultEvent("APP.FULL_CLOSE"));
    const opened = applied(closed.snapshot, defaultEvent("APP.NORMAL_OPEN"));
    expect(opened.controlState).toBe("RIM.LOBBY");
    expect(opened.snapshot.extended.replyBanDraft).toBeNull();
    const notifications = applied(opened.snapshot, defaultEvent("RIM.PRESS_NOTIFICATIONS"));
    expect(notifications.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(notifications.snapshot.extended.activeNotificationItemId).toBe(INCOMING_ITEM_ID);
    expect(notifications.traces.some((trace) => trace.eventId === "E-43")).toBe(true);
    const reply = applied(notifications.snapshot, defaultEvent("NOTIFICATIONS.PRESS_REPLY_BAN"));
    expect(reply.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(reply.snapshot.extended.replySource).toEqual({
      kind: "INCOMING_BAN",
      itemId: INCOMING_ITEM_ID,
      banId: BAN_ID,
    });
    expect(reply.snapshot.extended.replyBanDraft).toEqual({
      banText: "",
      durationMinutes: null,
    });
  });

  it("MVP7. stale replyBanDraft + N-01 E-14 initializes a fresh empty draft for Incoming B", () => {
    const incomingB = incomingItem({
      id: branded<NotificationItemId>("incoming-b"),
      banId: branded<BanId>("ban-b"),
      fifoSequence: 2,
      lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
    });
    let snapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.INCOMING_BAN");
    snapshot = withEntities(snapshot, {
      bans: {
        [BAN_ID]: makeBan({ senderId: OTHER_USER, receiverId: USER_ID, acceptance: "PENDING" }),
        [incomingB.banId]: makeBan({
          id: incomingB.banId,
          senderId: OTHER_USER,
          receiverId: USER_ID,
          acceptance: "PENDING",
          banText: "source B",
        }),
      },
    });
    snapshot = withItems(snapshot, [
      incomingItem({ lifecycle: { status: "PROCESSED" } }),
      incomingB,
    ]);
    snapshot = {
      ...snapshot,
      extended: {
        ...snapshot.extended,
        activeNotificationItemId: incomingB.id,
        replySource: { kind: "INCOMING_BAN", itemId: INCOMING_ITEM_ID, banId: BAN_ID },
        replyBanDraft: { banText: "reply A", durationMinutes: 3 as DurationMinutes },
      },
    };
    const result = applied(snapshot, defaultEvent("NOTIFICATIONS.PRESS_REPLY_BAN"));
    expect(result.outcome).toBe("APPLIED");
    expect(result.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(result.snapshot.extended.replySource).toEqual({
      kind: "INCOMING_BAN",
      itemId: incomingB.id,
      banId: incomingB.banId,
    });
    expect(result.snapshot.extended.replyBanDraft).toEqual({
      banText: "",
      durationMinutes: null,
    });
    expect(result.snapshot.extended.replyBanDraft?.banText).not.toBe("reply A");
    expect(
      result.snapshot.extended.entities.notificationItems[incomingB.id]?.lifecycle.status,
    ).toBe("UNPROCESSED");
  });

  it("MVP7. receiver Status E-14 and sender Status E-18 initialize a fresh empty draft", () => {
    let receiver = withControlState(emptySnapshot(), "NOTIFICATIONS.STATUS.BANTASTIC.RECEIVER");
    receiver = withEntities(receiver, {
      bans: {
        [BAN_ID]: makeBan({
          senderId: OTHER_USER,
          receiverId: USER_ID,
          acceptance: "ACCEPTED",
          status: "BANTASTIC",
        }),
      },
    });
    receiver = withItems(receiver, [
      statusItem({
        role: "RECEIVER",
        status: "BANTASTIC",
        lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
      }),
    ]);
    receiver = {
      ...receiver,
      extended: {
        ...receiver.extended,
        activeNotificationItemId: STATUS_ITEM_ID,
        replyBanDraft: { banText: "stale reply", durationMinutes: 9 as DurationMinutes },
      },
    };
    const fromReceiver = applied(receiver, defaultEvent("NOTIFICATIONS.PRESS_REPLY_BAN"));
    expect(fromReceiver.outcome).toBe("APPLIED");
    expect(fromReceiver.controlState).toBe("REPLY_BAN.WHAT.FROM_STATUS");
    expect(fromReceiver.snapshot.extended.replySource?.kind).toBe("STATUS");
    expect(fromReceiver.snapshot.extended.replyBanDraft).toEqual({
      banText: "",
      durationMinutes: null,
    });

    let sender = withControlState(emptySnapshot(), "NOTIFICATIONS.STATUS.BANFLICT.SENDER");
    sender = withEntities(sender, {
      bans: {
        [BAN_ID]: makeBan({
          senderId: USER_ID,
          receiverId: OTHER_USER,
          acceptance: "ACCEPTED",
          status: "BANFLICT",
        }),
      },
    });
    const senderStatus = statusItem({
      id: branded<NotificationItemId>("status-sender-1"),
      role: "SENDER",
      status: "BANFLICT",
      lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
    });
    sender = withItems(sender, [senderStatus]);
    sender = {
      ...sender,
      extended: {
        ...sender.extended,
        activeNotificationItemId: senderStatus.id,
        replyBanDraft: { banText: "stale sender", durationMinutes: 11 as DurationMinutes },
      },
    };
    const fromSender = applied(sender, defaultEvent("NOTIFICATIONS.PRESS_BAN_MORE"));
    expect(fromSender.outcome).toBe("APPLIED");
    expect(fromSender.controlState).toBe("REPLY_BAN.WHAT.FROM_STATUS");
    expect(fromSender.snapshot.extended.replySource?.kind).toBe("STATUS");
    expect(fromSender.snapshot.extended.replyBanDraft).toEqual({
      banText: "",
      durationMinutes: null,
    });
  });

  it("MVP7. RB-02 E-27 Back preserves draft; E-31 preserves draft; E-27 What clears draft", () => {
    let snapshot = replyWorld("INCOMING_BAN");
    snapshot = {
      ...snapshot,
      controlState: "REPLY_BAN.CONFIRM.FROM_INCOMING_BAN",
      extended: {
        ...snapshot.extended,
        replyBanDraft: { banText: "draft B", durationMinutes: 7 as DurationMinutes },
      },
      runtime: { ...snapshot.runtime, pendingOperations: {} },
    };
    const backToWhat = applied(snapshot, defaultEvent("REPLY_BAN.PRESS_BACK"));
    expect(backToWhat.outcome).toBe("APPLIED");
    expect(backToWhat.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(backToWhat.snapshot.extended.replyBanDraft).toEqual({
      banText: "draft B",
      durationMinutes: 7,
    });

    const failed = applied(
      withOperation(
        {
          ...snapshot,
          extended: {
            ...snapshot.extended,
            replyBanDraft: { banText: "draft B", durationMinutes: 7 as DurationMinutes },
          },
        },
        pendingOp({
          kind: "REPLY_BAN_SEND",
          originatingState: "REPLY_BAN.CONFIRM.FROM_INCOMING_BAN",
          originatingItemId: INCOMING_ITEM_ID,
        }),
      ),
      defaultEvent("REPLY_BAN.SEND_FAILED"),
    );
    expect(failed.outcome).toBe("APPLIED");
    expect(failed.controlState).toBe("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
    expect(failed.snapshot.extended.replyBanDraft).toEqual({
      banText: "draft B",
      durationMinutes: 7,
    });
    expect(failed.snapshot.extended.entities.bans[REPLY_BAN_ID]).toBeUndefined();
    expect(
      failed.snapshot.extended.entities.notificationItems[INCOMING_ITEM_ID]?.lifecycle.status,
    ).toBe("UNPROCESSED");

    const abandon = applied(
      {
        ...backToWhat.snapshot,
        extended: {
          ...backToWhat.snapshot.extended,
          replyBanDraft: { banText: "draft B", durationMinutes: 7 as DurationMinutes },
        },
      },
      defaultEvent("REPLY_BAN.PRESS_BACK"),
    );
    expect(abandon.outcome).toBe("APPLIED");
    expect(abandon.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(abandon.snapshot.extended.replyBanDraft).toBeNull();
  });

  it("MVP7. late E-30 clears/keeps draft null without restoring Reply Ban UI", () => {
    let snapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.INCOMING_BAN");
    snapshot = withEntities(snapshot, {
      bans: {
        [BAN_ID]: makeBan({ senderId: OTHER_USER, receiverId: USER_ID, acceptance: "PENDING" }),
      },
    });
    snapshot = withItems(snapshot, [
      incomingItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }),
    ]);
    snapshot = {
      ...snapshot,
      extended: { ...snapshot.extended, activeNotificationItemId: INCOMING_ITEM_ID },
    };
    snapshot = applied(snapshot, defaultEvent("NOTIFICATIONS.PRESS_REPLY_BAN")).snapshot;
    snapshot = applied(
      snapshot,
      eventOf("REPLY_BAN.CHANGE_BAN_TEXT", { banText: "late reply" }),
    ).snapshot;
    snapshot = applied(
      snapshot,
      eventOf("REPLY_BAN.CHANGE_DURATION", { durationMinutes: 12 as DurationMinutes }),
    ).snapshot;
    snapshot = applied(snapshot, defaultEvent("REPLY_BAN.PRESS_NEXT")).snapshot;
    const started = applied(snapshot, defaultEvent("REPLY_BAN.PRESS_FORBID"));
    const pending = Object.values(started.snapshot.runtime.pendingOperations)[0];
    expect(pending?.sendDraft).toMatchObject({ banText: "late reply", durationMinutes: 12 });
    const closed = applied(started.snapshot, defaultEvent("APP.FULL_CLOSE"));
    expect(closed.snapshot.extended.replyBanDraft).toBeNull();
    const late = applied(
      closed.snapshot,
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId: pending!.operationId,
        replyBanId: REPLY_BAN_ID,
        source: closed.snapshot.extended.replySource!,
      }),
    );
    expect(late.outcome).toBe("APPLIED");
    expect(late.traces[0]?.eventId).toBe("LATE_RESULT");
    expect(late.controlState).toBeNull();
    expect(late.snapshot.extended.replyBanDraft).toBeNull();
    expect(late.controlState).not.toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
    expect(late.snapshot.extended.entities.bans[REPLY_BAN_ID]?.banText).toBe("late reply");
  });

  it("MVP7. E-32 and E-45 terminating Reply Ban clear draft", () => {
    const whatBase = {
      ...replyWorld("INCOMING_BAN"),
      controlState: "REPLY_BAN.WHAT.FROM_INCOMING_BAN" as const,
      runtime: {
        ...replyWorld("INCOMING_BAN").runtime,
        pendingOperations: {},
      },
      extended: {
        ...replyWorld("INCOMING_BAN").extended,
        replyBanDraft: { banText: "open draft", durationMinutes: 8 as DurationMinutes },
      },
    };
    const closed = applied(whatBase, defaultEvent("APP.FULL_CLOSE"));
    expect(closed.result).toBe("SESSION_END");
    expect(closed.snapshot.extended.replyBanDraft).toBeNull();

    const displaced = applied(whatBase, defaultEvent("TELEGRAM_SHARE_LINK.RESOLVED"));
    expect(displaced.outcome).toBe("APPLIED");
    expect(displaced.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(displaced.snapshot.extended.replyBanDraft).toBeNull();
  });

  it("E-49 change contact clears previous relationship content and starts loading", () => {
    const snapshot = withChat(
      withControlState(emptySnapshot(), "RIM.SELECT_CONTACT"),
      makeChat({
        selectedContactId: CONTACT_A,
        relationshipContext: readyContext(),
        messages: [{ kind: "USER", text: "old" }],
        inputDraft: "old-draft",
        aiOperation: { status: "FAILED", requestId: branded("ai-1"), failure: {} as never },
      }),
    );
    const before = snapshot.extended.rimChat;
    const result = applied(snapshot, eventOf("RIM.SELECT_CONTACT", { contactId: CONTACT_B }));
    expect(result.outcome).toBe("APPLIED");
    expect(result.traces[0]?.branch).toBe("change-selected-contact");
    expect(result.snapshot.extended.rimChat?.selectedContactId).toBe(CONTACT_B);
    expect(result.snapshot.extended.rimChat?.relationshipContext?.status).toBe("loading");
    expect(result.snapshot.extended.rimChat?.relationshipContext?.selectedContactId).toBe(
      CONTACT_B,
    );
    expect(result.snapshot.extended.rimChat?.messages).toEqual([]);
    expect(result.snapshot.extended.rimChat?.inputDraft).toBe("");
    expect(result.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect(result.effects.some((effect) => effect.type === "REQUEST_RELATIONSHIP_CONTEXT")).toBe(
      true,
    );
    expect(result.snapshot.extended.rimChat).not.toEqual(before);
  });

  it("E-49 same contact preserves conversation state and does not request context or Retry", () => {
    const chat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      messages: [{ kind: "RIM", text: "kept" }],
      inputDraft: "kept-draft",
      aiOperation: { status: "FAILED", requestId: branded("ai-1"), failure: {} as never },
    });
    const snapshot = withChat(withControlState(emptySnapshot(), "RIM.SELECT_CONTACT"), chat);
    const result = applied(snapshot, eventOf("RIM.SELECT_CONTACT", { contactId: CONTACT_A }));
    expect(result.outcome).toBe("APPLIED");
    expect(result.traces[0]?.branch).toBe("same-current-selected-contact");
    expect(result.snapshot.extended.rimChat).toEqual(chat);
    expect(result.effects.some((effect) => effect.type === "REQUEST_RELATIONSHIP_CONTEXT")).toBe(
      false,
    );
    expect(result.effects.some((effect) => effect.type === "REQUEST_RIM_AI")).toBe(false);
    expect(result.controlState).toBe("RIM.CHAT");
  });
});

describe("Stage 2 semantic audit inventory", () => {
  it("keeps every Matrix row identity available for the reachability suite", () => {
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(337);
  });
});
