import { describe, expect, it } from "vitest";
import {
  emptySnapshot,
  reduce,
  type CheckPair,
  type OperationId,
  type ProductSnapshot,
} from "@98plus/product-model";
import {
  BAN_ID,
  CHECK_ITEM_ID,
  CHECK_SENDER_ITEM_ID,
  OTHER_USER,
  USER_ID,
  branded,
  checkItem,
  eventOf,
  kernelContext,
  makeBan,
  pendingOp,
  withControlState,
  withEntities,
  withOperation,
} from "../../product-model/src/kernel.fixtures.ts";
import { counterAllocator } from "../../product-model/src/kernel/snapshot.ts";
import { MemorySqlClient } from "./memory-sql.ts";
import { PostgresProductStore } from "./postgres-store.ts";
import { SQL } from "./sql.ts";
import { PersistenceTestKit } from "./test-kit.ts";

const PAIR_ID = branded<CheckPair["id"]>("pair-1");
const RECEIVER_OP = branded<OperationId>("op-receiver");
const SENDER_OP = branded<OperationId>("op-sender");

function emptyPair(): CheckPair {
  return {
    id: PAIR_ID,
    banId: BAN_ID,
    receiverItemId: CHECK_ITEM_ID,
    senderItemId: CHECK_SENDER_ITEM_ID,
    receiverAnswer: null,
    senderAnswer: null,
    resultingStatus: null,
  };
}

function sharedBan() {
  return makeBan({ senderId: OTHER_USER, receiverId: USER_ID, acceptance: "ACCEPTED" });
}

function receiverWorld(): ProductSnapshot {
  const receiver = checkItem("RECEIVER", {
    ownerId: USER_ID,
    lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
  });
  const sender = checkItem("SENDER", { ownerId: OTHER_USER });
  let snapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.CHECK.RECEIVER");
  snapshot = withEntities(snapshot, {
    bans: { [BAN_ID]: sharedBan() },
    checkPairs: { [PAIR_ID]: emptyPair() },
    notificationItems: { [receiver.id]: receiver, [sender.id]: sender },
  });
  snapshot = {
    ...snapshot,
    extended: { ...snapshot.extended, activeNotificationItemId: receiver.id },
  };
  return withOperation(
    snapshot,
    pendingOp({
      operationId: RECEIVER_OP,
      kind: "CHECK_ANSWER",
      originatingState: "NOTIFICATIONS.CHECK.RECEIVER",
      originatingItemId: receiver.id,
    }),
  );
}

function senderWorld(): ProductSnapshot {
  const receiver = checkItem("RECEIVER", { ownerId: USER_ID });
  const sender = checkItem("SENDER", {
    ownerId: OTHER_USER,
    lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
  });
  let snapshot = withControlState(emptySnapshot(), "NOTIFICATIONS.CHECK.SENDER");
  snapshot = withEntities(snapshot, {
    bans: { [BAN_ID]: sharedBan() },
    checkPairs: { [PAIR_ID]: emptyPair() },
    notificationItems: { [receiver.id]: receiver, [sender.id]: sender },
  });
  snapshot = {
    ...snapshot,
    extended: { ...snapshot.extended, activeNotificationItemId: sender.id },
  };
  return withOperation(
    snapshot,
    pendingOp({
      operationId: SENDER_OP,
      kind: "CHECK_ANSWER",
      originatingState: "NOTIFICATIONS.CHECK.SENDER",
      originatingItemId: sender.id,
    }),
  );
}

async function seedSharedPair(client: MemorySqlClient) {
  const kit = PersistenceTestKit.postgres(client);
  kit.establishIdentity(USER_ID, "tg-1");
  kit.establishIdentity(OTHER_USER, "tg-2");
  await kit.installFixtureSnapshot(USER_ID, receiverWorld());
  await kit.installFixtureSnapshot(OTHER_USER, senderWorld());
  return kit;
}

function firstEvent(role: "RECEIVER" | "SENDER") {
  return eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
    checkItemId: role === "RECEIVER" ? CHECK_ITEM_ID : CHECK_SENDER_ITEM_ID,
    answer: "FULFILLED",
    checkPairId: PAIR_ID,
  });
}

describe("Postgres CheckPair row-level FIRST/SECOND concurrency", () => {
  it("declares SELECT ... FOR UPDATE on the CheckPair row", () => {
    expect(SQL.selectPairForUpdate).toContain("FOR UPDATE");
    expect(SQL.selectPairForUpdate).toContain("FROM check_pairs");
    expect(SQL.selectPairForUpdate).toContain("pair_id = $1");
  });

  it("old two-instance FIRST+FIRST persist cannot complete the pair or invent Status", async () => {
    const client = new MemorySqlClient();
    await seedSharedPair(client);
    const storeA = new PostgresProductStore(client);
    const storeB = new PostgresProductStore(client);
    const loadedA = await storeA.loadProductSnapshot(USER_ID);
    const loadedB = await storeB.loadProductSnapshot(OTHER_USER);
    const firstA = reduce(loadedA.snapshot, firstEvent("RECEIVER"), {
      ...kernelContext(),
      currentUserId: USER_ID,
      allocateId: counterAllocator(10),
    });
    const firstB = reduce(loadedB.snapshot, firstEvent("SENDER"), {
      ...kernelContext(),
      currentUserId: OTHER_USER,
      allocateId: counterAllocator(20),
    });
    expect(firstA.outcome).toBe("APPLIED");
    expect(firstB.outcome).toBe("APPLIED");
    const settled = await Promise.allSettled([
      storeA.persistTransition({
        currentUserId: USER_ID,
        expectedRevision: loadedA.revision,
        result: firstA,
      }),
      storeB.persistTransition({
        currentUserId: OTHER_USER,
        expectedRevision: loadedB.revision,
        result: firstB,
      }),
    ]);
    expect(settled.some((item) => item.status === "rejected")).toBe(true);
    const after = await storeA.loadProductSnapshot(USER_ID);
    const pair = after.snapshot.extended.entities.checkPairs[PAIR_ID];
    expect(pair?.resultingStatus).toBeNull();
    const answers = [pair?.receiverAnswer, pair?.senderAnswer].filter((value) => value !== null);
    expect(answers.length).toBeLessThan(2);
    expect(
      Object.values(after.snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "STATUS",
      ),
    ).toHaveLength(0);
  });

  it("two independent PostgresProductStore instances serialize FIRST then SECOND on one client", async () => {
    const client = new MemorySqlClient();
    await seedSharedPair(client);
    const storeA = new PostgresProductStore(client);
    const storeB = new PostgresProductStore(client);

    const names = await Promise.all([
      storeA.withCheckPairLock(PAIR_ID, async (ctx) => {
        const loaded = await ctx.loadProductSnapshot(USER_ID);
        const pair = ctx.pair ?? loaded.snapshot.extended.entities.checkPairs[PAIR_ID]!;
        const other = pair.senderAnswer;
        const event =
          other === null
            ? firstEvent("RECEIVER")
            : eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND", {
                checkItemId: CHECK_ITEM_ID,
                answer: "FULFILLED",
                checkPairId: PAIR_ID,
                resultingStatus: other === "FULFILLED" ? "BANTASTIC" : "BANFLICT",
              });
        const result = reduce(loaded.snapshot, event, {
          ...kernelContext(),
          currentUserId: USER_ID,
          allocateId: counterAllocator(30),
        });
        expect(result.outcome).toBe("APPLIED");
        await ctx.persistTransition({
          currentUserId: USER_ID,
          expectedRevision: loaded.revision,
          result,
        });
        return event.name;
      }),
      storeB.withCheckPairLock(PAIR_ID, async (ctx) => {
        const loaded = await ctx.loadProductSnapshot(OTHER_USER);
        const pair = ctx.pair ?? loaded.snapshot.extended.entities.checkPairs[PAIR_ID]!;
        const other = pair.receiverAnswer;
        const event =
          other === null
            ? firstEvent("SENDER")
            : eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND", {
                checkItemId: CHECK_SENDER_ITEM_ID,
                answer: "NOT_FULFILLED",
                checkPairId: PAIR_ID,
                resultingStatus: other === "NOT_FULFILLED" ? "FAIR_ENOUGH" : "BANFLICT",
              });
        const result = reduce(loaded.snapshot, event, {
          ...kernelContext(),
          currentUserId: OTHER_USER,
          allocateId: counterAllocator(40),
        });
        expect(result.outcome).toBe("APPLIED");
        await ctx.persistTransition({
          currentUserId: OTHER_USER,
          expectedRevision: loaded.revision,
          result,
        });
        return event.name;
      }),
    ]);

    expect(names).toEqual(
      expect.arrayContaining([
        "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST",
        "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND",
      ]),
    );
    expect(new Set(names).size).toBe(2);

    const receiver = await storeA.loadProductSnapshot(USER_ID);
    const sender = await storeB.loadProductSnapshot(OTHER_USER);
    const pair = receiver.snapshot.extended.entities.checkPairs[PAIR_ID];
    expect(pair?.receiverAnswer).toBe("FULFILLED");
    expect(pair?.senderAnswer).toBe("NOT_FULFILLED");
    expect(pair?.resultingStatus).toBe("BANFLICT");
    expect(sender.snapshot.extended.entities.checkPairs[PAIR_ID]).toEqual(pair);
    expect(receiver.snapshot.extended.entities.bans[BAN_ID]?.status).toBe("BANFLICT");
    const statuses = [
      ...Object.values(receiver.snapshot.extended.entities.notificationItems),
      ...Object.values(sender.snapshot.extended.entities.notificationItems),
    ].filter((item) => item.kind === "STATUS");
    expect(statuses).toHaveLength(2);
    const secondName = names.find((name) => name.endsWith("SECOND"));
    if (secondName === "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND") {
      const secondWasReceiver = names[0] === "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND";
      const priorityOwner = secondWasReceiver ? USER_ID : OTHER_USER;
      const prioritySnapshot = secondWasReceiver ? receiver.snapshot : sender.snapshot;
      const ownStatus = Object.values(prioritySnapshot.extended.entities.notificationItems).find(
        (item) => item.kind === "STATUS" && item.ownerId === priorityOwner,
      );
      expect(prioritySnapshot.extended.priorities.statusItemId).toBe(ownStatus?.id);
      expect(prioritySnapshot.extended.activeNotificationItemId).toBe(ownStatus?.id);
    }
  });

  it("duplicate FIRST persist after the pair is complete does not rewrite Status", async () => {
    const client = new MemorySqlClient();
    await seedSharedPair(client);
    const store = new PostgresProductStore(client);
    await store.withCheckPairLock(PAIR_ID, async (ctx) => {
      const loaded = await ctx.loadProductSnapshot(USER_ID);
      const result = reduce(loaded.snapshot, firstEvent("RECEIVER"), {
        ...kernelContext(),
        currentUserId: USER_ID,
        allocateId: counterAllocator(50),
      });
      await ctx.persistTransition({
        currentUserId: USER_ID,
        expectedRevision: loaded.revision,
        result,
      });
    });
    await store.withCheckPairLock(PAIR_ID, async (ctx) => {
      const loaded = await ctx.loadProductSnapshot(OTHER_USER);
      const result = reduce(
        loaded.snapshot,
        eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND", {
          checkItemId: CHECK_SENDER_ITEM_ID,
          answer: "FULFILLED",
          checkPairId: PAIR_ID,
          resultingStatus: "BANTASTIC",
        }),
        { ...kernelContext(), currentUserId: OTHER_USER, allocateId: counterAllocator(60) },
      );
      await ctx.persistTransition({
        currentUserId: OTHER_USER,
        expectedRevision: loaded.revision,
        result,
      });
    });
    const completed = await store.loadProductSnapshot(USER_ID);
    const statusCount = Object.values(
      completed.snapshot.extended.entities.notificationItems,
    ).filter((item) => item.kind === "STATUS").length;
    const replay = reduce(completed.snapshot, firstEvent("RECEIVER"), {
      ...kernelContext(),
      currentUserId: USER_ID,
      allocateId: counterAllocator(70),
    });
    if (replay.outcome === "APPLIED") {
      await expect(
        store.persistTransition({
          currentUserId: USER_ID,
          expectedRevision: completed.revision,
          result: replay,
        }),
      ).rejects.toMatchObject({ code: "CHECK_PAIR_CONFLICT" });
    }
    const after = await store.loadProductSnapshot(USER_ID);
    expect(after.snapshot.extended.entities.checkPairs[PAIR_ID]?.resultingStatus).toBe("BANTASTIC");
    expect(
      Object.values(after.snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "STATUS",
      ),
    ).toHaveLength(statusCount);
  });
});
