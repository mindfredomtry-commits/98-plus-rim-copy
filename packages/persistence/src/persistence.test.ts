import { describe, expect, it } from "vitest";
import {
  emptySnapshot,
  reduce,
  type Ban,
  type CanonicalEvent,
  type CheckPair,
  type DurationMinutes,
  type ProductSnapshot,
  type TransitionResult,
} from "@98plus/product-model";
import {
  BAN_ID,
  CHECK_ITEM_ID,
  CHECK_SENDER_ITEM_ID,
  CONTACT_A,
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
  makeTimer,
  pendingOp,
  shareOp,
  statusItem,
  timerItem,
  validCreateDraft,
  withControlState,
  withEntities,
  withItems,
  withOperation,
} from "../../product-model/src/kernel.fixtures.ts";
import { asInstant } from "../../product-model/src/kernel/snapshot.ts";
import type { CheckDerivedStatus } from "../../product-model/src/primitives.ts";
import type { CheckPairId } from "../../product-model/src/ids.ts";
import { PersistenceError } from "./errors.ts";
import { PersistenceTestKit } from "./test-kit.ts";
import type { ProductStore } from "./types.ts";

const PAIR_ID = branded<CheckPairId>("pair-1");

function applied(snapshot: ProductSnapshot, event: CanonicalEvent): TransitionResult {
  return reduce(snapshot, event, kernelContext());
}

async function setup(): Promise<{
  kit: PersistenceTestKit;
  store: ProductStore;
  memory: NonNullable<PersistenceTestKit["memoryStore"]>;
}> {
  const kit = PersistenceTestKit.inMemory();
  const memory = kit.memoryStore;
  if (!memory) {
    throw new Error("expected in-memory harness");
  }
  await users(kit);
  return { kit, store: kit.store, memory };
}

async function users(kit: PersistenceTestKit): Promise<void> {
  kit.establishIdentity(USER_ID, "tg-user-1");
  kit.establishIdentity(OTHER_USER, "tg-user-2");
  kit.establishIdentity(CONTACT_A, "tg-contact-a");
}

function durationWorld(): ProductSnapshot {
  return withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), {
    bans: { [BAN_ID]: makeBan() },
    domainTimers: { "timer-1": makeTimer({ startedAt: asInstant(0) }) },
  });
}

function checkWorld(firstAnswerSet: boolean): ProductSnapshot {
  const pair: CheckPair = {
    id: PAIR_ID,
    banId: BAN_ID,
    receiverItemId: CHECK_ITEM_ID,
    senderItemId: CHECK_SENDER_ITEM_ID,
    receiverAnswer: null,
    senderAnswer: firstAnswerSet ? "FULFILLED" : null,
    resultingStatus: null,
  };
  const receiver = checkItem("RECEIVER", {
    ownerId: USER_ID,
    lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
  });
  const sender = checkItem("SENDER", { ownerId: OTHER_USER });
  let snapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.CHECK.RECEIVER");
  snapshot = withEntities(snapshot, {
    bans: {
      [BAN_ID]: makeBan({ senderId: OTHER_USER, receiverId: USER_ID, acceptance: "ACCEPTED" }),
    },
    checkPairs: { [PAIR_ID]: pair },
    notificationItems: { [receiver.id]: receiver, [sender.id]: sender },
  });
  snapshot = {
    ...snapshot,
    extended: { ...snapshot.extended, activeNotificationItemId: receiver.id },
  };
  return withOperation(
    snapshot,
    pendingOp({
      kind: "CHECK_ANSWER",
      originatingState: "NOTIFICATIONS.CHECK.RECEIVER",
      originatingItemId: receiver.id,
    }),
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

function overboardWorld(): ProductSnapshot {
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
  return withOperation(
    snapshot,
    pendingOp({ kind: "OVERBOARD", originatingState: "NOTIFICATIONS.INCOMING_BAN" }),
  );
}

describe("Stage 4 product persistence", () => {
  it("A. reconstructs an equivalent ProductSnapshot from the same durable facts", async () => {
    const { kit, store } = await setup();
    const world = durationWorld();
    const seeded = await kit.installFixtureSnapshot(USER_ID, world);
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(loaded.revision).toBe(seeded.revision);
    expect(loaded.snapshot.controlState).toBe("RIM.LOBBY");
    expect(loaded.snapshot.extended.entities.bans[BAN_ID]).toEqual(
      world.extended.entities.bans[BAN_ID],
    );
    expect(loaded.snapshot.extended.entities.domainTimers["timer-1"]).toEqual(
      world.extended.entities.domainTimers["timer-1"],
    );
    expect(loaded.snapshot.runtime.transitionInFlight).toBeNull();
  });

  it("B. CONTACT Ban sender/receiver must reference registered UserIds", async () => {
    const kit = PersistenceTestKit.inMemory();
    kit.establishIdentity(USER_ID, "tg-user-1");
    await expect(
      kit.installFixtureSnapshot(
        USER_ID,
        withEntities(withControlState(emptySnapshot(), "CREATE_BAN.SUCCESS"), {
          bans: { [BAN_ID]: makeBan({ receiverId: CONTACT_A }) },
        }),
      ),
    ).rejects.toMatchObject({ code: "IDENTITY_REQUIRED" });
    kit.establishIdentity(CONTACT_A, "tg-contact-a");
    const saved = await kit.installFixtureSnapshot(
      USER_ID,
      withEntities(withControlState(emptySnapshot(), "CREATE_BAN.SUCCESS"), {
        bans: { [BAN_ID]: makeBan({ receiverId: CONTACT_A }) },
      }),
    );
    expect(saved.snapshot.extended.entities.bans[BAN_ID]?.senderId).toBe(USER_ID);
    expect(saved.snapshot.extended.entities.bans[BAN_ID]?.receiverId).toBe(CONTACT_A);
  });

  it("C. Template Ban can persist receiverId = null", async () => {
    const { kit, store } = await setup();
    const saved = await kit.installFixtureSnapshot(
      USER_ID,
      withEntities(withControlState(emptySnapshot(), "CREATE_BAN.SUCCESS"), {
        bans: { [BAN_ID]: makeBan({ receiverId: null }) },
      }),
    );
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.extended.entities.bans[BAN_ID]?.receiverId).toBeNull();
    expect(saved.snapshot.extended.entities.bans[BAN_ID]?.receiverId).toBeNull();
  });

  it("D. Notification owner must be a registered UserId", async () => {
    const kit = PersistenceTestKit.inMemory();
    kit.establishIdentity(USER_ID, "tg-user-1");
    await expect(
      kit.installFixtureSnapshot(
        USER_ID,
        withEntities(withControlState(emptySnapshot(), "NOTIFICATIONS.INCOMING_BAN"), {
          bans: { [BAN_ID]: makeBan({ senderId: USER_ID, receiverId: USER_ID }) },
          notificationItems: {
            [INCOMING_ITEM_ID]: incomingItem({ ownerId: CONTACT_A }),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "IDENTITY_REQUIRED" });
  });

  it("E. accepted Ban DomainTimer persists and restores", async () => {
    const { kit, store } = await setup();
    const seeded = await kit.installFixtureSnapshot(USER_ID, durationWorld());
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.extended.entities.bans[BAN_ID]?.acceptance).toBe("ACCEPTED");
    expect(loaded.snapshot.extended.entities.domainTimers["timer-1"]?.banId).toBe(BAN_ID);
    expect(loaded.snapshot.extended.entities.domainTimers["timer-1"]?.state).toBe("RUNNING");
    expect(seeded.snapshot.extended.entities.domainTimers["timer-1"]?.durationMinutes).toBe(3);
  });

  it("F. OVERBOARD Ban has no DomainTimer through a valid persisted transition", async () => {
    const { kit, store, memory } = await setup();
    const seeded = await kit.installFixtureSnapshot(USER_ID, overboardWorld());
    const result = applied(seeded.snapshot, defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"));
    expect(result.outcome).toBe("APPLIED");
    const saved = await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result,
    });
    expect(saved.snapshot.extended.entities.bans[BAN_ID]?.acceptance).toBe("PENDING");
    expect(saved.snapshot.extended.entities.bans[BAN_ID]?.status).toBe("OVERBOARD");
    expect(Object.values(saved.snapshot.extended.entities.domainTimers)).toEqual([]);
    expect(memory.inspect().countTimers()).toBe(0);
  });

  it("G. only one authoritative DomainTimer per Ban", async () => {
    const { kit, memory } = await setup();
    await kit.installFixtureSnapshot(USER_ID, durationWorld());
    expect(() =>
      memory.inspect().upsertTimer(makeTimer({ id: branded("timer-2"), banId: BAN_ID })),
    ).toThrowError(PersistenceError);
    expect(memory.inspect().countTimers()).toBe(1);
  });

  it("H. only one CheckPair per Ban", async () => {
    const { kit, memory } = await setup();
    await kit.installFixtureSnapshot(USER_ID, checkWorld(false));
    expect(() =>
      memory.inspect().upsertPair({
        id: branded("pair-2"),
        banId: BAN_ID,
        receiverItemId: CHECK_ITEM_ID,
        senderItemId: CHECK_SENDER_ITEM_ID,
        receiverAnswer: null,
        senderAnswer: null,
        resultingStatus: null,
      }),
    ).toThrowError(PersistenceError);
    expect(memory.inspect().countPairs()).toBe(1);
  });

  it("I. E-22 incomplete CheckPair survives reload", async () => {
    const { kit, store } = await setup();
    const seeded = await kit.installFixtureSnapshot(USER_ID, checkWorld(false));
    const result = applied(
      seeded.snapshot,
      eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
        checkItemId: CHECK_ITEM_ID,
        answer: "FULFILLED",
        checkPairId: PAIR_ID,
      }),
    );
    expect(result.outcome).toBe("APPLIED");
    await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result,
    });
    const loaded = await store.loadProductSnapshot(USER_ID);
    const pair = loaded.snapshot.extended.entities.checkPairs[PAIR_ID];
    expect(pair?.receiverAnswer).toBe("FULFILLED");
    expect(pair?.senderAnswer).toBeNull();
    expect(pair?.resultingStatus).toBeNull();
    expect(loaded.snapshot.extended.entities.bans[BAN_ID]?.status).toBeNull();
  });

  it("J/K. E-23 commits atomically and replay does not duplicate Status/Items", async () => {
    const { kit, store, memory } = await setup();
    const seeded = await kit.installFixtureSnapshot(USER_ID, checkWorld(true));
    const event = eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND", {
      checkItemId: CHECK_ITEM_ID,
      answer: "FULFILLED",
      checkPairId: PAIR_ID,
      resultingStatus: "BANTASTIC" as CheckDerivedStatus,
    });
    const result = applied(seeded.snapshot, event);
    expect(result.outcome).toBe("APPLIED");
    const saved = await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result,
    });
    const receiverLoaded = await store.loadProductSnapshot(USER_ID);
    const senderLoaded = await store.loadProductSnapshot(OTHER_USER);
    const statuses = [
      ...Object.values(receiverLoaded.snapshot.extended.entities.notificationItems),
      ...Object.values(senderLoaded.snapshot.extended.entities.notificationItems),
    ].filter((item) => item.kind === "STATUS");
    expect(receiverLoaded.snapshot.extended.entities.checkPairs[PAIR_ID]?.resultingStatus).toBe(
      "BANTASTIC",
    );
    expect(receiverLoaded.snapshot.extended.entities.bans[BAN_ID]?.status).toBe("BANTASTIC");
    expect(statuses).toHaveLength(2);
    expect(saved.snapshot.runtime.pendingOperations[OP_ID]?.resultApplied).toBe(true);
    const replay = applied(result.snapshot, event);
    await expect(
      store.persistTransition({
        currentUserId: USER_ID,
        expectedRevision: saved.revision,
        result: replay,
      }),
    ).rejects.toMatchObject({ code: "APPLIED_TRANSITION_REQUIRED" });
    expect(memory.inspect().countPairs()).toBe(1);
    expect(
      [...memory.inspect().snapshot().items.values()].filter((item) => item.kind === "STATUS"),
    ).toHaveLength(2);
  });

  it("L. E-30 FROM_INCOMING persists ACCEPTED original + DomainTimer + Timer Item atomically", async () => {
    const { kit, store, memory } = await setup();
    const seeded = await kit.installFixtureSnapshot(USER_ID, replyWorld("INCOMING_BAN"));
    const result = applied(
      seeded.snapshot,
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId: OP_ID,
        replyBanId: REPLY_BAN_ID,
        source: { kind: "INCOMING_BAN", itemId: INCOMING_ITEM_ID, banId: BAN_ID },
      }),
    );
    expect(result.outcome).toBe("APPLIED");
    const saved = await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result,
    });
    expect(saved.snapshot.extended.entities.bans[BAN_ID]?.acceptance).toBe("ACCEPTED");
    expect(Object.values(saved.snapshot.extended.entities.domainTimers)).toHaveLength(1);
    expect(
      Object.values(saved.snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "TIMER",
      ),
    ).toHaveLength(1);
    expect(memory.inspect().countBans()).toBe(2);
    expect(memory.inspect().countTimers()).toBe(1);
  });

  it("M. E-30 FROM_STATUS persists without DomainTimer", async () => {
    const { kit, store, memory } = await setup();
    const seeded = await kit.installFixtureSnapshot(USER_ID, replyWorld("STATUS"));
    const result = applied(
      seeded.snapshot,
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId: OP_ID,
        replyBanId: REPLY_BAN_ID,
        source: { kind: "STATUS", itemId: STATUS_ITEM_ID, banId: BAN_ID },
      }),
    );
    expect(result.outcome).toBe("APPLIED");
    const saved = await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result,
    });
    expect(saved.snapshot.extended.entities.bans[REPLY_BAN_ID]).toBeDefined();
    expect(Object.values(saved.snapshot.extended.entities.domainTimers)).toEqual([]);
    expect(memory.inspect().countTimers()).toBe(0);
  });

  it("N. E-42 persists CheckPair/Items exactly once", async () => {
    const { kit, store, memory } = await setup();
    const seeded = await kit.installFixtureSnapshot(USER_ID, durationWorld());
    const event = defaultEvent("BAN.DURATION_EXPIRED");
    const first = applied(seeded.snapshot, event);
    expect(first.outcome).toBe("APPLIED");
    const saved = await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result: first,
    });
    const second = applied(saved.snapshot, event);
    expect(second.outcome).not.toBe("APPLIED");
    expect(memory.inspect().countPairs()).toBe(1);
    expect(
      [...memory.inspect().snapshot().items.values()].filter((item) => item.kind === "CHECK"),
    ).toHaveLength(2);
  });

  it("O. E-32 processing Timer Item does not delete/complete DomainTimer", async () => {
    const { kit, store } = await setup();
    const timer = makeTimer();
    let world = withControlState(emptySnapshot(), "NOTIFICATIONS.TIMER");
    world = withEntities(world, {
      domainTimers: { "timer-1": timer },
      bans: { [BAN_ID]: makeBan() },
    });
    world = withItems(world, [
      timerItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } }),
    ]);
    world = {
      ...world,
      extended: {
        ...world.extended,
        activeNotificationItemId: TIMER_ITEM_ID,
        priorities: { statusItemId: null, timerItemId: TIMER_ITEM_ID },
      },
    };
    const seeded = await kit.installFixtureSnapshot(USER_ID, world);
    const result = applied(seeded.snapshot, defaultEvent("APP.FULL_CLOSE"));
    const saved = await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result,
    });
    expect(
      saved.snapshot.extended.entities.notificationItems[TIMER_ITEM_ID]?.lifecycle.status,
    ).toBe("PROCESSED");
    expect(saved.snapshot.extended.entities.domainTimers["timer-1"]).toEqual(timer);
    expect(saved.snapshot.runtime.session).toBe("CLOSED");
  });

  it("P. confirmed Create Ban does not duplicate on replay", async () => {
    const { kit, store, memory } = await setup();
    let world = withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.CONTACT");
    world = {
      ...world,
      extended: { ...world.extended, createBanDraft: validCreateDraft("CONTACT") },
    };
    world = withOperation(world, pendingOp());
    const seeded = await kit.installFixtureSnapshot(USER_ID, world);
    const result = applied(
      seeded.snapshot,
      eventOf("CREATE_BAN.SEND_CONFIRMED", { operationId: OP_ID, createdBanId: BAN_ID }),
    );
    expect(result.outcome).toBe("APPLIED");
    const saved = await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result,
    });
    expect(memory.inspect().countBans()).toBe(1);
    const replay = applied(
      saved.snapshot,
      eventOf("CREATE_BAN.SEND_CONFIRMED", { operationId: OP_ID, createdBanId: BAN_ID }),
    );
    expect(replay.outcome).not.toBe("APPLIED");
    expect(memory.inspect().countBans()).toBe(1);
  });

  it("Q. PendingOperation.resultApplied survives reload", async () => {
    const { kit, store } = await setup();
    const seeded = await kit.installFixtureSnapshot(USER_ID, checkWorld(true));
    const result = applied(
      seeded.snapshot,
      eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND", {
        checkItemId: CHECK_ITEM_ID,
        answer: "FULFILLED",
        checkPairId: PAIR_ID,
        resultingStatus: "BANTASTIC" as CheckDerivedStatus,
      }),
    );
    expect(result.outcome).toBe("APPLIED");
    expect(result.snapshot.runtime.pendingOperations[OP_ID]?.resultApplied).toBe(true);
    await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result,
    });
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.runtime.pendingOperations[OP_ID]?.resultApplied).toBe(true);
  });

  it("R. Share ACTIVE → CONFIRMED survives reload", async () => {
    const { kit, store } = await setup();
    let world = withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    world = {
      ...world,
      extended: { ...world.extended, createBanDraft: validCreateDraft("TEMPLATE") },
    };
    world = withEntities(world, {
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
    const seeded = await kit.installFixtureSnapshot(USER_ID, world);
    const result = applied(
      seeded.snapshot,
      eventOf("CREATE_BAN.SHARE_CONFIRMED", {
        shareAttemptId: SHARE_ATTEMPT_ID,
        result: {} as never,
      }),
    );
    expect(result.outcome).toBe("APPLIED");
    await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result,
    });
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(loaded.snapshot.extended.entities.shareOperations[SHARE_ATTEMPT_ID]?.status).toBe(
      "CONFIRMED",
    );
    expect(Object.values(loaded.snapshot.extended.entities.bans)[0]?.receiverId).toBeNull();
  });

  it("S. Share CANCELLED cannot later produce a second persisted Ban", async () => {
    const { kit, store, memory } = await setup();
    let world = withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    world = {
      ...world,
      extended: { ...world.extended, createBanDraft: validCreateDraft("TEMPLATE") },
    };
    world = withEntities(world, { shareOperations: { [SHARE_ATTEMPT_ID]: shareOp() } });
    const seeded = await kit.installFixtureSnapshot(USER_ID, world);
    const cancelled = applied(
      seeded.snapshot,
      eventOf("CREATE_BAN.SHARE_CANCELLED", { shareAttemptId: SHARE_ATTEMPT_ID }),
    );
    const saved = await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result: cancelled,
    });
    expect(saved.snapshot.extended.entities.shareOperations[SHARE_ATTEMPT_ID]?.status).toBe(
      "CANCELLED",
    );
    const late = applied(
      saved.snapshot,
      eventOf("CREATE_BAN.SHARE_CONFIRMED", {
        shareAttemptId: SHARE_ATTEMPT_ID,
        result: {} as never,
      }),
    );
    expect(late.outcome).not.toBe("APPLIED");
    expect(Object.keys(saved.snapshot.extended.entities.bans)).toEqual([]);
    expect(memory.inspect().countBans()).toBe(0);
  });

  it("T. last 10 relationship Bans are retrieved deterministically in chronological order", async () => {
    const { kit, store } = await setup();
    const bans: Record<string, Ban> = {};
    for (let index = 1; index <= 12; index += 1) {
      const id = branded<Ban["id"]>(`ban-${index}`);
      bans[id] = makeBan({
        id,
        banText: `ban ${index}`,
        senderId: index % 2 === 0 ? OTHER_USER : USER_ID,
        receiverId: index % 2 === 0 ? USER_ID : OTHER_USER,
      });
    }
    await kit.installFixtureSnapshot(
      USER_ID,
      withEntities(withControlState(emptySnapshot(), "RIM.LOBBY"), { bans }),
    );
    const history = await store.listRelationshipBans(USER_ID, OTHER_USER);
    expect(history).toHaveLength(10);
    expect(history.map((row) => row.relationshipBan.banText)).toEqual(
      Array.from({ length: 10 }, (_, index) => `ban ${index + 3}`),
    );
    expect(history.map((row) => row.createdSeq)).toEqual(
      history.map((row) => row.createdSeq).sort((a, b) => a - b),
    );
  });

  it("U. persistence failure cannot leave a multi-entity transition half committed", async () => {
    const { kit, store, memory } = await setup();
    const seeded = await kit.installFixtureSnapshot(USER_ID, durationWorld());
    const result = applied(seeded.snapshot, defaultEvent("BAN.DURATION_EXPIRED"));
    expect(result.outcome).toBe("APPLIED");
    memory.failNextWriteAfterBans();
    await expect(
      store.persistTransition({
        currentUserId: USER_ID,
        expectedRevision: seeded.revision,
        result,
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(Object.keys(loaded.snapshot.extended.entities.checkPairs)).toEqual([]);
    expect(memory.inspect().countPairs()).toBe(0);
    expect(loaded.snapshot.extended.entities.domainTimers["timer-1"]?.state).toBe("RUNNING");
    expect(loaded.revision).toBe(seeded.revision);
  });

  it("V. load/save does not invent missing product facts", async () => {
    const { store } = await setup();
    const loaded = await store.loadProductSnapshot(USER_ID);
    expect(loaded.revision).toBe(0);
    expect(loaded.snapshot.controlState).toBeNull();
    expect(loaded.snapshot.extended.entities.bans).toEqual({});
    expect(loaded.snapshot.extended.rimChat).toBeNull();
    expect(loaded.snapshot.extended.entities.domainTimers).toEqual({});
    await expect(
      store.persistTransition({
        currentUserId: USER_ID,
        expectedRevision: 0,
        result: {
          outcome: "UNDEFINED",
          result: "UNDEFINED",
          controlState: null,
          snapshot: emptySnapshot(),
          effects: [],
          declaredEffects: [],
          traces: [],
          composition: "UNDEFINED",
          error: null,
        },
      }),
    ).rejects.toMatchObject({ code: "APPLIED_TRANSITION_REQUIRED" });
  });

  it("W. Product Kernel reduce remains pure and does not import database infrastructure", async () => {
    const before = durationWorld();
    const copy = structuredClone(before);
    const result = applied(before, defaultEvent("BAN.DURATION_EXPIRED"));
    expect(result.outcome).toBe("APPLIED");
    expect(before).toEqual(copy);
    expect(typeof reduce).toBe("function");
    expect(reduce.length).toBe(3);
  });

  it("rejects concurrent contradictory commits with the same revision", async () => {
    const { kit, store } = await setup();
    const seeded = await kit.installFixtureSnapshot(USER_ID, durationWorld());
    const first = applied(seeded.snapshot, defaultEvent("BAN.DURATION_EXPIRED"));
    await store.persistTransition({
      currentUserId: USER_ID,
      expectedRevision: seeded.revision,
      result: first,
    });
    await expect(
      store.persistTransition({
        currentUserId: USER_ID,
        expectedRevision: seeded.revision,
        result: first,
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });
});
