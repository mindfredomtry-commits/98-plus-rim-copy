import type {
  AskRimOrigin,
  ContextRequestId,
  RelationshipContextData,
  RimChatId,
  UserId,
} from "@98plus/product-model";
import type { ProviderConversationId, RimProviderAttemptId } from "./rim-provider-runtime.ts";

declare const semanticAuthority: unique symbol;

/** Semantic artifact explicitly not loaded. It has no canonical text. */
export type UnavailableSemanticArtifact = Readonly<{
  readonly availability: "unavailable";
}>;

/**
 * Provider-ready semantic artifact.
 * Nothing in this module mints one. An unavailable placeholder cannot satisfy it.
 */
export type ProviderReadySemanticArtifact<Kind extends string> = Readonly<{
  readonly availability: "available";
  readonly kind: Kind;
  readonly [semanticAuthority]: Kind;
}>;

export type RimPromptInput =
  UnavailableSemanticArtifact | ProviderReadySemanticArtifact<"rim-prompt">;

export type ProductSemanticsInput =
  UnavailableSemanticArtifact | ProviderReadySemanticArtifact<"product-semantics">;

export const RIM_PROMPT_UNAVAILABLE: RimPromptInput = { availability: "unavailable" };

export const PRODUCT_SEMANTICS_UNAVAILABLE: ProductSemanticsInput = {
  availability: "unavailable",
};

/**
 * Provider-independent Conversation create.
 * Distinct from a USER-turn `RimAiPort.respond` call.
 * The four semantic inputs stay separate from the correlation fields.
 */
export type RimConversationInitializationRequest = Readonly<{
  rimChatId: RimChatId;
  selectedContactId: UserId;
  contextRequestId: ContextRequestId;
  attemptId: RimProviderAttemptId;
  clientRequestId: string | null;
  rimPrompt: RimPromptInput;
  productSemantics: ProductSemanticsInput;
  relationshipContext: RelationshipContextData;
  origin: AskRimOrigin | null;
}>;

/** Initialization request whose prompt and semantics are provider-ready artifacts. */
export type ProviderReadyRimConversationInitializationRequest = Omit<
  RimConversationInitializationRequest,
  "rimPrompt" | "productSemantics"
> &
  Readonly<{
    rimPrompt: ProviderReadySemanticArtifact<"rim-prompt">;
    productSemantics: ProviderReadySemanticArtifact<"product-semantics">;
  }>;

function isProviderReadyArtifact<Kind extends string>(
  value: UnavailableSemanticArtifact | ProviderReadySemanticArtifact<Kind>,
  kind: Kind,
): value is ProviderReadySemanticArtifact<Kind> {
  if (value.availability !== "available") {
    return false;
  }
  return value.kind === kind && value[semanticAuthority] === kind;
}

/**
 * Refuses a Conversation create whose prompt or semantics are still unavailable.
 * A provider transport must use this before building a provider request.
 * The lifecycle fake does not, because no provider-ready artifacts are minted.
 */
export function assertProviderReadyInitialization(
  request: RimConversationInitializationRequest,
): ProviderReadyRimConversationInitializationRequest {
  if (
    !isProviderReadyArtifact(request.rimPrompt, "rim-prompt") ||
    !isProviderReadyArtifact(request.productSemantics, "product-semantics")
  ) {
    throw new Error("RIM initialization semantic inputs are not provider-ready");
  }
  return {
    ...request,
    rimPrompt: request.rimPrompt,
    productSemantics: request.productSemantics,
  };
}

export type RimConversationInitializationResult = Readonly<{
  conversationId: ProviderConversationId;
}>;

/** Creates one provider Conversation. It must not continue a USER turn. */
export type RimConversationInitializationPort = {
  initialize(
    request: RimConversationInitializationRequest,
  ): Promise<RimConversationInitializationResult>;
};

/**
 * Deterministic lifecycle stand-in used when a caller has no initializer.
 * One call returns one id. It does not retry, does not read semantic artifacts,
 * and is not a provider transport.
 */
export const defaultRimConversationInitializer: RimConversationInitializationPort = {
  async initialize(request) {
    return {
      conversationId: `fake-conversation-${request.attemptId}` as ProviderConversationId,
    };
  },
};

export function conversationPortFrom(
  rimAi: object,
  explicit?: RimConversationInitializationPort,
): RimConversationInitializationPort {
  if (explicit) {
    return explicit;
  }
  if (
    "initialize" in rimAi &&
    typeof (rimAi as { initialize?: unknown }).initialize === "function"
  ) {
    return rimAi as RimConversationInitializationPort;
  }
  return defaultRimConversationInitializer;
}
