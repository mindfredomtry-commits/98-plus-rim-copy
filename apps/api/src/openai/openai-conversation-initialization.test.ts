import { describe, expect, it } from "vitest";
import type {
  AskRimOrigin,
  BanId,
  ContextRequestId,
  NotificationItemId,
  RelationshipContextData,
  RimChatId,
  UserId,
} from "@98plus/product-model";
import {
  PRODUCT_SEMANTICS_MVP15,
  PRODUCT_SEMANTICS_UNAVAILABLE,
  RIM_PROMPT_UNAVAILABLE,
  RIM_PROMPT_V1,
  type RimConversationInitializationRequest,
  type RimProviderAttemptId,
} from "@98plus/application";
import { PRODUCT_SEMANTICS_MVP15_TEXT } from "../../../../packages/application/src/rim/semantics/product-semantics-mvp15.ts";
import { RIM_PROMPT_V1_TEXT } from "../../../../packages/application/src/rim/semantics/rim-prompt-v1.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  OpenAiConversationInitializer,
  type OpenAiConversationInitializationBody,
  type OpenAiConversationInitializationOptions,
} from "./openai-conversation-initialization.ts";

const CONTEXT: RelationshipContextData = {
  aggregates: {
    userToContact: {
      bansSentCount: 1,
      statusCounts: { bantastic: 1, banflict: 0, fairEnough: 0, overboard: 0 },
    },
    contactToUser: {
      bansSentCount: 2,
      statusCounts: { bantastic: 0, banflict: 1, fairEnough: 1, overboard: 0 },
    },
  },
  recentBans: [
    {
      direction: "USER_TO_CONTACT",
      banText: "первый",
      ageHours: 5,
      result: { kind: "ACTIVE" },
    },
    {
      direction: "CONTACT_TO_USER",
      banText: "второй",
      ageHours: 1,
      result: { kind: "AWAITING_RESPONSE" },
    },
  ],
};

const ASK_ORIGIN: AskRimOrigin = {
  sourceStatusItemId: "item-1" as NotificationItemId,
  banId: "ban-1" as BanId,
  status: "BANTASTIC",
  sourceRole: "RECEIVER",
};

type RecordedCreate = {
  body: OpenAiConversationInitializationBody;
  options: OpenAiConversationInitializationOptions & {
    idempotencyKey?: string;
    timeout?: number;
  };
};

function recordingClient(outcome: { id: string } | Error) {
  const calls: RecordedCreate[] = [];
  let responseCreates = 0;
  let retrieves = 0;
  const client = {
    conversations: {
      async create(body: OpenAiConversationInitializationBody, options: RecordedCreate["options"]) {
        calls.push({ body, options });
        if (outcome instanceof Error) {
          throw outcome;
        }
        return outcome;
      },
      async retrieve() {
        retrieves += 1;
        return { id: "conv_retrieved" };
      },
    },
    responses: {
      async create() {
        responseCreates += 1;
        return { id: "resp_created" };
      },
    },
  };
  return {
    client,
    calls,
    responseCreates: () => responseCreates,
    retrieves: () => retrieves,
  };
}

function request(
  origin: AskRimOrigin | null,
  relationshipContext: RelationshipContextData = CONTEXT,
): RimConversationInitializationRequest {
  return {
    rimChatId: "chat-1" as RimChatId,
    selectedContactId: "contact-1" as UserId,
    contextRequestId: "context-1" as ContextRequestId,
    attemptId: "attempt-1" as RimProviderAttemptId,
    clientRequestId: "client-request-1",
    rimPrompt: RIM_PROMPT_V1,
    productSemantics: PRODUCT_SEMANTICS_MVP15,
    relationshipContext,
    origin,
  };
}

describe("OpenAiConversationInitializer", () => {
  it("creates one conversation with four developer items and explicit null origin", async () => {
    const transport = recordingClient({ id: "conv_test_ordinary" });
    const initializer = new OpenAiConversationInitializer(transport.client);
    const result = await initializer.initialize(request(null));

    expect(transport.calls).toHaveLength(1);
    expect(transport.responseCreates()).toBe(0);
    expect(transport.retrieves()).toBe(0);
    expect(result.conversationId).toBe("conv_test_ordinary");

    const call = transport.calls[0];
    expect(call).toBeDefined();
    if (!call) {
      return;
    }
    expect(call.options).toEqual({ maxRetries: 0 });
    expect(Object.keys(call.options)).toEqual(["maxRetries"]);
    expect(Object.hasOwn(call.options, "idempotencyKey")).toBe(false);
    expect(Object.hasOwn(call.options, "timeout")).toBe(false);
    expect(Object.keys(call.body)).toEqual(["items"]);
    expect(Object.hasOwn(call.body, "metadata")).toBe(false);
    expect(JSON.stringify(call)).not.toContain("client-request-1");

    expect(call.body.items).toHaveLength(4);
    expect(call.body.items.map((item) => item.role)).toEqual([
      "developer",
      "developer",
      "developer",
      "developer",
    ]);
    expect(call.body.items.map((item) => item.type)).toEqual([
      "message",
      "message",
      "message",
      "message",
    ]);
    expect(call.body.items[0]?.content).toBe(RIM_PROMPT_V1_TEXT);
    expect(call.body.items[0]?.content).toBe(RIM_PROMPT_V1.text);
    expect(call.body.items[1]?.content).toBe(PRODUCT_SEMANTICS_MVP15_TEXT);
    expect(call.body.items[1]?.content).toBe(PRODUCT_SEMANTICS_MVP15.text);
    expect(call.body.items[2]?.content).toBe(canonicalJson({ relationshipContext: CONTEXT }));
    expect(JSON.parse(call.body.items[2]?.content ?? "")).toEqual({
      relationshipContext: CONTEXT,
    });
    expect(call.body.items[3]?.content).toBe('{"origin":null}');
    expect(JSON.parse(call.body.items[3]?.content ?? "")).toEqual({ origin: null });
  });

  it("serializes the same RelationshipContext when its keys were inserted in another order", async () => {
    const reordered: RelationshipContextData = {
      recentBans: CONTEXT.recentBans.map((ban) => ({
        result: ban.result,
        ageHours: ban.ageHours,
        banText: ban.banText,
        direction: ban.direction,
      })),
      aggregates: {
        contactToUser: CONTEXT.aggregates.contactToUser,
        userToContact: CONTEXT.aggregates.userToContact,
      },
    };
    const first = recordingClient({ id: "conv_test_order_a" });
    const second = recordingClient({ id: "conv_test_order_b" });
    await new OpenAiConversationInitializer(first.client).initialize(request(null, CONTEXT));
    await new OpenAiConversationInitializer(second.client).initialize(request(null, reordered));
    expect(second.calls[0]?.body.items[2]?.content).toBe(first.calls[0]?.body.items[2]?.content);
    const parsed = JSON.parse(first.calls[0]?.body.items[2]?.content ?? "") as {
      relationshipContext: RelationshipContextData;
    };
    expect(parsed.relationshipContext.recentBans.map((ban) => ban.banText)).toEqual([
      "первый",
      "второй",
    ]);
  });

  it("sends the exact AskRimOrigin", async () => {
    const transport = recordingClient({ id: "conv_test_ask" });
    const result = await new OpenAiConversationInitializer(transport.client).initialize(
      request(ASK_ORIGIN),
    );
    expect(result.conversationId).toBe("conv_test_ask");
    const originItem = transport.calls[0]?.body.items[3]?.content;
    expect(originItem).toBe(canonicalJson({ origin: ASK_ORIGIN }));
    expect(JSON.parse(originItem ?? "")).toEqual({ origin: ASK_ORIGIN });
    expect(originItem).toContain("BANTASTIC");
    expect(originItem).toContain("item-1");
    expect(originItem).toContain("ban-1");
    expect(originItem).toContain("RECEIVER");
  });

  it("reuses the injected client across initialization calls", async () => {
    const transport = recordingClient({ id: "conv_test_shared" });
    const initializer = new OpenAiConversationInitializer(transport.client);
    await initializer.initialize(request(null));
    await initializer.initialize(request(ASK_ORIGIN));
    expect(transport.calls).toHaveLength(2);
    expect(transport.responseCreates()).toBe(0);
  });

  it("rejects an unavailable RIM Prompt before the provider call", async () => {
    const transport = recordingClient({ id: "conv_test_unused" });
    const initializer = new OpenAiConversationInitializer(transport.client);
    await expect(
      initializer.initialize({ ...request(null), rimPrompt: RIM_PROMPT_UNAVAILABLE }),
    ).rejects.toThrow(/not provider-ready/);
    expect(transport.calls).toHaveLength(0);
    expect(transport.responseCreates()).toBe(0);
    expect(transport.retrieves()).toBe(0);
  });

  it("rejects unavailable Product Semantics before the provider call", async () => {
    const transport = recordingClient({ id: "conv_test_unused" });
    const initializer = new OpenAiConversationInitializer(transport.client);
    await expect(
      initializer.initialize({
        ...request(null),
        productSemantics: PRODUCT_SEMANTICS_UNAVAILABLE,
      }),
    ).rejects.toThrow(/not provider-ready/);
    expect(transport.calls).toHaveLength(0);
    expect(transport.responseCreates()).toBe(0);
    expect(transport.retrieves()).toBe(0);
  });

  it("propagates a provider error without a second create or a product result", async () => {
    const providerError = new Error("conversation create acceptance unknown");
    const transport = recordingClient(providerError);
    const initializer = new OpenAiConversationInitializer(transport.client);
    await expect(initializer.initialize(request(null))).rejects.toBe(providerError);
    expect(transport.calls).toHaveLength(1);
    expect(transport.responseCreates()).toBe(0);
    expect(transport.retrieves()).toBe(0);
    expect(Object.hasOwn(transport.calls[0]?.body ?? {}, "metadata")).toBe(false);
    expect(providerError).not.toHaveProperty("conversationId");
  });
});
