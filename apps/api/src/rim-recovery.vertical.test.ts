import { describe, expect, it } from "vitest";
import {
  applicableRimProviderRuntime,
  parseRimProviderRuntime,
  type ProviderConversationId,
  type RimAiRequest,
  type RimProviderAttemptId,
  type RimProviderRuntime,
} from "@98plus/application";
import { MemorySqlClient } from "@98plus/persistence";
import { grantContactBetweenTelegramUsers } from "./seed-contact.ts";
import { executeIncomingOverboardVertical } from "./overboard.ts";
import {
  authenticateRuntime,
  createCreateBanContactRuntime,
  executeAuthenticatedEvent,
  loadDiagnostics,
  openLobbyIfNeeded,
  seedRegisteredUsers,
  userIdOf,
} from "./runtime.ts";

const SECRET = "test-secret";

function recordingPort(seen: RimAiRequest[]) {
  return {
    async respond(request: RimAiRequest) {
      seen.push(request);
      return { kind: "MESSAGE" as const, text: "слышу" };
    },
  };
}

async function readyChat(seen: RimAiRequest[]) {
  const runtime = createCreateBanContactRuntime({ rimAi: recordingPort(seen) });
  await seedRegisteredUsers(runtime, ["1001", "1002"]);
  const context = await authenticateRuntime(runtime, {
    method: "development",
    secret: SECRET,
    telegramUserId: "1001",
  });
  await grantContactBetweenTelegramUsers(runtime, "1001", "1002");
  const contactId = await userIdOf(runtime, "1002");
  expect(contactId).toBeTruthy();
  await openLobbyIfNeeded(runtime, context);
  await executeIncomingOverboardVertical(runtime, context, {
    name: "RIM.PRESS_START_CHAT",
    payload: {},
  });
  await executeIncomingOverboardVertical(runtime, context, {
    name: "RIM.PRESS_SELECT_CONTACT",
    payload: {},
  });
  await executeIncomingOverboardVertical(runtime, context, {
    name: "RIM.SELECT_CONTACT",
    payload: { contactId },
  });
  await executeIncomingOverboardVertical(runtime, context, {
    name: "RIM.CHANGE_INPUT_DRAFT",
    payload: { inputDraft: "привет" },
  });
  const sent = await executeAuthenticatedEvent(runtime, context, {
    name: "RIM.PRESS_SEND",
    payload: {},
  });
  const chat = sent.snapshot.extended.rimChat;
  expect(chat?.aiOperation.status).toBe("PENDING");
  if (!chat || chat.aiOperation.status !== "PENDING" || !chat.selectedContactId) {
    throw new Error("expected a pending RIM chat");
  }
  return { runtime, context, chat, sent };
}

async function storedConversationId(
  ready: Awaited<ReturnType<typeof readyChat>>,
): Promise<ProviderConversationId> {
  const loaded = await ready.runtime.productStore.loadProductSnapshot(ready.context.currentUserId);
  const applicable = applicableRimProviderRuntime(
    parseRimProviderRuntime(loaded.rimProviderRuntime),
    ready.chat.id,
  );
  if (applicable?.initialization.submissionState === "stored") {
    return applicable.initialization.conversationId;
  }
  return "conv-hook" as ProviderConversationId;
}

function notSubmittedRuntime(
  chat: NonNullable<Awaited<ReturnType<typeof readyChat>>["chat"]>,
  submissionState: "not-submitted" | "acceptance-unknown",
  conversationId: ProviderConversationId,
): RimProviderRuntime {
  if (chat.aiOperation.status !== "PENDING" || !chat.selectedContactId) {
    throw new Error("expected a pending chat");
  }
  return {
    rimChatId: chat.id,
    selectedContactId: chat.selectedContactId,
    contextRequestId: chat.aiOperation.snapshot.contextRequestId,
    initialization: {
      submissionState: "stored",
      attemptId: "init-hook" as RimProviderAttemptId,
      conversationId,
      clientRequestId: null,
    },
    attempt: {
      requestId: chat.aiOperation.requestId,
      attemptId: "attempt-hook" as RimProviderAttemptId,
      submissionState,
      clientRequestId: "hook-client",
    },
    continuityMode: "provider-conversation",
    retiredAttemptId: null,
  };
}

describe("RIM AI recovery hooks", () => {
  it("does not recover from a snapshot read, and does recover on session re-entry", async () => {
    const seen: RimAiRequest[] = [];
    const ready = await readyChat(seen);
    const { runtime, context, chat, sent } = ready;
    expect(seen).toEqual([]);
    if (chat.aiOperation.status !== "PENDING") {
      return;
    }
    const conversationId = await storedConversationId(ready);
    await runtime.productStore.saveRimProviderRuntime(
      context.currentUserId,
      sent.revision,
      notSubmittedRuntime(chat, "not-submitted", conversationId),
    );
    await loadDiagnostics(runtime, context);
    expect(seen).toEqual([]);
    const opened = await openLobbyIfNeeded(runtime, context);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.continuityMode).toBe("provider-conversation");
    if (seen[0]?.continuityMode === "provider-conversation") {
      expect(seen[0].conversationId).toBe(conversationId);
      expect(seen[0].userMessage).toBe("привет");
    }
    expect(seen[0]?.requestId).toBe(chat.aiOperation.requestId);
    expect(opened.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect(
      opened.loaded.snapshot.extended.rimChat?.messages.filter(
        (message) => message.kind === "USER",
      ),
    ).toEqual([{ kind: "USER", text: "привет" }]);
    expect(opened.execution?.traces.some((trace) => trace.eventId === "E-54")).toBe(false);
  });

  it("recovers a restored pending chat from the event path without another open", async () => {
    const seen: RimAiRequest[] = [];
    const ready = await readyChat(seen);
    const { runtime, context, chat, sent } = ready;
    if (chat.aiOperation.status !== "PENDING") {
      return;
    }
    await runtime.productStore.saveRimProviderRuntime(
      context.currentUserId,
      sent.revision,
      notSubmittedRuntime(chat, "not-submitted", await storedConversationId(ready)),
    );
    const drafted = await executeIncomingOverboardVertical(runtime, context, {
      name: "RIM.CHANGE_INPUT_DRAFT",
      payload: { inputDraft: "ещё" },
    });
    expect(seen).toHaveLength(1);
    expect(drafted.last.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect(seen[0]?.requestId).toBe(chat.aiOperation.requestId);
  });

  it("executes the local attempt when a renewal-lapsed acceptance-unknown session is opened", async () => {
    const seen: RimAiRequest[] = [];
    const ready = await readyChat(seen);
    const { runtime, context, chat, sent } = ready;
    if (chat.aiOperation.status !== "PENDING") {
      return;
    }
    const conversationId = await storedConversationId(ready);
    await runtime.productStore.saveRimProviderRuntime(
      context.currentUserId,
      sent.revision,
      notSubmittedRuntime(chat, "acceptance-unknown", conversationId),
    );
    if (!(runtime.sql instanceof MemorySqlClient)) {
      throw new Error("this vertical seed requires the memory SQL client");
    }
    const seeded = runtime.sql.tables.insertOwnership({
      userId: context.currentUserId,
      operationKind: "user-attempt",
      attemptId: "attempt-hook",
      requestId: chat.aiOperation.requestId,
      ownerToken: "00000000-0000-4000-8000-0000000000aa",
      leasedUntilMs: Date.now() - 1_000,
      releasedAtMs: null,
      releaseReason: null,
    });
    if (!seeded) {
      throw new Error("attempt-hook ownership was already present");
    }
    const opened = await openLobbyIfNeeded(runtime, context);
    const once = await runtime.productStore.loadProductSnapshot(context.currentUserId);
    const transitioned = applicableRimProviderRuntime(
      parseRimProviderRuntime(once.rimProviderRuntime),
      chat.id,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.continuityMode).toBe("local-canonical-history");
    expect(seen[0] && "conversationId" in seen[0]).toBe(false);
    expect(seen[0]?.requestId).toBe(chat.aiOperation.requestId);
    if (seen[0]?.continuityMode === "local-canonical-history") {
      expect(
        seen[0].canonicalHistory.filter(
          (entry) => entry.kind === "USER" && entry.text === "привет",
        ),
      ).toHaveLength(1);
    }
    expect(opened.loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect(
      opened.loaded.snapshot.extended.rimChat?.messages.filter(
        (message) => message.kind === "USER",
      ),
    ).toEqual([{ kind: "USER", text: "привет" }]);
    expect(transitioned?.continuityMode).toBe("local-canonical-history");
    expect(transitioned?.retiredAttemptId).toBe("attempt-hook");
    if (transitioned?.initialization.submissionState !== "stored") {
      throw new Error("expected stored initialization");
    }
    expect(transitioned.initialization.conversationId).toBe(conversationId);
    expect(transitioned?.attempt?.submissionState).toBe("returned-body-observed");
    expect(transitioned?.attempt?.attemptId).not.toBe("attempt-hook");
    expect(transitioned?.attempt?.requestId).toBe(chat.aiOperation.requestId);
    await openLobbyIfNeeded(runtime, context);
    const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
    const settled = applicableRimProviderRuntime(
      parseRimProviderRuntime(loaded.rimProviderRuntime),
      chat.id,
    );
    expect(seen).toHaveLength(1);
    expect(settled).toEqual(transitioned);
  });
});
