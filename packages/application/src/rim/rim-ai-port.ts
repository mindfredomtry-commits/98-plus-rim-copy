import type {
  AiRequestId,
  AskRimOrigin,
  ContextRequestId,
  RelationshipContextData,
  RimAiResult,
  RimChatId,
  RimMessage,
} from "@98plus/product-model";

/**
 * Provider request at the AI port. Not a Product entity and not a RimRequestSnapshot.
 * RimRequestSnapshot stays requestId, rimChatId, userMessage, contextRequestId.
 */
export type RimAiRequest = Readonly<{
  requestId: AiRequestId;
  rimChatId: RimChatId;
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
