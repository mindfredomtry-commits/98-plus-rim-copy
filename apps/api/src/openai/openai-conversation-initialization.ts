import type { OpenAI } from "openai";
import {
  assertProviderReadyInitialization,
  type ProviderConversationId,
  type ProviderReadyRimConversationInitializationRequest,
  type RimConversationInitializationPort,
  type RimConversationInitializationRequest,
  type RimConversationInitializationResult,
} from "@98plus/application";
import { canonicalJson } from "./canonical-json.ts";
import { OPENAI_CLIENT_MAX_RETRIES } from "./openai-client.ts";

/**
 * OpenAI Conversations create for RIM initialization.
 * One shared client is adapted once and reused. This transport does not generate,
 * retry, retrieve, persist, or choose the production runtime.
 */

export type OpenAiConversationInitializationItem = {
  type: "message";
  role: "developer";
  content: string;
};

export type OpenAiConversationInitializationBody = {
  items: OpenAiConversationInitializationItem[];
};

export type OpenAiConversationInitializationOptions = {
  maxRetries: 0;
};

export type OpenAiConversationInitializationClient = {
  conversations: {
    create(
      body: OpenAiConversationInitializationBody,
      options: OpenAiConversationInitializationOptions,
    ): Promise<{ readonly id: string }>;
  };
};

/**
 * Adapts one official SDK client into the initialization seam.
 * Call this once per shared client, not once per initialization request.
 */
export function openAiConversationInitializationClient(
  client: Pick<OpenAI, "conversations">,
): OpenAiConversationInitializationClient {
  return {
    conversations: {
      create(body, options) {
        return client.conversations.create(body, options);
      },
    },
  };
}

function developerMessage(content: string): OpenAiConversationInitializationItem {
  return { type: "message", role: "developer", content };
}

function initializationItems(
  request: ProviderReadyRimConversationInitializationRequest,
): OpenAiConversationInitializationItem[] {
  return [
    developerMessage(request.rimPrompt.text),
    developerMessage(request.productSemantics.text),
    developerMessage(canonicalJson({ relationshipContext: request.relationshipContext })),
    developerMessage(canonicalJson({ origin: request.origin })),
  ];
}

export class OpenAiConversationInitializer implements RimConversationInitializationPort {
  constructor(private readonly client: OpenAiConversationInitializationClient) {}

  async initialize(
    request: RimConversationInitializationRequest,
  ): Promise<RimConversationInitializationResult> {
    const ready = assertProviderReadyInitialization(request);
    // Metadata and idempotency are omitted. A lost create is not searched or retried.
    const conversation = await this.client.conversations.create(
      { items: initializationItems(ready) },
      { maxRetries: OPENAI_CLIENT_MAX_RETRIES },
    );
    return { conversationId: conversation.id as ProviderConversationId };
  }
}
