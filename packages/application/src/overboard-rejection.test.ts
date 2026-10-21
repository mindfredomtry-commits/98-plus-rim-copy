import { describe, expect, it } from "vitest";
import { asTelegramUserId, type AuthenticatedContext } from "@98plus/identity";
import { PersistenceTestKit } from "../../persistence/src/test-kit.ts";
import {
  beginDiagnosticCapture,
  endDiagnosticCapture,
  type DiagnosticRecord,
} from "@98plus/diagnostics";
import {
  counterAllocator,
  emptySnapshot,
  reduce,
  type CanonicalEvent,
  type OperationId,
  type ProductSnapshot,
} from "@98plus/product-model";
import {
  BAN_ID,
  defaultEvent,
  eventOf,
  incomingItem,
  INCOMING_ITEM_ID,
  kernelContext,
  makeBan,
  OTHER_USER,
  pendingOp,
  STATUS_ITEM_ID,
  statusItem,
  USER_ID,
  withControlState,
  withEntities,
  withItems,
  withOperation,
} from "../../product-model/src/kernel.fixtures.ts";
import { executeProductEvent, type ProductExecutorDependencies } from "./execute.ts";
import {
  createContactBan,
  eventOf as flowEvent,
  openLobby,
  productApp,
  RECEIVER_ID,
  SENDER_ID,
} from "./test-harness.ts";

function auth(userId: typeof USER_ID): AuthenticatedContext {
  return {
    currentUserId: userId,
    currentTelegramUser: { telegramUserId: asTelegramUserId("tg-user") },
    authenticationMethod: "telegram",
  };
}

function incomingWorld(withPending: boolean): ProductSnapshot {
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
  if (!withPending) {
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

function statusItems(snapshot: ProductSnapshot) {
  return Object.values(snapshot.extended.entities.notificationItems).filter(
    (item) => item.kind === "STATUS",
  );
}

async function openActor(snapshot: ProductSnapshot) {
  const kit = PersistenceTestKit.inMemory();
  kit.establishIdentity(USER_ID, "tg-user");
  kit.establishIdentity(OTHER_USER, "tg-other");
  await kit.installFixtureSnapshot(USER_ID, snapshot);
  return { kit, exec: execOn(kit) };
}

function execOn(kit: PersistenceTestKit) {
  const deps: ProductExecutorDependencies = {
    store: kit.store,
    clock: { nowMs: () => 1_000_000 },
    allocateId: counterAllocator(),
  };
  async function exec(event: CanonicalEvent) {
    const before = await kit.store.loadProductSnapshot(USER_ID);
    const frozen = structuredClone(before.snapshot);
    beginDiagnosticCapture();
    let result: Awaited<ReturnType<typeof executeProductEvent>>;
    let records: readonly DiagnosticRecord[] = [];
    try {
      result = await executeProductEvent({ context: auth(USER_ID), event }, deps);
    } finally {
      records = endDiagnosticCapture();
    }
    const after = await kit.store.loadProductSnapshot(USER_ID);
    return { result, records, before, after, frozen };
  }
  return exec;
}

function rejectedRecord(records: readonly DiagnosticRecord[]) {
  return records.find((record) => record.eventName === "product.event.rejected");
}

function expectRejection(
  step: Awaited<ReturnType<Awaited<ReturnType<typeof openActor>>["exec"]>>,
  kernelOutcome: "KERNEL_INVARIANT" | "UNDEFINED",
) {
  expect(step.result.status).toBe("NOT_APPLIED");
  expect(step.result.outcome).toBe(kernelOutcome);
  expect(step.result.persisted).toBe(false);
  expect(step.result.effects).toEqual([]);
  expect(step.result.pendingExternalEffects).toEqual([]);
  expect(step.result.error).toBeNull();
  expect(step.result.effects.some((effect) => effect.type === "START_OPERATION")).toBe(false);
  expect(step.after.revision).toBe(step.before.revision);
  expect(step.result.revision).toBe(step.before.revision);
  expect(step.after.snapshot).toEqual(step.frozen);
  expect(step.result.snapshot.extended.entities.bans).toEqual(step.frozen.extended.entities.bans);
  expect(step.result.snapshot.runtime.pendingOperations).toEqual(
    step.frozen.runtime.pendingOperations,
  );
  expect(step.result.snapshot.extended.activeNotificationItemId).toBe(
    step.frozen.extended.activeNotificationItemId,
  );
  expect(statusItems(step.result.snapshot)).toEqual(statusItems(step.frozen));
  expect(step.records.some((record) => record.eventName === "product.event.applied")).toBe(false);
  expect(step.records.some((record) => record.eventName === "product.event.failed")).toBe(false);
  expect(
    step.records.some((record) => record.eventName === "persistence.transaction.committed"),
  ).toBe(false);
  expect(step.records.some((record) => record.meta.persistenceOutcome === "COMMITTED")).toBe(false);
  const received = step.records.find((record) => record.eventName === "product.event.received");
  const rejected = rejectedRecord(step.records);
  expect(rejected?.meta.classification).toBe("PRODUCT_GUARD_REJECTED");
  expect(rejected?.meta.kernelOutcome).toBe(kernelOutcome);
  expect(rejected?.meta.guardResult).toBe("REJECTED");
  expect(rejected?.meta.eventId).toBe("E-15");
  expect(received?.meta.actionId).toBeTruthy();
  expect(rejected?.meta.actionId).toBe(received?.meta.actionId);
  if (kernelOutcome === "KERNEL_INVARIANT") {
    expect(step.result.kernelError?.code).toBe("NO_BRANCH_MATCHED");
    return;
  }
  expect(step.result.kernelError).toBeNull();
}

describe("E-15 Application rejection contract", () => {
  it("applies a legitimate Incoming OVERBOARD once", async () => {
    const { exec } = await openActor(incomingWorld(false));
    const step = await exec(defaultEvent("NOTIFICATIONS.PRESS_OVERBOARD"));
    expect(step.result.status).toBe("APPLIED");
    expect(step.result.outcome).toBe("APPLIED");
    expect(step.result.persisted).toBe(true);
    expect(step.result.effects.map((effect) => effect.type)).toEqual(["START_OPERATION"]);
    expect(step.result.pendingExternalEffects).toEqual([]);
    expect(step.after.revision).toBeGreaterThan(step.before.revision);
    expect(Object.values(step.after.snapshot.runtime.pendingOperations)).toHaveLength(1);
    expect(Object.values(step.after.snapshot.runtime.pendingOperations)[0]?.kind).toBe("OVERBOARD");
    expect(step.after.snapshot.extended.entities.bans[BAN_ID]?.status).toBeNull();
    expect(statusItems(step.after.snapshot)).toEqual([]);
    expect(step.records.some((record) => record.eventName === "product.event.applied")).toBe(true);
    expect(step.records.some((record) => record.eventName === "product.event.rejected")).toBe(
      false,
    );
  });

  it("rejects processed Incoming without effects", async () => {
    const processed = withItems(incomingWorld(false), [
      incomingItem({ lifecycle: { status: "PROCESSED" } }),
    ]);
    const { exec } = await openActor(processed);
    expectRejection(await exec(defaultEvent("NOTIFICATIONS.PRESS_OVERBOARD")), "KERNEL_INVARIANT");
  });

  it("rejects a missing active Item without effects", async () => {
    const base = incomingWorld(false);
    const missing = {
      ...base,
      extended: { ...base.extended, activeNotificationItemId: null },
    };
    const { exec } = await openActor(missing);
    expectRejection(await exec(defaultEvent("NOTIFICATIONS.PRESS_OVERBOARD")), "KERNEL_INVARIANT");
  });

  it("rejects an active Status while E-15 is still the Incoming local", async () => {
    const replaced = withItems(incomingWorld(false), [
      statusItem({
        lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
        role: "RECEIVER",
        status: "OVERBOARD",
      }),
    ]);
    const activeStatus = {
      ...replaced,
      extended: { ...replaced.extended, activeNotificationItemId: STATUS_ITEM_ID },
    };
    expect(activeStatus.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    const { exec } = await openActor(activeStatus);
    expectRejection(await exec(defaultEvent("NOTIFICATIONS.PRESS_OVERBOARD")), "KERNEL_INVARIANT");
  });

  it("rejects a terminal Ban without effects", async () => {
    const terminal = withEntities(incomingWorld(false), {
      bans: {
        [BAN_ID]: makeBan({
          senderId: OTHER_USER,
          receiverId: USER_ID,
          acceptance: "PENDING",
          status: "OVERBOARD",
        }),
      },
    });
    const { exec } = await openActor(terminal);
    expectRejection(await exec(defaultEvent("NOTIFICATIONS.PRESS_OVERBOARD")), "KERNEL_INVARIANT");
  });

  it("rejects a pending OVERBOARD without starting another operation", async () => {
    const { exec } = await openActor(incomingWorld(true));
    const step = await exec(defaultEvent("NOTIFICATIONS.PRESS_OVERBOARD"));
    expectRejection(step, "KERNEL_INVARIANT");
    expect(Object.keys(step.after.snapshot.runtime.pendingOperations)).toHaveLength(1);
  });

  it("rejects the wrong Incoming owner and a foreign Ban receiver", async () => {
    const base = incomingWorld(false);
    const wrongOwner = withItems(base, [
      incomingItem({
        ownerId: OTHER_USER,
        lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
      }),
    ]);
    const { exec: ownerExec } = await openActor(wrongOwner);
    expectRejection(
      await ownerExec(defaultEvent("NOTIFICATIONS.PRESS_OVERBOARD")),
      "KERNEL_INVARIANT",
    );

    const foreign = withEntities(base, {
      bans: {
        [BAN_ID]: makeBan({
          senderId: USER_ID,
          receiverId: OTHER_USER,
          acceptance: "PENDING",
          status: null,
        }),
      },
    });
    const { exec: foreignExec } = await openActor(foreign);
    expectRejection(
      await foreignExec(defaultEvent("NOTIFICATIONS.PRESS_OVERBOARD")),
      "KERNEL_INVARIANT",
    );
  });

  it("rejects stale Incoming PCS while the active Item is already Status", async () => {
    const confirmed = reduce(
      incomingWorld(true),
      defaultEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED"),
      kernelContext(),
    );
    expect(confirmed.outcome).toBe("APPLIED");
    const stale = withControlState(confirmed.snapshot, "NOTIFICATIONS.INCOMING_BAN");
    expect(stale.extended.activeNotificationItemId).not.toBe(INCOMING_ITEM_ID);
    const opened = await openActor(stale);
    const before = await opened.kit.store.loadProductSnapshot(USER_ID);
    const receiverStatuses = statusItems(before.snapshot).filter((item) => item.role === "RECEIVER");
    expect(receiverStatuses).toHaveLength(1);
    const step = await opened.exec(defaultEvent("NOTIFICATIONS.PRESS_OVERBOARD"));
    expectRejection(step, "KERNEL_INVARIANT");
    expect(statusItems(step.after.snapshot).filter((item) => item.role === "RECEIVER")).toEqual(
      receiverStatuses,
    );
  });

  it("confirms E-15 then E-20 and leaves a repeated E-15 undefined for the Status PCS", async () => {
    const opened = await openActor(incomingWorld(false));
    const { exec } = opened;
    const press = await exec(defaultEvent("NOTIFICATIONS.PRESS_OVERBOARD"));
    expect(press.result.status).toBe("APPLIED");
    const operationId = Object.keys(press.after.snapshot.runtime.pendingOperations)[0] as
      | OperationId
      | undefined;
    expect(operationId).toBeTruthy();
    const confirmed = await exec(
      eventOf("NOTIFICATIONS.OVERBOARD_CONFIRMED", {
        sourceItemId: INCOMING_ITEM_ID,
        banId: BAN_ID,
        operationId: operationId!,
      }),
    );
    expect(confirmed.result.status).toBe("APPLIED");
    expect(confirmed.result.snapshot.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    const receiverStatuses = statusItems(confirmed.after.snapshot);
    expect(receiverStatuses).toHaveLength(1);
    expect(receiverStatuses[0]).toMatchObject({ role: "RECEIVER", status: "OVERBOARD" });
    expect(
      confirmed.after.snapshot.extended.entities.notificationItems[INCOMING_ITEM_ID]?.lifecycle
        .status,
    ).toBe("PROCESSED");
    const senderLoaded = await opened.kit.store.loadProductSnapshot(OTHER_USER);
    const senderStatuses = statusItems(senderLoaded.snapshot);
    expect(senderStatuses).toHaveLength(1);
    expect(senderStatuses[0]).toMatchObject({
      role: "SENDER",
      status: "OVERBOARD",
      ownerId: OTHER_USER,
    });
    const repeat = await exec(defaultEvent("NOTIFICATIONS.PRESS_OVERBOARD"));
    expectRejection(repeat, "UNDEFINED");
    expect(repeat.result.outcome).not.toBe("KERNEL_INVARIANT");
    expect(statusItems(repeat.after.snapshot)).toEqual(receiverStatuses);
    expect(repeat.after.revision).toBe(confirmed.after.revision);
    const senderAfterRepeat = await opened.kit.store.loadProductSnapshot(OTHER_USER);
    expect(statusItems(senderAfterRepeat.snapshot)).toEqual(senderStatuses);
  });

  it("keeps an unrelated NO_BRANCH_MATCHED visible as KERNEL_INVARIANT", async () => {
    const { exec } = await openActor(
      withControlState(emptySnapshot(), "CREATE_BAN.CONFIRM.CONTACT"),
    );
    const step = await exec(defaultEvent("CREATE_BAN.PRESS_FORBID"));
    expect(step.result.status).toBe("KERNEL_INVARIANT");
    expect(step.result.outcome).toBe("KERNEL_INVARIANT");
    expect(step.result.kernelError?.code).toBe("NO_BRANCH_MATCHED");
    expect(step.result.error?.code).toBe("KERNEL_INVARIANT");
    expect(step.result.persisted).toBe(false);
    expect(step.result.effects).toEqual([]);
    expect(step.after.revision).toBe(step.before.revision);
    expect(step.after.snapshot).toEqual(step.frozen);
    const failed = step.records.find((record) => record.eventName === "product.event.failed");
    expect(failed?.meta.classification).toBe("KERNEL_INVARIANT");
    expect(failed?.meta.kernelOutcome).toBe("KERNEL_INVARIANT");
    expect(step.records.some((record) => record.eventName === "product.event.rejected")).toBe(
      false,
    );
    expect(step.records.some((record) => record.eventName === "product.event.applied")).toBe(
      false,
    );
    expect(
      step.records.some((record) => record.eventName === "persistence.transaction.committed"),
    ).toBe(false);
  });
});

describe("two-user OVERBOARD status smoke", () => {
  it("materializes one Status pair, rejects a repeat, and does not reactivate processed Status", async () => {
    const { store, sender, receiver } = await productApp();
    const { createdBanId } = await createContactBan(sender);
    await openLobby(receiver);
    const opened = await receiver(flowEvent("RIM.PRESS_NOTIFICATIONS"));
    expect(opened.status).toBe("APPLIED");
    expect(opened.snapshot.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    const press = await receiver(flowEvent("NOTIFICATIONS.PRESS_OVERBOARD"));
    expect(press.status).toBe("APPLIED");
    const operationId = Object.keys(press.snapshot.runtime.pendingOperations)[0];
    const sourceItemId = press.snapshot.extended.activeNotificationItemId;
    expect(operationId).toBeTruthy();
    expect(sourceItemId).toBeTruthy();
    const confirmed = await receiver(
      flowEvent("NOTIFICATIONS.OVERBOARD_CONFIRMED", {
        sourceItemId,
        banId: createdBanId,
        operationId,
      }),
    );
    expect(confirmed.status).toBe("APPLIED");
    expect(confirmed.snapshot.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    const receiverStatuses = statusItems(confirmed.snapshot);
    expect(receiverStatuses).toHaveLength(1);
    expect(receiverStatuses[0]).toMatchObject({
      role: "RECEIVER",
      status: "OVERBOARD",
      ownerId: RECEIVER_ID,
      lifecycle: { status: "UNPROCESSED" },
    });
    expect(confirmed.snapshot.extended.activeNotificationItemId).toBe(receiverStatuses[0]?.id);
    expect(confirmed.snapshot.extended.priorities.statusItemId).toBe(receiverStatuses[0]?.id);

    const senderLoaded = await store.loadProductSnapshot(SENDER_ID);
    const senderStatuses = statusItems(senderLoaded.snapshot);
    expect(senderLoaded.snapshot.extended.entities.bans[createdBanId]?.status).toBe("OVERBOARD");
    expect(senderStatuses).toHaveLength(1);
    expect(senderStatuses[0]).toMatchObject({
      role: "SENDER",
      status: "OVERBOARD",
      ownerId: SENDER_ID,
    });
    expect(senderLoaded.snapshot.extended.activeNotificationItemId).not.toBe(
      receiverStatuses[0]?.id,
    );

    const repeat = await receiver(flowEvent("NOTIFICATIONS.PRESS_OVERBOARD"));
    expect(repeat.status).toBe("NOT_APPLIED");
    expect(repeat.outcome).toBe("UNDEFINED");
    expect(repeat.kernelError).toBeNull();
    expect(repeat.persisted).toBe(false);
    expect(repeat.effects).toEqual([]);
    const receiverAfterRepeat = await store.loadProductSnapshot(RECEIVER_ID);
    expect(statusItems(receiverAfterRepeat.snapshot)).toHaveLength(1);
    expect(receiverAfterRepeat.revision).toBe(confirmed.revision);
    const senderAfterRepeat = await store.loadProductSnapshot(SENDER_ID);
    expect(statusItems(senderAfterRepeat.snapshot)).toHaveLength(1);

    const left = await receiver(flowEvent("NOTIFICATIONS.PRESS_TO_BANS"));
    expect(left.status).toBe("APPLIED");
    expect(left.snapshot.controlState).toBe("RIM.LOBBY");
    expect(left.snapshot.extended.activeNotificationItemId).toBeNull();
    const processed = statusItems(left.snapshot).find((item) => item.role === "RECEIVER");
    expect(processed?.lifecycle.status).toBe("PROCESSED");
    const reopened = await receiver(flowEvent("RIM.PRESS_NOTIFICATIONS"));
    expect(reopened.snapshot.extended.activeNotificationItemId).not.toBe(processed?.id);
    const durable = await store.loadProductSnapshot(RECEIVER_ID);
    expect(
      statusItems(durable.snapshot).find((item) => item.role === "RECEIVER")?.lifecycle.status,
    ).toBe("PROCESSED");
    expect(durable.snapshot.extended.activeNotificationItemId).not.toBe(processed?.id);
  });
});
