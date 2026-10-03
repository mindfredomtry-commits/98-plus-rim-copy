import type {
  AiRequestId,
  AskRimOrigin,
  ContextRequestId,
  RelationshipContextData,
  RimAiResult,
  RimChatId,
  RimMessage,
  RimSuggestion,
} from "@98plus/product-model";
import type { ProductSemanticsInput, RimPromptInput } from "./rim-conversation-port.ts";
import type { ProviderConversationId, ProviderResponseId } from "./rim-provider-runtime.ts";

/**
 * USER-turn continuation of one already stored Conversation.
 * Not a Product entity and not a second initialization.
 * RIM Prompt and Product Semantics are not on this request.
 * `conversationId` is the stored id for this exact RimChat.
 * The stored RelationshipContext and applicable origin stay visible for
 * Application correlation. A provider continuation sends only the new USER message.
 */
export type ProviderRimAiRequest = Readonly<{
  continuityMode: "provider-conversation";
  requestId: AiRequestId;
  rimChatId: RimChatId;
  conversationId: ProviderConversationId;
  userMessage: string;
  contextRequestId: ContextRequestId;
  relationshipContext: RelationshipContextData;
  messages: readonly RimMessage[];
  /** Valid Ask RIM conversational origin. Null for an ordinary RIM Chat. */
  conversationalOrigin: AskRimOrigin | null;
}>;

/**
 * One committed RIM Chat turn projected for stateless local execution.
 * BAN_PROPOSALS keeps the AI semantic content and drops Application proposalId.
 */
export type LocalCanonicalHistoryEntry =
  | { readonly kind: "USER"; readonly text: string }
  | { readonly kind: "RIM"; readonly text: string }
  | {
      readonly kind: "BAN_PROPOSALS";
      readonly message: string;
      readonly proposals: readonly RimSuggestion[];
    };

/**
 * Stateless USER-turn execution from Application-owned canonical facts.
 * There is no conversationId. The retired provider Conversation is not an input.
 * `canonicalHistory` is the complete model-facing semantic history. E-52 has
 * already appended the current USER turn, so that history contains it once.
 * This request has no second user-message field to serialize.
 * Prompt and semantics may still be unavailable placeholders. A real provider
 * transport must reject those through `assertProviderReadySemantics`.
 */
export type LocalRimAiRequest = Readonly<{
  continuityMode: "local-canonical-history";
  requestId: AiRequestId;
  rimChatId: RimChatId;
  contextRequestId: ContextRequestId;
  relationshipContext: RelationshipContextData;
  conversationalOrigin: AskRimOrigin | null;
  rimPrompt: RimPromptInput;
  productSemantics: ProductSemanticsInput;
  canonicalHistory: readonly LocalCanonicalHistoryEntry[];
}>;

export type RimAiRequest = ProviderRimAiRequest | LocalRimAiRequest;

/**
 * The only semantic history a local model call may send.
 * It already includes the current USER turn. Callers must not append another.
 */
export function localModelFacingHistory(
  request: LocalRimAiRequest,
): readonly LocalCanonicalHistoryEntry[] {
  return request.canonicalHistory;
}

/** Projects committed Product messages. It does not append the current USER again. */
export function projectLocalCanonicalHistory(
  messages: readonly RimMessage[],
): readonly LocalCanonicalHistoryEntry[] {
  return messages.map((message): LocalCanonicalHistoryEntry => {
    if (message.kind === "USER") {
      return { kind: "USER", text: message.text };
    }
    if (message.kind === "RIM") {
      return { kind: "RIM", text: message.text };
    }
    return {
      kind: "BAN_PROPOSALS",
      message: message.message,
      proposals: message.proposals.map((proposal) => ({
        banText: proposal.banText,
        executionProbability: proposal.executionProbability,
      })),
    };
  });
}

/**
 * Result of one durable Response-id observation.
 * `accepted` means the id is stored on this technical attempt.
 * A refusal does not erase an id that was already stored.
 */
export type RimResponseCreatedObservation =
  { readonly accepted: true } | { readonly accepted: false };

/**
 * Provider-neutral lifecycle for one USER attempt.
 * `onResponseCreated` reports a stable Response id before semantic completion.
 * The promise settles only after the durable CAS has been decided.
 * This is not a Conversation id and not an OpenAI SDK type.
 */
export type RimAiResponseObserver = Readonly<{
  onResponseCreated(responseId: ProviderResponseId): Promise<RimResponseCreatedObservation>;
}>;

export type RimAiPort = {
  respond(request: RimAiRequest, observer: RimAiResponseObserver): Promise<RimAiResult>;
};
