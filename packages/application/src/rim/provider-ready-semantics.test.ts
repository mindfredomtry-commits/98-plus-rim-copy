import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_EVENT_COUNT,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  type AiRequestId,
  type BanId,
  type ContextRequestId,
  type NotificationItemId,
  type RelationshipContextData,
  type RimChatId,
  type UserId,
} from "@98plus/product-model";
import { FakeRimAiAdapter } from "./fake-rim-ai-adapter.ts";
import { providerModelFacingTurn, type ProviderRimAiRequest } from "./rim-ai-port.ts";
import {
  assertProviderReadyInitialization,
  assertProviderReadySemantics,
  PRODUCT_SEMANTICS_MVP15,
  PRODUCT_SEMANTICS_UNAVAILABLE,
  providerReadySemanticInputs,
  RIM_PROMPT_UNAVAILABLE,
  RIM_PROMPT_V1,
  type ProductSemanticsInput,
  type RimConversationInitializationRequest,
  type RimPromptInput,
} from "./rim-conversation-port.ts";
import type { ProviderConversationId, RimProviderAttemptId } from "./rim-provider-runtime.ts";
import { PRODUCT_SEMANTICS_MVP15_TEXT } from "./semantics/product-semantics-mvp15.ts";
import { RIM_PROMPT_V1_TEXT } from "./semantics/rim-prompt-v1.ts";

const SEMANTICS_DIR = join(dirname(fileURLToPath(import.meta.url)), "semantics");

function approvedText(filename: string): string {
  return readFileSync(join(SEMANTICS_DIR, filename), "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const CONTEXT: RelationshipContextData = {
  aggregates: {
    userToContact: {
      bansSentCount: 1,
      statusCounts: { bantastic: 1, banflict: 0, fairEnough: 0, overboard: 0 },
    },
    contactToUser: {
      bansSentCount: 0,
      statusCounts: { bantastic: 0, banflict: 0, fairEnough: 0, overboard: 0 },
    },
  },
  recentBans: [],
};

function initializationRequest(
  rimPrompt: RimPromptInput,
  productSemantics: ProductSemanticsInput,
): RimConversationInitializationRequest {
  return {
    rimChatId: "chat-1" as RimChatId,
    selectedContactId: "contact-1" as UserId,
    contextRequestId: "context-1" as ContextRequestId,
    attemptId: "attempt-1" as RimProviderAttemptId,
    clientRequestId: null,
    rimPrompt,
    productSemantics,
    relationshipContext: CONTEXT,
    origin: null,
  };
}

describe("provider-ready semantic artifacts", () => {
  it("keeps the runtime prompt identical to the approved artifact", () => {
    const approved = approvedText("MVP14_RIM_PROMPT_v1.md");
    expect(RIM_PROMPT_V1.kind).toBe("rim-prompt");
    expect(RIM_PROMPT_V1.availability).toBe("available");
    expect(RIM_PROMPT_V1.text).toBe(RIM_PROMPT_V1_TEXT);
    expect(RIM_PROMPT_V1.text).toBe(approved);
    expect(sha256(RIM_PROMPT_V1.text)).toBe(sha256(approved));
  });

  it("keeps the runtime product semantics identical to the approved artifact", () => {
    const approved = approvedText("MVP15_PRODUCT_SEMANTICS.md");
    expect(PRODUCT_SEMANTICS_MVP15.kind).toBe("product-semantics");
    expect(PRODUCT_SEMANTICS_MVP15.availability).toBe("available");
    expect(PRODUCT_SEMANTICS_MVP15.text).toBe(PRODUCT_SEMANTICS_MVP15_TEXT);
    expect(PRODUCT_SEMANTICS_MVP15.text).toBe(approved);
    expect(sha256(PRODUCT_SEMANTICS_MVP15.text)).toBe(sha256(approved));
  });

  it("mints provider-ready inputs only as the two approved singletons", () => {
    expect(providerReadySemanticInputs.length).toBe(0);
    const first = providerReadySemanticInputs();
    const second = providerReadySemanticInputs();
    expect(first.rimPrompt).toBe(RIM_PROMPT_V1);
    expect(first.productSemantics).toBe(PRODUCT_SEMANTICS_MVP15);
    expect(second.rimPrompt).toBe(first.rimPrompt);
    expect(second.productSemantics).toBe(first.productSemantics);
    expect(
      assertProviderReadyInitialization(
        initializationRequest(first.rimPrompt, first.productSemantics),
      ),
    ).toEqual(initializationRequest(RIM_PROMPT_V1, PRODUCT_SEMANTICS_MVP15));
    expect(assertProviderReadySemantics(first)).toEqual(first);
  });

  it("rejects caller-provided prompt and semantics text", () => {
    const exactCopy = {
      availability: "available" as const,
      kind: "rim-prompt" as const,
      text: RIM_PROMPT_V1.text,
    };
    const arbitrary = {
      availability: "available" as const,
      kind: "product-semantics" as const,
      text: "caller-authored semantics",
    };
    expect(() =>
      assertProviderReadyInitialization(
        initializationRequest(exactCopy as RimPromptInput, PRODUCT_SEMANTICS_MVP15),
      ),
    ).toThrow(/not provider-ready/);
    expect(() =>
      assertProviderReadySemantics({
        rimPrompt: RIM_PROMPT_V1,
        productSemantics: arbitrary as ProductSemanticsInput,
      }),
    ).toThrow(/not provider-ready/);
    expect(() =>
      assertProviderReadyInitialization(
        initializationRequest(RIM_PROMPT_UNAVAILABLE, PRODUCT_SEMANTICS_UNAVAILABLE),
      ),
    ).toThrow(/not provider-ready/);
  });

  it("keeps provider continuation model-facing payload to conversation id and one USER message", () => {
    const request: ProviderRimAiRequest = {
      continuityMode: "provider-conversation",
      requestId: "request-1" as AiRequestId,
      rimChatId: "chat-1" as RimChatId,
      conversationId: "conv-1" as ProviderConversationId,
      userMessage: "сейчас",
      contextRequestId: "context-1" as ContextRequestId,
      relationshipContext: CONTEXT,
      messages: [
        { kind: "RIM", text: "раньше" },
        { kind: "USER", text: "сейчас" },
      ],
      conversationalOrigin: {
        sourceStatusItemId: "item-1" as NotificationItemId,
        banId: "ban-1" as BanId,
        status: "BANTASTIC",
        sourceRole: "RECEIVER",
      },
    };
    const facing = providerModelFacingTurn(request);
    expect(facing).toEqual({ conversationId: "conv-1", userMessage: "сейчас" });
    expect(Object.keys(facing).sort()).toEqual(["conversationId", "userMessage"]);
    const encoded = JSON.stringify(facing);
    expect(encoded.split("сейчас").length - 1).toBe(1);
    expect(encoded).not.toContain("relationshipContext");
    expect(encoded).not.toContain("BANTASTIC");
    expect(encoded).not.toContain(RIM_PROMPT_V1.text.slice(0, 24));
    expect(encoded).not.toContain(PRODUCT_SEMANTICS_MVP15.text.slice(0, 24));
    expect("rimPrompt" in request).toBe(false);
    expect("productSemantics" in request).toBe(false);
    expect("conversationId" in facing).toBe(true);
  });

  it("keeps FakeRimAiAdapter functional without a provider client", async () => {
    const fake = new FakeRimAiAdapter();
    const initialized = await fake.initialize(
      initializationRequest(RIM_PROMPT_V1, PRODUCT_SEMANTICS_MVP15),
    );
    expect(initialized.conversationId).toBe("fake-conversation-attempt-1");
    expect(fake.initializationRequests[0]?.rimPrompt).toBe(RIM_PROMPT_V1);
    const localRequest = {
      continuityMode: "local-canonical-history" as const,
      requestId: "request-1" as AiRequestId,
      rimChatId: "chat-1" as RimChatId,
      contextRequestId: "context-1" as ContextRequestId,
      relationshipContext: CONTEXT,
      conversationalOrigin: null,
      rimPrompt: RIM_PROMPT_V1,
      productSemantics: PRODUCT_SEMANTICS_MVP15,
      canonicalHistory: [{ kind: "USER" as const, text: "один раз" }],
    };
    expect("conversationId" in localRequest).toBe(false);
    const local = await fake.respond(localRequest);
    expect(local).toEqual({ kind: "MESSAGE", text: "один раз" });
  });

  it("preserves the frozen product counts", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(58);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(358);
  });
});
