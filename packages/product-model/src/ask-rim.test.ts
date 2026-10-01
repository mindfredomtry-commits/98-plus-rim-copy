import { describe, expect, it } from "vitest";
import type { AskRimOrigin } from "./entities.ts";
import type { CanonicalEvent } from "./events.ts";
import type { ProductSnapshot } from "./extended-state.ts";
import {
  AI_REQUEST_ID,
  BAN_ID,
  CONTACT_A,
  CONTACT_B,
  CONTEXT_DATA,
  PROPOSAL_ID,
  STATUS_ITEM_ID,
  USER_ID,
  branded,
  defaultEvent,
  eventOf,
  failedAi,
  fixtureForRow,
  kernelContext,
  makeBan,
  makeChat,
  proposalsMessage,
  readyContext,
  statusItem,
  withChat,
  withControlState,
  withEntities,
} from "./kernel.fixtures.ts";
import { MATRIX_CONTRACT_ROWS } from "./matrix.ts";
import { reduce } from "./kernel/reduce.ts";
import { emptySnapshot, statusControlState } from "./kernel/snapshot.ts";
import type { AiRequestId } from "./ids.ts";
import type { BanStatus, Role } from "./primitives.ts";

const STATUSES = [
  "OVERBOARD",
  "BANTASTIC",
  "BANFLICT",
  "FAIR_ENOUGH",
] as const satisfies readonly BanStatus[];
const ROLES = ["RECEIVER", "SENDER"] as const satisfies readonly Role[];

function statusWorld(status: BanStatus, role: Role): ProductSnapshot {
  const item = statusItem({
    role,
    status,
    ownerId: USER_ID,
    lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
  });
  const ban = makeBan({
    senderId: role === "SENDER" ? USER_ID : CONTACT_A,
    receiverId: role === "RECEIVER" ? USER_ID : CONTACT_A,
    status,
    acceptance: status === "OVERBOARD" ? "PENDING" : "ACCEPTED",
  });
  let snapshot = withControlState(emptySnapshot(), statusControlState(status, role));
  snapshot = withEntities(snapshot, {
    bans: { [BAN_ID]: ban },
    notificationItems: { [item.id]: item },
  });
  return {
    ...snapshot,
    extended: { ...snapshot.extended, activeNotificationItemId: item.id },
  };
}

function withProcessedItem(snapshot: ProductSnapshot, itemId: string): ProductSnapshot {
  const item = snapshot.extended.entities.notificationItems[itemId];
  if (!item) {
    throw new Error("missing notification item");
  }
  return {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      entities: {
        ...snapshot.extended.entities,
        notificationItems: {
          ...snapshot.extended.entities.notificationItems,
          [itemId]: { ...item, lifecycle: { status: "PROCESSED" } },
        },
      },
    },
  };
}

function originFor(status: BanStatus, role: Role): AskRimOrigin {
  return {
    sourceStatusItemId: STATUS_ITEM_ID,
    banId: BAN_ID,
    status,
    sourceRole: role,
  };
}

function contextReady(snapshot: ProductSnapshot): CanonicalEvent {
  const chat = snapshot.extended.rimChat;
  return eventOf("RIM.CONTEXT_READY", {
    rimChatId: chat!.id,
    selectedContactId: chat!.selectedContactId!,
    relationshipContext: CONTEXT_DATA,
    requestId: chat!.relationshipContext!.requestId,
  });
}

describe("MVP14 Ask RIM E-63", () => {
  it.each(STATUSES.flatMap((status) => ROLES.map((role) => [status, role] as const)))(
    "opens one Ask RIM chat from %s %s and returns to that unprocessed Status Item",
    (status, role) => {
      const context = kernelContext();
      const before = statusWorld(status, role);
      const sourceId = before.extended.activeNotificationItemId;
      const opened = reduce(before, defaultEvent("NOTIFICATIONS.PRESS_ASK_RIM"), context);
      const chat = opened.snapshot.extended.rimChat;
      expect(opened.outcome).toBe("APPLIED");
      expect(opened.traces[0]?.eventId).toBe("E-63");
      expect(opened.controlState).toBe("RIM.CHAT");
      expect(chat?.selectedContactId).toBe(CONTACT_A);
      expect(chat?.askRimOrigin).toEqual(originFor(status, role));
      expect(chat?.messages).toEqual([]);
      expect(chat?.inputDraft).toBe("");
      expect(chat?.aiOperation).toEqual({ status: "IDLE" });
      expect(chat?.relationshipContext?.status).toBe("loading");
      expect(opened.effects.some((effect) => effect.type === "REQUEST_RIM_AI")).toBe(false);
      expect(opened.effects.some((effect) => effect.type === "REQUEST_RELATIONSHIP_CONTEXT")).toBe(
        true,
      );
      expect(opened.snapshot.extended.entities.notificationItems[sourceId!]?.lifecycle.status).toBe(
        "UNPROCESSED",
      );

      const ready = reduce(opened.snapshot, contextReady(opened.snapshot), context);
      expect(ready.traces[0]?.branch).toBe("current-contact");
      expect(ready.snapshot.extended.rimChat?.messages).toEqual([
        { kind: "RIM", text: "что хочешь спросить?" },
      ]);
      expect(ready.effects.some((effect) => effect.type === "REQUEST_RIM_AI")).toBe(false);
      expect(ready.snapshot.extended.rimChat?.aiOperation).toEqual({ status: "IDLE" });

      const again = reduce(ready.snapshot, contextReady(ready.snapshot), context);
      expect(again.snapshot.extended.rimChat?.messages).toEqual(
        ready.snapshot.extended.rimChat?.messages,
      );

      const repeated = reduce(ready.snapshot, defaultEvent("NOTIFICATIONS.PRESS_ASK_RIM"), context);
      expect(repeated.outcome).toBe("UNDEFINED");
      expect(repeated.snapshot.extended.rimChat?.id).toBe(ready.snapshot.extended.rimChat?.id);
      expect(repeated.snapshot.extended.rimChat?.messages).toEqual(
        ready.snapshot.extended.rimChat?.messages,
      );

      const back = reduce(ready.snapshot, defaultEvent("RIM.PRESS_BACK"), context);
      expect(back.traces[0]?.branch).toBe("valid-ask-rim-origin");
      expect(back.controlState).toBe(statusControlState(status, role));
      expect(back.snapshot.extended.rimChat).toBeNull();
      expect(back.snapshot.extended.activeNotificationItemId).toBe(sourceId);
      expect(back.snapshot.extended.entities.notificationItems[sourceId!]?.lifecycle.status).toBe(
        "UNPROCESSED",
      );

      const reopened = reduce(back.snapshot, defaultEvent("NOTIFICATIONS.PRESS_ASK_RIM"), context);
      expect(reopened.controlState).toBe("RIM.CHAT");
      expect(reopened.snapshot.extended.rimChat?.id).not.toBe(chat?.id);
      expect(reopened.snapshot.extended.rimChat?.messages).toEqual([]);
      expect(reopened.snapshot.extended.rimChat?.askRimOrigin).toEqual(originFor(status, role));
    },
  );

  it("starts an ordinary transcript at context ready, without a pre-contact domain message", () => {
    const started = reduce(
      withControlState(emptySnapshot(), "RIM.LOBBY"),
      defaultEvent("RIM.PRESS_START_CHAT"),
      kernelContext(),
    );
    expect(started.snapshot.extended.rimChat).toBeNull();
    const selected = reduce(
      withControlState(started.snapshot, "RIM.SELECT_CONTACT"),
      eventOf("RIM.SELECT_CONTACT", { contactId: CONTACT_A }),
      kernelContext(),
    );
    expect(selected.snapshot.extended.rimChat?.messages).toEqual([]);
    expect(selected.snapshot.extended.rimChat?.askRimOrigin).toBeNull();
    const ready = reduce(selected.snapshot, contextReady(selected.snapshot), kernelContext());
    expect(ready.snapshot.extended.rimChat?.messages).toEqual([
      { kind: "RIM", text: "я могу предложить 3 запрета, написать?" },
    ]);
    const lobbyBack = reduce(ready.snapshot, defaultEvent("RIM.PRESS_BACK"), kernelContext());
    expect(lobbyBack.traces[0]?.branch).toBe("no-ask-rim-origin");
    expect(lobbyBack.controlState).toBe("RIM.LOBBY");
    expect(lobbyBack.snapshot.extended.rimChat).toBeNull();
  });

  it("preserves origin on Select Contact back and drops it when another contact is chosen", () => {
    const context = kernelContext();
    const opened = reduce(
      statusWorld("BANFLICT", "SENDER"),
      defaultEvent("NOTIFICATIONS.PRESS_ASK_RIM"),
      context,
    );
    const ready = reduce(opened.snapshot, contextReady(opened.snapshot), context);
    const origin = ready.snapshot.extended.rimChat?.askRimOrigin;
    const chatId = ready.snapshot.extended.rimChat?.id;
    const selecting = reduce(ready.snapshot, defaultEvent("RIM.PRESS_SELECT_CONTACT"), context);
    expect(selecting.controlState).toBe("RIM.SELECT_CONTACT");
    expect(selecting.snapshot.extended.rimChat?.askRimOrigin).toEqual(origin);
    const returned = reduce(selecting.snapshot, defaultEvent("RIM.PRESS_BACK"), context);
    expect(returned.traces[0]?.branch).toBe("no-new-selection");
    expect(returned.controlState).toBe("RIM.CHAT");
    expect(returned.snapshot.extended.rimChat?.id).toBe(chatId);
    expect(returned.snapshot.extended.rimChat?.askRimOrigin).toEqual(origin);

    const selectingAgain = reduce(
      returned.snapshot,
      defaultEvent("RIM.PRESS_SELECT_CONTACT"),
      context,
    );
    const changed = reduce(
      selectingAgain.snapshot,
      eventOf("RIM.SELECT_CONTACT", { contactId: CONTACT_B }),
      context,
    );
    expect(changed.snapshot.extended.rimChat?.id).not.toBe(chatId);
    expect(changed.snapshot.extended.rimChat?.askRimOrigin).toBeNull();
    expect(changed.snapshot.extended.rimChat?.selectedContactId).toBe(CONTACT_B);
    const changedReady = reduce(changed.snapshot, contextReady(changed.snapshot), context);
    expect(changedReady.snapshot.extended.rimChat?.messages).toEqual([
      { kind: "RIM", text: "я могу предложить 3 запрета, написать?" },
    ]);
  });

  it("passes the valid conversational origin on E-52 and not before the first user message", () => {
    const opened = reduce(
      statusWorld("FAIR_ENOUGH", "RECEIVER"),
      defaultEvent("NOTIFICATIONS.PRESS_ASK_RIM"),
      kernelContext(),
    );
    const ready = reduce(opened.snapshot, contextReady(opened.snapshot), kernelContext());
    const drafted = reduce(
      ready.snapshot,
      eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "почему так" }),
      kernelContext(),
    );
    const sent = reduce(drafted.snapshot, defaultEvent("RIM.PRESS_SEND"), kernelContext());
    const effect = sent.effects.find((item) => item.type === "REQUEST_RIM_AI");
    expect(
      sent.snapshot.extended.rimChat?.messages.filter((message) => message.kind === "USER"),
    ).toEqual([{ kind: "USER", text: "почему так" }]);
    expect(effect?.type).toBe("REQUEST_RIM_AI");
    if (effect?.type !== "REQUEST_RIM_AI") {
      throw new Error("E-52 did not create the existing AI request");
    }
    expect(effect.conversationalOrigin).toEqual(originFor("FAIR_ENOUGH", "RECEIVER"));
    expect(effect.snapshot).toEqual({
      requestId: effect.requestId,
      rimChatId: sent.snapshot.extended.rimChat?.id,
      userMessage: "почему так",
      contextRequestId: sent.snapshot.extended.rimChat?.relationshipContext?.requestId,
    });
  });

  it("freezes and restores Ask RIM origin, then a successful RIM Ban terminates that chat", () => {
    const opened = reduce(
      statusWorld("BANTASTIC", "RECEIVER"),
      defaultEvent("NOTIFICATIONS.PRESS_ASK_RIM"),
      kernelContext(),
    );
    const ready = reduce(opened.snapshot, contextReady(opened.snapshot), kernelContext());
    const withProposals = {
      ...ready.snapshot,
      extended: {
        ...ready.snapshot.extended,
        rimChat: {
          ...ready.snapshot.extended.rimChat!,
          messages: [...ready.snapshot.extended.rimChat!.messages, proposalsMessage()],
        },
      },
    };
    const frozen = reduce(
      withProposals,
      eventOf("RIM.PRESS_SUGGESTION_FORBID", {
        rimChatId: withProposals.extended.rimChat.id,
        proposalId: PROPOSAL_ID,
      }),
      kernelContext(),
    );
    expect(frozen.controlState).toBe("CREATE_BAN.WHAT.RIM");
    expect(frozen.snapshot.extended.savedFrozenRimChat?.askRimOrigin).toEqual(
      originFor("BANTASTIC", "RECEIVER"),
    );
    const restored = reduce(
      frozen.snapshot,
      defaultEvent("CREATE_BAN.PRESS_BACK"),
      kernelContext(),
    );
    expect(restored.controlState).toBe("RIM.CHAT");
    expect(restored.snapshot.extended.rimChat?.askRimOrigin).toEqual(
      originFor("BANTASTIC", "RECEIVER"),
    );
    expect(restored.snapshot.extended.savedFrozenRimChat).toBeNull();

    const row = MATRIX_CONTRACT_ROWS.find(
      (candidate) =>
        candidate.state === "CREATE_BAN.CONFIRM.RIM" &&
        candidate.eventId === "E-10" &&
        candidate.branch === "matching-unapplied",
    );
    if (!row) {
      throw new Error("missing RIM E-10 row");
    }
    const fixture = fixtureForRow(row);
    const frozenChat = makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      messages: [{ kind: "RIM", text: "что хочешь спросить?" }, proposalsMessage()],
      askRimOrigin: originFor("BANTASTIC", "RECEIVER"),
    });
    const confirming = {
      ...fixture.snapshot,
      extended: {
        ...fixture.snapshot.extended,
        rimChat: frozenChat,
        savedFrozenRimChat: frozenChat,
        entities: {
          ...fixture.snapshot.extended.entities,
          bans: {
            ...fixture.snapshot.extended.entities.bans,
            [BAN_ID]: makeBan({
              senderId: CONTACT_A,
              receiverId: USER_ID,
              status: "BANTASTIC",
              acceptance: "ACCEPTED",
            }),
          },
          notificationItems: {
            ...fixture.snapshot.extended.entities.notificationItems,
            [STATUS_ITEM_ID]: statusItem({
              role: "RECEIVER",
              status: "BANTASTIC",
              lifecycle: { status: "UNPROCESSED", display: "ACTIVE" },
            }),
          },
        },
      },
    };
    const success = reduce(confirming, fixture.event, kernelContext());
    expect(success.outcome).toBe("APPLIED");
    expect(success.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(success.snapshot.extended.rimChat).toBeNull();
    expect(success.snapshot.extended.savedFrozenRimChat).toBeNull();
  });

  it("ignores Ask RIM when the Status Item is already processed and ignores a stale context result", () => {
    const world = statusWorld("OVERBOARD", "SENDER");
    const itemId = world.extended.activeNotificationItemId!;
    const processed = withProcessedItem(world, itemId);
    const rejected = reduce(
      processed,
      defaultEvent("NOTIFICATIONS.PRESS_ASK_RIM"),
      kernelContext(),
    );
    expect(rejected.outcome).toBe("KERNEL_INVARIANT");
    expect(rejected.error?.code).toBe("NO_BRANCH_MATCHED");
    expect(rejected.snapshot.extended.rimChat).toBeNull();

    const opened = reduce(world, defaultEvent("NOTIFICATIONS.PRESS_ASK_RIM"), kernelContext());
    const stale = reduce(
      opened.snapshot,
      eventOf("RIM.CONTEXT_READY", {
        rimChatId: branded("rim-chat-stale"),
        selectedContactId: CONTACT_A,
        relationshipContext: CONTEXT_DATA,
        requestId: opened.snapshot.extended.rimChat!.relationshipContext!.requestId,
      }),
      kernelContext(),
    );
    expect(stale.result).toBe("IGNORE_NOT_ALLOWED");
    expect(stale.snapshot.extended.rimChat?.messages).toEqual([]);
    expect(stale.snapshot.extended.rimChat?.id).toBe(opened.snapshot.extended.rimChat?.id);
  });

  it("returns to the lobby when a stored origin no longer references an unprocessed Status Item", () => {
    const opened = reduce(
      statusWorld("BANTASTIC", "SENDER"),
      defaultEvent("NOTIFICATIONS.PRESS_ASK_RIM"),
      kernelContext(),
    );
    const itemId = opened.snapshot.extended.rimChat!.askRimOrigin!.sourceStatusItemId;
    const staleOrigin = withProcessedItem(opened.snapshot, itemId);
    const back = reduce(staleOrigin, defaultEvent("RIM.PRESS_BACK"), kernelContext());
    expect(back.traces[0]?.branch).toBe("no-ask-rim-origin");
    expect(back.controlState).toBe("RIM.LOBBY");
    expect(back.snapshot.extended.rimChat).toBeNull();
  });

  it("repeats the same conversational origin on E-54 and ignores a late AI result", () => {
    const opened = reduce(
      statusWorld("BANFLICT", "RECEIVER"),
      defaultEvent("NOTIFICATIONS.PRESS_ASK_RIM"),
      kernelContext(),
    );
    const ready = reduce(opened.snapshot, contextReady(opened.snapshot), kernelContext());
    const chat = ready.snapshot.extended.rimChat!;
    const drafted = reduce(
      ready.snapshot,
      eventOf("RIM.CHANGE_INPUT_DRAFT", { inputDraft: "почему" }),
      kernelContext(),
    );
    const sent = reduce(drafted.snapshot, defaultEvent("RIM.PRESS_SEND"), kernelContext());
    const pendingId =
      sent.snapshot.extended.rimChat?.aiOperation.status === "PENDING"
        ? sent.snapshot.extended.rimChat.aiOperation.requestId
        : null;
    const late = reduce(
      sent.snapshot,
      eventOf("RIM.AI_RESULT_RECEIVED", {
        rimChatId: sent.snapshot.extended.rimChat!.id,
        requestId: branded<AiRequestId>("ai-stale"),
        result: { kind: "MESSAGE", text: "поздно" },
      }),
      kernelContext(),
    );
    expect(late.traces[0]?.branch).toBe("stale-request");
    expect(late.result).toBe("IGNORE_NOT_ALLOWED");
    expect(late.snapshot.extended.rimChat?.messages).toEqual(
      sent.snapshot.extended.rimChat?.messages,
    );
    expect(late.snapshot.extended.rimChat?.askRimOrigin).toEqual(originFor("BANFLICT", "RECEIVER"));

    const failedSnapshot = {
      ...ready.snapshot,
      extended: {
        ...ready.snapshot.extended,
        rimChat: {
          ...chat,
          aiOperation: failedAi({ code: "RIM_AI_FAILED" } as never, {
            rimChatId: chat.id,
            userMessage: "почему",
            contextRequestId: chat.relationshipContext!.requestId,
          }),
        },
      },
    };
    const retried = reduce(
      failedSnapshot,
      eventOf("RIM.PRESS_RETRY_AI", { failedRequestId: AI_REQUEST_ID }),
      kernelContext(),
    );
    const effect = retried.effects.find((item) => item.type === "REQUEST_RIM_AI");
    expect(retried.outcome).toBe("APPLIED");
    expect(effect?.type).toBe("REQUEST_RIM_AI");
    if (effect?.type === "REQUEST_RIM_AI") {
      expect(effect.conversationalOrigin).toEqual(originFor("BANFLICT", "RECEIVER"));
      expect(effect.snapshot).toEqual({
        requestId: AI_REQUEST_ID,
        rimChatId: chat.id,
        userMessage: "почему",
        contextRequestId: chat.relationshipContext?.requestId,
      });
    }
    expect(pendingId).toBeTruthy();
  });

  it("does not let an ordinary E-52 carry a conversational origin", () => {
    const snapshot = withChat(
      withControlState(emptySnapshot(), "RIM.CHAT"),
      makeChat({
        selectedContactId: CONTACT_A,
        relationshipContext: readyContext(),
        inputDraft: "обычный",
        messages: [{ kind: "RIM", text: "я могу предложить 3 запрета, написать?" }],
      }),
    );
    const sent = reduce(snapshot, defaultEvent("RIM.PRESS_SEND"), kernelContext());
    const effect = sent.effects.find((item) => item.type === "REQUEST_RIM_AI");
    expect(effect?.type).toBe("REQUEST_RIM_AI");
    if (effect?.type === "REQUEST_RIM_AI") {
      expect(effect.conversationalOrigin).toBeNull();
    }
  });
});
