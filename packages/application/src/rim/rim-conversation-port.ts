import type {
  AskRimOrigin,
  ContextRequestId,
  RelationshipContextData,
  RimChatId,
  UserId,
} from "@98plus/product-model";
import type { ProviderConversationId, RimProviderAttemptId } from "./rim-provider-runtime.ts";
import { PRODUCT_SEMANTICS_MVP15_TEXT } from "./semantics/product-semantics-mvp15.ts";
import { RIM_PROMPT_V1_TEXT } from "./semantics/rim-prompt-v1.ts";

const semanticAuthority: unique symbol = Symbol("98plus.rim.semantic-authority");

/** Semantic artifact explicitly not loaded. It has no canonical text. */
export type UnavailableSemanticArtifact = Readonly<{
  readonly availability: "unavailable";
}>;

/**
 * Provider-ready semantic artifact.
 * Only the two approved singletons in this module carry the brand.
 * An unavailable placeholder cannot satisfy it.
 */
export type ProviderReadySemanticArtifact<Kind extends string> = Readonly<{
  readonly availability: "available";
  readonly kind: Kind;
  readonly text: string;
  readonly [semanticAuthority]: Kind;
}>;

export type RimPromptInput =
  UnavailableSemanticArtifact | ProviderReadySemanticArtifact<"rim-prompt">;

export type ProductSemanticsInput =
  UnavailableSemanticArtifact | ProviderReadySemanticArtifact<"product-semantics">;

/**
 * Negative fixture. Production initialization and local history never return it.
 */
export const RIM_PROMPT_UNAVAILABLE: RimPromptInput = { availability: "unavailable" };

/**
 * Negative fixture. Production initialization and local history never return it.
 */
export const PRODUCT_SEMANTICS_UNAVAILABLE: ProductSemanticsInput = {
  availability: "unavailable",
};

/** Approved RIM Prompt. The only provider-ready prompt artifact. */
export const RIM_PROMPT_V1: ProviderReadySemanticArtifact<"rim-prompt"> = {
  availability: "available",
  kind: "rim-prompt",
  text: RIM_PROMPT_V1_TEXT,
  [semanticAuthority]: "rim-prompt",
};

/** Approved Product Semantics. The only provider-ready semantics artifact. */
export const PRODUCT_SEMANTICS_MVP15: ProviderReadySemanticArtifact<"product-semantics"> = {
  availability: "available",
  kind: "product-semantics",
  text: PRODUCT_SEMANTICS_MVP15_TEXT,
  [semanticAuthority]: "product-semantics",
};

Object.freeze(RIM_PROMPT_V1);
Object.freeze(PRODUCT_SEMANTICS_MVP15);

/**
 * The production semantic bundle.
 * It accepts no caller text. Readiness means these two approved artifacts.
 */
export function providerReadySemanticInputs(): ProviderReadySemanticInputs {
  return {
    rimPrompt: RIM_PROMPT_V1,
    productSemantics: PRODUCT_SEMANTICS_MVP15,
  };
}

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

function isApprovedRimPrompt(
  value: RimPromptInput,
): value is ProviderReadySemanticArtifact<"rim-prompt"> {
  return value === RIM_PROMPT_V1;
}

function isApprovedProductSemantics(
  value: ProductSemanticsInput,
): value is ProviderReadySemanticArtifact<"product-semantics"> {
  return value === PRODUCT_SEMANTICS_MVP15;
}

/**
 * Refuses a Conversation create that is not the approved semantic pair.
 * A provider transport must use this before building a provider request.
 * The lifecycle fake records the request and does not supply semantic text.
 */
export function assertProviderReadyInitialization(
  request: RimConversationInitializationRequest,
): ProviderReadyRimConversationInitializationRequest {
  if (
    !isApprovedRimPrompt(request.rimPrompt) ||
    !isApprovedProductSemantics(request.productSemantics)
  ) {
    throw new Error("RIM initialization semantic inputs are not provider-ready");
  }
  return {
    ...request,
    rimPrompt: request.rimPrompt,
    productSemantics: request.productSemantics,
  };
}

export type ProviderReadySemanticInputs = Readonly<{
  rimPrompt: ProviderReadySemanticArtifact<"rim-prompt">;
  productSemantics: ProviderReadySemanticArtifact<"product-semantics">;
}>;

/**
 * Refuses local canonical execution that is not the approved semantic pair.
 * A future provider transport must use this before building a stateless request.
 * The lifecycle fake records the request and does not supply semantic text.
 */
export function assertProviderReadySemantics(input: {
  rimPrompt: RimPromptInput;
  productSemantics: ProductSemanticsInput;
}): ProviderReadySemanticInputs {
  if (
    !isApprovedRimPrompt(input.rimPrompt) ||
    !isApprovedProductSemantics(input.productSemantics)
  ) {
    throw new Error("RIM local semantic inputs are not provider-ready");
  }
  return {
    rimPrompt: input.rimPrompt,
    productSemantics: input.productSemantics,
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
