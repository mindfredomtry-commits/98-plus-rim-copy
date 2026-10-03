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
import type { ProviderConversationId } from "./rim-provider-runtime.ts";

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
 * `canonicalHistory` already contains the current USER turn when E-52 appended it.
 * `userMessage` is the same turn at the port boundary and is not a second copy.
 * Prompt and semantics may still be unavailable placeholders. A real provider
 * transport must reject those through `assertProviderReadySemantics`.
 */
export type LocalRimAiRequest = Readonly<{
  continuityMode: "local-canonical-history";
  requestId: AiRequestId;
  rimChatId: RimChatId;
  userMessage: string;
  contextRequestId: ContextRequestId;
  relationshipContext: RelationshipContextData;
  conversationalOrigin: AskRimOrigin | null;
  rimPrompt: RimPromptInput;
  productSemantics: ProductSemanticsInput;
  canonicalHistory: readonly LocalCanonicalHistoryEntry[];
}>;

export type RimAiRequest = ProviderRimAiRequest | LocalRimAiRequest;

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

export type RimAiPort = {
  respond(request: RimAiRequest): Promise<RimAiResult>;
};
