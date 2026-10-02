import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "./events.ts";
import { CANONICAL_EVENT_DEFINITIONS } from "./events.ts";
import type { ProductSnapshot } from "./extended-state.ts";
import type { ContextRequestId, RimChatId, UserId } from "./ids.ts";
import {
  BAN_ID,
  CHAT_ID,
  CONTACT_A,
  CONTACT_B,
  CONTEXT_DATA,
  REQUEST_ID,
  USER_ID,
  branded,
  defaultEvent,
  eventOf,
  kernelContext,
  makeBan,
  makeChat,
  readyContext,
  statusItem,
  withChat,
  withControlState,
  withEntities,
} from "./kernel.fixtures.ts";
import { reduce } from "./kernel/reduce.ts";
import { asInstant, cloneSnapshot, emptySnapshot, statusControlState } from "./kernel/snapshot.ts";
import type { ExecutionContext } from "./kernel/types.ts";
import { MATRIX_CONTRACT_ROWS } from "./matrix.ts";
import type { BanStatus, Role } from "./primitives.ts";

function watchedContext(): { context: ExecutionContext; allocated: () => readonly string[] } {
  const allocated: string[] = [];
  return {
    context: {
      now: asInstant(1_000_000),
      currentUserId: USER_ID,
      allocateId: (kind: string) => {
        const id = `${kind}-${allocated.length + 1}`;
        allocated.push(id);
        return id;
      },
    },
    allocated: () => allocated,
  };
}

function initializationEvent(
  overrides: Partial<{
    rimChatId: RimChatId;
    selectedContactId: UserId;
    contextRequestId: ContextRequestId;
  }> = {},
): CanonicalEvent {
  return eventOf("RIM.INITIALIZATION_UNRECOVERABLE", {
    rimChatId: CHAT_ID,
    selectedContactId: CONTACT_A,
    contextRequestId: REQUEST_ID,
    ...overrides,
  });
}

function eventForChat(
  snapshot: ProductSnapshot,
  overrides: Partial<{
    rimChatId: RimChatId;
    selectedContactId: UserId;
    contextRequestId: ContextRequestId;
  }> = {},
): CanonicalEvent {
  const chat = snapshot.extended.rimChat;
  if (!chat?.relationshipContext) {
    throw new Error("expected a RimChat with a context request");
  }
  return eventOf("RIM.INITIALIZATION_UNRECOVERABLE", {
    rimChatId: chat.id,
    selectedContactId: chat.selectedContactId,
    contextRequestId: chat.relationshipContext.requestId,
    ...overrides,
  });
}

function ordinaryChat(state: "RIM.CHAT" | "RIM.SELECT_CONTACT"): ProductSnapshot {
  return withChat(
    withControlState(emptySnapshot(), state),
    makeChat({
      selectedContactId: CONTACT_A,
      relationshipContext: readyContext(),
      askRimOrigin: null,
    }),
  );
}

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
  const snapshot = withEntities(
    withControlState(emptySnapshot(), statusControlState(status, role)),
    {
      bans: { [BAN_ID]: ban },
      notificationItems: { [item.id]: item },
    },
  );
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

function withoutItem(snapshot: ProductSnapshot, itemId: string): ProductSnapshot {
  const notificationItems = { ...snapshot.extended.entities.notificationItems };
  delete notificationItems[itemId];
  return {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      activeNotificationItemId: null,
      entities: { ...snapshot.extended.entities, notificationItems },
    },
  };
}

function contextReady(snapshot: ProductSnapshot): CanonicalEvent {
  const chat = snapshot.extended.rimChat;
  if (!chat?.relationshipContext) {
    throw new Error("expected a loading RimChat");
  }
  return eventOf("RIM.CONTEXT_READY", {
    rimChatId: chat.id,
    selectedContactId: chat.selectedContactId,
    relationshipContext: CONTEXT_DATA,
    requestId: chat.relationshipContext.requestId,
  });
}

function openAskRim(status: BanStatus, role: Role) {
  const context = kernelContext();
  const source = statusWorld(status, role);
  const sourceId = source.extended.activeNotificationItemId;
  const opened = reduce(source, defaultEvent("NOTIFICATIONS.PRESS_ASK_RIM"), context);
  const ready = reduce(opened.snapshot, contextReady(opened.snapshot), context);
  return { context, source, sourceId, ready };
}

describe("E-64 RIM.INITIALIZATION_UNRECOVERABLE on RIM.CHAT", () => {
  it("terminates a matching ordinary chat into Select Contact without a new chat or contact", () => {
    const { context, allocated } = watchedContext();
    const before = ordinaryChat("RIM.CHAT");
    const chatId = before.extended.rimChat?.id;
    const ended = reduce(before, initializationEvent(), context);
    expect(ended.outcome).toBe("APPLIED");
    expect(ended.traces[0]?.eventId).toBe("E-64");
    expect(ended.traces[0]?.branch).toBe("ordinary-current");
    expect(ended.controlState).toBe("RIM.SELECT_CONTACT");
    expect(ended.snapshot.extended.rimChat).toBeNull();
    expect(ended.effects).toEqual([
      { type: "SET_RIM_CHAT", chat: null },
      { type: "SET_CONTROL_STATE", state: "RIM.SELECT_CONTACT" },
    ]);
    expect(allocated().some((id) => id.startsWith("rim-chat"))).toBe(false);
    expect(ended.snapshot.extended.rimChat?.id).not.toBe(chatId);
    expect(ended.snapshot.extended.entities).toEqual(before.extended.entities);
  });

  it("ignores a stale rimChatId", () => {
    const before = cloneSnapshot(ordinaryChat("RIM.CHAT"));
    const ended = reduce(
      before,
      initializationEvent({ rimChatId: branded<RimChatId>("chat-other") }),
      kernelContext(),
    );
    expect(ended.traces[0]?.branch).toBe("stale");
    expect(ended.controlState).toBe("RIM.CHAT");
    expect(ended.snapshot.extended.rimChat).toEqual(before.extended.rimChat);
    expect(ended.effects).toEqual([]);
  });

  it("ignores a stale selectedContactId", () => {
    const before = cloneSnapshot(ordinaryChat("RIM.CHAT"));
    const ended = reduce(
      before,
      initializationEvent({ selectedContactId: CONTACT_B }),
      kernelContext(),
    );
    expect(ended.traces[0]?.branch).toBe("stale");
    expect(ended.controlState).toBe("RIM.CHAT");
    expect(ended.snapshot.extended.rimChat).toEqual(before.extended.rimChat);
  });

  it("ignores a stale contextRequestId", () => {
    const before = cloneSnapshot(ordinaryChat("RIM.CHAT"));
    const ended = reduce(
      before,
      initializationEvent({
        contextRequestId: branded<ContextRequestId>("context-other"),
      }),
      kernelContext(),
    );
    expect(ended.traces[0]?.branch).toBe("stale");
    expect(ended.controlState).toBe("RIM.CHAT");
    expect(ended.snapshot.extended.rimChat).toEqual(before.extended.rimChat);
  });

  it("does not treat a pre-contact RIM.CHAT as the current chat", () => {
    const started = reduce(
      withControlState(emptySnapshot(), "RIM.LOBBY"),
      defaultEvent("RIM.PRESS_START_CHAT"),
      kernelContext(),
    );
    expect(started.snapshot.extended.rimChat).toBeNull();
    const ended = reduce(started.snapshot, initializationEvent(), kernelContext());
    expect(ended.traces[0]?.branch).toBe("stale");
    expect(ended.controlState).toBe("RIM.CHAT");
    expect(ended.snapshot.extended.rimChat).toBeNull();
  });
});

describe("E-64 Ask RIM on RIM.CHAT", () => {
  it.each([
    ["BANTASTIC", "RECEIVER"],
    ["BANFLICT", "SENDER"],
  ] as const)("restores the exact unprocessed %s %s Status and clears the chat", (status, role) => {
    const { context, sourceId, ready } = openAskRim(status, role);
    const chatId = ready.snapshot.extended.rimChat?.id;
    const ended = reduce(ready.snapshot, eventForChat(ready.snapshot), context);
    expect(ended.traces[0]?.branch).toBe("ask-rim-current");
    expect(ended.controlState).toBe(statusControlState(status, role));
    expect(ended.snapshot.extended.rimChat).toBeNull();
    expect(ended.snapshot.extended.rimChat?.id).not.toBe(chatId);
    expect(ended.snapshot.extended.activeNotificationItemId).toBe(sourceId);
    expect(ended.snapshot.extended.entities.notificationItems[sourceId!]?.lifecycle.status).toBe(
      "UNPROCESSED",
    );
  });

  it("sends a stored but invalid origin to Lobby without inventing or reactivating a Status", () => {
    const { context, sourceId, ready } = openAskRim("BANTASTIC", "RECEIVER");
    const processed = withProcessedItem(ready.snapshot, sourceId!);
    const missing = withoutItem(ready.snapshot, sourceId!);
    const processedEnd = reduce(processed, eventForChat(processed), context);
    expect(processedEnd.traces[0]?.branch).toBe("ask-rim-origin-invalid");
    expect(processedEnd.controlState).toBe("RIM.LOBBY");
    expect(processedEnd.snapshot.extended.rimChat).toBeNull();
    expect(
      processedEnd.snapshot.extended.entities.notificationItems[sourceId!]?.lifecycle.status,
    ).toBe("PROCESSED");
    expect(Object.keys(processedEnd.snapshot.extended.entities.notificationItems)).toEqual(
      Object.keys(processed.extended.entities.notificationItems),
    );
    expect(processedEnd.snapshot.extended.activeNotificationItemId).toBe(sourceId);

    const missingEnd = reduce(missing, eventForChat(missing), context);
    expect(missingEnd.traces[0]?.branch).toBe("ask-rim-origin-invalid");
    expect(missingEnd.controlState).toBe("RIM.LOBBY");
    expect(missingEnd.snapshot.extended.rimChat).toBeNull();
    expect(missingEnd.snapshot.extended.entities.notificationItems[sourceId!]).toBeUndefined();
    expect(missingEnd.snapshot.extended.activeNotificationItemId).toBeNull();
    expect(Object.keys(missingEnd.snapshot.extended.entities.notificationItems)).toEqual([]);
  });

  it("leaves the current Ask RIM chat unchanged when correlation does not match", () => {
    const { ready } = openAskRim("BANFLICT", "SENDER");
    const before = cloneSnapshot(ready.snapshot);
    const ended = reduce(
      before,
      eventForChat(before, { rimChatId: branded<RimChatId>("chat-other") }),
      kernelContext(),
    );
    expect(ended.traces[0]?.branch).toBe("stale");
    expect(ended.controlState).toBe("RIM.CHAT");
    expect(ended.snapshot.extended.rimChat).toEqual(before.extended.rimChat);
    expect(ended.snapshot.extended.activeNotificationItemId).toBe(
      before.extended.activeNotificationItemId,
    );
  });
});

describe("E-64 on RIM.SELECT_CONTACT", () => {
  it("clears a matching ordinary chat and stays on Select Contact", () => {
    const context = kernelContext();
    const started = reduce(
      withControlState(emptySnapshot(), "RIM.LOBBY"),
      defaultEvent("RIM.PRESS_START_CHAT"),
      context,
    );
    const selecting = reduce(started.snapshot, defaultEvent("RIM.PRESS_SELECT_CONTACT"), context);
    const born = reduce(
      selecting.snapshot,
      eventOf("RIM.SELECT_CONTACT", { contactId: CONTACT_A }),
      context,
    );
    const ready = reduce(born.snapshot, contextReady(born.snapshot), context);
    const reopened = reduce(ready.snapshot, defaultEvent("RIM.PRESS_SELECT_CONTACT"), context);
    const chatId = reopened.snapshot.extended.rimChat?.id;
    expect(reopened.controlState).toBe("RIM.SELECT_CONTACT");
    expect(chatId).toBeTruthy();
    const ended = reduce(reopened.snapshot, eventForChat(reopened.snapshot), context);
    expect(ended.traces[0]?.branch).toBe("ordinary-current");
    expect(ended.controlState).toBe("RIM.SELECT_CONTACT");
    expect(ended.snapshot.extended.rimChat).toBeNull();
    expect(ended.effects).toEqual([{ type: "SET_RIM_CHAT", chat: null }]);
  });

  it.each([
    ["BANTASTIC", "RECEIVER"],
    ["BANFLICT", "SENDER"],
  ] as const)("restores the exact %s %s Status from an open selector", (status, role) => {
    const { context, sourceId, ready } = openAskRim(status, role);
    const selecting = reduce(ready.snapshot, defaultEvent("RIM.PRESS_SELECT_CONTACT"), context);
    expect(selecting.controlState).toBe("RIM.SELECT_CONTACT");
    expect(selecting.snapshot.extended.rimChat?.askRimOrigin?.sourceStatusItemId).toBe(sourceId);
    const ended = reduce(selecting.snapshot, eventForChat(selecting.snapshot), context);
    expect(ended.traces[0]?.branch).toBe("ask-rim-current");
    expect(ended.controlState).toBe(statusControlState(status, role));
    expect(ended.snapshot.extended.rimChat).toBeNull();
    expect(ended.snapshot.extended.activeNotificationItemId).toBe(sourceId);
    expect(ended.snapshot.extended.entities.notificationItems[sourceId!]?.lifecycle.status).toBe(
      "UNPROCESSED",
    );
  });

  it("sends a stored but invalid origin to Lobby", () => {
    const { context, sourceId, ready } = openAskRim("BANTASTIC", "RECEIVER");
    const selecting = reduce(ready.snapshot, defaultEvent("RIM.PRESS_SELECT_CONTACT"), context);
    const invalid = withProcessedItem(selecting.snapshot, sourceId!);
    const ended = reduce(invalid, eventForChat(invalid), context);
    expect(ended.traces[0]?.branch).toBe("ask-rim-origin-invalid");
    expect(ended.controlState).toBe("RIM.LOBBY");
    expect(ended.snapshot.extended.rimChat).toBeNull();
    expect(ended.snapshot.extended.entities.notificationItems[sourceId!]?.lifecycle.status).toBe(
      "PROCESSED",
    );
    expect(Object.keys(ended.snapshot.extended.entities.notificationItems)).toEqual(
      Object.keys(invalid.extended.entities.notificationItems),
    );
  });

  it("preserves the existing chat when correlation does not match", () => {
    const before = cloneSnapshot(ordinaryChat("RIM.SELECT_CONTACT"));
    const ended = reduce(
      before,
      initializationEvent({ contextRequestId: branded<ContextRequestId>("context-other") }),
      kernelContext(),
    );
    expect(ended.traces[0]?.branch).toBe("stale");
    expect(ended.controlState).toBe("RIM.SELECT_CONTACT");
    expect(ended.snapshot.extended.rimChat).toEqual(before.extended.rimChat);
  });

  it("does not treat a pre-contact selector as a current chat", () => {
    const started = reduce(
      withControlState(emptySnapshot(), "RIM.LOBBY"),
      defaultEvent("RIM.PRESS_START_CHAT"),
      kernelContext(),
    );
    const selecting = reduce(
      started.snapshot,
      defaultEvent("RIM.PRESS_SELECT_CONTACT"),
      kernelContext(),
    );
    expect(selecting.controlState).toBe("RIM.SELECT_CONTACT");
    expect(selecting.snapshot.extended.rimChat).toBeNull();
    const ended = reduce(selecting.snapshot, initializationEvent(), kernelContext());
    expect(ended.traces[0]?.branch).toBe("stale");
    expect(ended.controlState).toBe("RIM.SELECT_CONTACT");
    expect(ended.snapshot.extended.rimChat).toBeNull();
    expect(ended.effects).toEqual([]);
  });
});

describe("E-64 registry", () => {
  it("adds one SERVER event and eight rows only on RIM.CHAT and RIM.SELECT_CONTACT", () => {
    const definition = CANONICAL_EVENT_DEFINITIONS.find((item) => item.id === "E-64");
    expect(definition?.name).toBe("RIM.INITIALIZATION_UNRECOVERABLE");
    expect(definition?.source).toBe("SERVER");
    const rows = MATRIX_CONTRACT_ROWS.filter((row) => row.eventId === "E-64");
    expect(rows.map((row) => `${row.state}:${row.branch}`).sort()).toEqual(
      [
        "RIM.CHAT:ask-rim-current",
        "RIM.CHAT:ask-rim-origin-invalid",
        "RIM.CHAT:ordinary-current",
        "RIM.CHAT:stale",
        "RIM.SELECT_CONTACT:ask-rim-current",
        "RIM.SELECT_CONTACT:ask-rim-origin-invalid",
        "RIM.SELECT_CONTACT:ordinary-current",
        "RIM.SELECT_CONTACT:stale",
      ].sort(),
    );
    expect(rows.some((row) => String(row.state).startsWith("CREATE_BAN"))).toBe(false);
  });
});
