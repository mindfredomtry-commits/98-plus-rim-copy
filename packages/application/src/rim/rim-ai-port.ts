import type {
  AiRequestId,
  AskRimOrigin,
  ContextRequestId,
  RelationshipContextData,
  RimAiResult,
  RimChatId,
  RimMessage,
} from "@98plus/product-model";
import type { ProviderConversationId } from "./rim-provider-runtime.ts";

/**
 * USER-turn continuation of one already stored Conversation.
 * Not a Product entity and not a second initialization.
 * RIM Prompt and Product Semantics are not on this request.
 * `conversationId` is the stored id for this exact RimChat.
 * The stored RelationshipContext and applicable origin stay visible for
 * Application correlation. A provider continuation sends only the new USER message.
 */
export type RimAiRequest = Readonly<{
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

export type RimAiPort = {
  respond(request: RimAiRequest): Promise<RimAiResult>;
};
