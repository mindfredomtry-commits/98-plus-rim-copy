import { describe, expect, it } from "vitest";
import type {
  ProviderConversationId,
  RimAiRequest,
  RimProviderAttemptId,
  RimProviderRuntime,
} from "@98plus/application";
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
  grantContactBetweenTelegramUsers(runtime, "1001", "1002");
  const contactId = userIdOf(runtime, "1002");
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

function notSubmittedRuntime(
  chat: NonNullable<Awaited<ReturnType<typeof readyChat>>["chat"]>,
  submissionState: "not-submitted" | "acceptance-unknown",
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
      conversationId: "conv-hook" as ProviderConversationId,
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
    const { runtime, context, chat, sent } = await readyChat(seen);
    expect(seen).toEqual([]);
    if (chat.aiOperation.status !== "PENDING") {
      return;
    }
    await runtime.productStore.saveRimProviderRuntime(
      context.currentUserId,
      sent.revision,
      notSubmittedRuntime(chat, "not-submitted"),
    );
    await loadDiagnostics(runtime, context);
    expect(seen).toEqual([]);
    const opened = await openLobbyIfNeeded(runtime, context);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.requestId).toBe(chat.aiOperation.requestId);
    expect(seen[0]?.userMessage).toBe("привет");
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
    const { runtime, context, chat, sent } = await readyChat(seen);
    if (chat.aiOperation.status !== "PENDING") {
      return;
    }
    await runtime.productStore.saveRimProviderRuntime(
      context.currentUserId,
      sent.revision,
      notSubmittedRuntime(chat, "not-submitted"),
    );
    const drafted = await executeIncomingOverboardVertical(runtime, context, {
      name: "RIM.CHANGE_INPUT_DRAFT",
      payload: { inputDraft: "ещё" },
    });
    expect(seen).toHaveLength(1);
    expect(drafted.last.snapshot.extended.rimChat?.aiOperation.status).toBe("IDLE");
    expect(seen[0]?.requestId).toBe(chat.aiOperation.requestId);
  });

  it("does not resubmit acceptance-unknown when the session is opened again", async () => {
    const seen: RimAiRequest[] = [];
    const { runtime, context, chat, sent } = await readyChat(seen);
    if (chat.aiOperation.status !== "PENDING") {
      return;
    }
    await runtime.productStore.saveRimProviderRuntime(
      context.currentUserId,
      sent.revision,
      notSubmittedRuntime(chat, "acceptance-unknown"),
    );
    await openLobbyIfNeeded(runtime, context);
    await openLobbyIfNeeded(runtime, context);
    const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
    expect(seen).toEqual([]);
    expect(loaded.snapshot.extended.rimChat?.aiOperation.status).toBe("PENDING");
  });
});
