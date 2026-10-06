import { describe, expect, it } from "vitest";
import type { CheckPairId, NotificationItemId, OperationId } from "@98plus/product-model";
import {
  createContactBan,
  eventOf,
  openLobby,
  productApp,
  RECEIVER_ID,
  SENDER_ID,
} from "./test-harness.ts";

describe("Stage 5 representative product flows", () => {
  it("orchestrates Create Ban CONTACT through Kernel + persistence", async () => {
    const { store, sender } = await productApp();
    const { confirmed, createdBanId } = await createContactBan(sender);
    expect(confirmed.status).toBe("APPLIED");
    expect(confirmed.snapshot.controlState).toBe("CREATE_BAN.SUCCESS");
    const loaded = await store.loadProductSnapshot(SENDER_ID);
    expect(loaded.snapshot.extended.entities.bans[createdBanId]?.receiverId).toBe(RECEIVER_ID);
    expect(loaded.snapshot.extended.entities.bans[createdBanId]?.acceptance).toBe("PENDING");
  });

  it("orchestrates Create Ban TEMPLATE up to Telegram Share without completing the share", async () => {
    const { sender } = await productApp();
    await openLobby(sender);
    await sender(eventOf("CREATE_BAN.PRESS_START"));
    await sender(eventOf("CREATE_BAN.SELECT_TEMPLATE", { templateContext: {} }));
    await sender(eventOf("CREATE_BAN.CHANGE_BAN_TEXT", { banText: "no phones" }));
    await sender(eventOf("CREATE_BAN.CHANGE_DURATION", { durationMinutes: 3 }));
    await sender(eventOf("CREATE_BAN.PRESS_NEXT"));
    const share = await sender(eventOf("CREATE_BAN.PRESS_FORBID"));
    expect(share.status).toBe("APPLIED");
    expect(share.snapshot.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect(share.pendingExternalEffects.map((item) => item.effect.type)).toEqual([
      "OPEN_TELEGRAM_SHARE",
    ]);
    expect(share.pendingExternalEffects[0]?.completed).toBe(false);
    const bans = Object.values(share.snapshot.extended.entities.bans);
    expect(bans).toHaveLength(1);
    expect(bans[0]?.receiverId).toBeNull();
  });

  it("orchestrates OVERBOARD without creating a DomainTimer", async () => {
    const { store, sender, receiver } = await productApp();
    const { createdBanId } = await createContactBan(sender);
    await openLobby(receiver);
    const notifications = await receiver(eventOf("RIM.PRESS_NOTIFICATIONS"));
    expect(notifications.status).toBe("APPLIED");
    expect(notifications.snapshot.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    const press = await receiver(eventOf("NOTIFICATIONS.PRESS_OVERBOARD"));
    expect(press.status).toBe("APPLIED");
    const operationId = Object.keys(press.snapshot.runtime.pendingOperations)[0] as OperationId;
    const itemId = press.snapshot.extended.activeNotificationItemId as NotificationItemId;
    const confirmed = await receiver(
      eventOf("NOTIFICATIONS.OVERBOARD_CONFIRMED", {
        sourceItemId: itemId,
        banId: createdBanId,
        operationId,
      }),
    );
    expect(confirmed.status).toBe("APPLIED");
    expect(confirmed.snapshot.extended.entities.bans[createdBanId]?.status).toBe("OVERBOARD");
    expect(Object.values(confirmed.snapshot.extended.entities.domainTimers)).toEqual([]);
    expect(confirmed.snapshot.runtime.pendingOperations[operationId]?.resultApplied).toBe(true);
    const senderLoaded = await store.loadProductSnapshot(SENDER_ID);
    expect(senderLoaded.snapshot.extended.entities.bans[createdBanId]?.status).toBe("OVERBOARD");
    expect(Object.values(senderLoaded.snapshot.extended.entities.domainTimers)).toEqual([]);
    const receiverLoaded = await store.loadProductSnapshot(RECEIVER_ID);
    expect(receiverLoaded.snapshot.runtime.pendingOperations[operationId]?.resultApplied).toBe(
      true,
    );
  });

  it("orchestrates Reply Ban FROM_INCOMING and creates a DomainTimer only via Kernel", async () => {
    const { store, sender, receiver } = await productApp();
    const { createdBanId } = await createContactBan(sender);
    await openLobby(receiver);
    await receiver(eventOf("RIM.PRESS_NOTIFICATIONS"));
    const reply = await receiver(eventOf("NOTIFICATIONS.PRESS_REPLY_BAN"));
    expect(reply.status).toBe("APPLIED");
    expect(reply.snapshot.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    await receiver(eventOf("REPLY_BAN.CHANGE_BAN_TEXT", { banText: "reply text" }));
    await receiver(eventOf("REPLY_BAN.CHANGE_DURATION", { durationMinutes: 15 }));
    await receiver(eventOf("REPLY_BAN.PRESS_NEXT"));
    const pending = await receiver(eventOf("REPLY_BAN.PRESS_FORBID"));
    const operationId = Object.keys(pending.snapshot.runtime.pendingOperations)[0] as OperationId;
    const source = pending.snapshot.extended.replySource;
    expect(source?.kind).toBe("INCOMING_BAN");
    const sent = await receiver(
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId,
        replyBanId: "ban-reply-1",
        source,
      }),
    );
    expect(sent.status).toBe("APPLIED");
    expect(sent.snapshot.extended.entities.bans[createdBanId]?.acceptance).toBe("ACCEPTED");
    expect(Object.values(sent.snapshot.extended.entities.domainTimers)).toHaveLength(1);
    const loaded = await store.loadProductSnapshot(RECEIVER_ID);
    expect(Object.values(loaded.snapshot.extended.entities.domainTimers)).toHaveLength(1);
    const closed = await receiver(eventOf("APP.FULL_CLOSE"));
    expect(closed.status).toBe("APPLIED");
    const timerItems = Object.values(closed.snapshot.extended.entities.notificationItems).filter(
      (item) => item.kind === "TIMER",
    );
    expect(timerItems.every((item) => item.lifecycle.status === "PROCESSED")).toBe(true);
    expect(Object.values(closed.snapshot.extended.entities.domainTimers)).toHaveLength(1);
    expect(Object.values(closed.snapshot.extended.entities.domainTimers)[0]?.state).toBe("RUNNING");
  });

  it("orchestrates E-42 Check creation and E-22 first Check answer", async () => {
    const { sender, receiver, advance } = await productApp();
    const { createdBanId } = await createContactBan(sender);
    await openLobby(receiver);
    await receiver(eventOf("RIM.PRESS_NOTIFICATIONS"));
    await receiver(eventOf("NOTIFICATIONS.PRESS_REPLY_BAN"));
    await receiver(eventOf("REPLY_BAN.CHANGE_BAN_TEXT", { banText: "reply text" }));
    await receiver(eventOf("REPLY_BAN.CHANGE_DURATION", { durationMinutes: 15 }));
    await receiver(eventOf("REPLY_BAN.PRESS_NEXT"));
    const pending = await receiver(eventOf("REPLY_BAN.PRESS_FORBID"));
    const operationId = Object.keys(pending.snapshot.runtime.pendingOperations)[0] as OperationId;
    await receiver(
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId,
        replyBanId: "ban-reply-1",
        source: pending.snapshot.extended.replySource,
      }),
    );
    advance(4 * 60 * 1000);
    const expired = await receiver(eventOf("BAN.DURATION_EXPIRED", { banId: createdBanId }));
    expect(expired.status).toBe("APPLIED");
    expect(expired.traces.some((trace) => trace.eventId === "E-42")).toBe(true);
    const pairs = Object.values(expired.snapshot.extended.entities.checkPairs);
    expect(pairs).toHaveLength(1);
    const pair = pairs[0]!;
    const timerAfterExpiry = Object.values(expired.snapshot.extended.entities.domainTimers)[0];
    expect(timerAfterExpiry?.state).toBe("EXPIRED");
    expect(timerAfterExpiry?.checkPairCreated).toBe(true);
    const toTimer = await receiver(eventOf("NOTIFICATIONS.SELECT_NEXT"));
    expect(toTimer.status).toBe("APPLIED");
    expect(toTimer.snapshot.controlState).toBe("NOTIFICATIONS.TIMER");
    const afterTimer = await receiver(eventOf("NOTIFICATIONS.PRESS_TO_BANS"));
    expect(afterTimer.status).toBe("APPLIED");
    expect(afterTimer.snapshot.controlState).toBe("NOTIFICATIONS.CHECK.RECEIVER");
    expect(Object.values(afterTimer.snapshot.extended.entities.domainTimers)[0]?.state).toBe(
      "EXPIRED",
    );
    expect(
      Object.values(afterTimer.snapshot.extended.entities.notificationItems)
        .filter((item) => item.kind === "TIMER")
        .every((item) => item.lifecycle.status === "PROCESSED"),
    ).toBe(true);
    const checkPress = await receiver(eventOf("NOTIFICATIONS.CHECK_ANSWER.FULFILLED"));
    expect(checkPress.status).toBe("APPLIED");
    const checkItemId = checkPress.snapshot.extended.activeNotificationItemId as NotificationItemId;
    const first = await receiver(
      eventOf("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST", {
        checkItemId,
        answer: "FULFILLED",
        checkPairId: pair.id as CheckPairId,
      }),
    );
    expect(first.status).toBe("APPLIED");
    expect(first.snapshot.extended.entities.checkPairs[pair.id]?.receiverAnswer).toBe("FULFILLED");
    expect(first.snapshot.extended.entities.checkPairs[pair.id]?.resultingStatus).toBeNull();
  });

  it("routes RIM relationship-context effect without fabricating E-56", async () => {
    const { sender } = await productApp();
    await openLobby(sender);
    await sender(eventOf("RIM.PRESS_START_CHAT"));
    await sender(eventOf("RIM.PRESS_SELECT_CONTACT"));
    const selected = await sender(eventOf("RIM.SELECT_CONTACT", { contactId: RECEIVER_ID }));
    expect(selected.status).toBe("APPLIED");
    expect(selected.pendingExternalEffects[0]?.effect.type).toBe("REQUEST_RELATIONSHIP_CONTEXT");
    expect(selected.pendingExternalEffects[0]?.completed).toBe(false);
    expect(selected.effects.some((effect) => effect.type === "REQUEST_RIM_AI")).toBe(false);
  });
});
