import type {
  ExecutionProbability,
  Failure,
  RimAiResult,
  ThreeSuggestions,
} from "@98plus/product-model";
import type {
  RimConversationInitializationPort,
  RimConversationInitializationRequest,
  RimConversationInitializationResult,
} from "./rim-conversation-port.ts";
import type { ProviderConversationId, ProviderResponseId } from "./rim-provider-runtime.ts";
import type { RimAiPort, RimAiRequest, RimAiResponseObserver } from "./rim-ai-port.ts";

export class FakeRimAiFailure extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    super("RIM_AI_FAILED");
    this.name = "FakeRimAiFailure";
    this.failure = failure;
  }
}

export type FakeRimAiStep =
  | { readonly kind: "MESSAGE"; readonly text: string; readonly responseId?: string }
  | {
      readonly kind: "BAN_PROPOSALS";
      readonly message: string;
      readonly proposals: ThreeSuggestions;
      readonly responseId?: string;
    }
  | { readonly kind: "FAILURE"; readonly failure: Failure; readonly responseId?: string };

/**
 * One Conversation create. There is no hidden retry.
 * SUCCESS and LOST are terminal for that call. HOLD waits, then succeeds or loses.
 */
export type FakeConversationInitStep =
  | { readonly kind: "SUCCESS"; readonly conversationId?: string }
  | { readonly kind: "LOST"; readonly message?: string }
  | {
      readonly kind: "HOLD";
      readonly gate: Promise<void>;
      readonly onEntered?: () => void;
      readonly then?: "SUCCESS" | "LOST";
      readonly conversationId?: string;
      readonly message?: string;
    };

const DEFAULT_PROPOSALS: ThreeSuggestions = [
  { banText: "не обсуждать работу", executionProbability: 0.2 as ExecutionProbability },
  { banText: "не опаздывать", executionProbability: 0.5 as ExecutionProbability },
  { banText: "не повышать голос", executionProbability: 0.8 as ExecutionProbability },
];

function stepToResult(step: FakeRimAiStep): RimAiResult {
  if (step.kind === "FAILURE") {
    throw new FakeRimAiFailure(step.failure);
  }
  if (step.kind === "MESSAGE") {
    return { kind: "MESSAGE", text: step.text };
  }
  return { kind: "BAN_PROPOSALS", message: step.message, proposals: step.proposals };
}

/**
 * Deterministic provider stand-in.
 * `respond` is a USER turn. `initialize` is a separate Conversation create.
 * A scripted step is one technical call. It does not retry, mint proposalId, or touch Product state.
 */
export class FakeRimAiAdapter implements RimAiPort, RimConversationInitializationPort {
  private index = 0;
  private conversationIndex = 0;
  readonly initializationRequests: RimConversationInitializationRequest[] = [];

  constructor(
    private readonly steps: readonly FakeRimAiStep[] = [],
    private readonly conversationSteps: readonly FakeConversationInitStep[] = [],
  ) {}

  async initialize(
    request: RimConversationInitializationRequest,
  ): Promise<RimConversationInitializationResult> {
    this.initializationRequests.push(request);
    const step = this.conversationSteps[this.conversationIndex];
    if (step) {
      this.conversationIndex += 1;
    }
    if (!step || step.kind === "SUCCESS") {
      return {
        conversationId: conversationIdOf(
          request,
          step?.kind === "SUCCESS" ? step.conversationId : undefined,
        ),
      };
    }
    if (step.kind === "LOST") {
      throw new Error(step.message ?? "conversation create acceptance unknown");
    }
    step.onEntered?.();
    await step.gate;
    if (step.then === "LOST") {
      throw new Error(step.message ?? "conversation create acceptance unknown");
    }
    return { conversationId: conversationIdOf(request, step.conversationId) };
  }

  async respond(request: RimAiRequest, observer?: RimAiResponseObserver): Promise<RimAiResult> {
    const scripted = this.steps[this.index];
    if (scripted) {
      this.index += 1;
      if (scripted.responseId && observer) {
        await observer.onResponseCreated(scripted.responseId as ProviderResponseId);
      }
      return stepToResult(scripted);
    }
    const userText = scriptedUserText(request);
    if (userText.toLowerCase().includes("предложи")) {
      return {
        kind: "BAN_PROPOSALS",
        message: "три запрета",
        proposals: DEFAULT_PROPOSALS,
      };
    }
    return { kind: "MESSAGE", text: userText };
  }
}

/**
 * Fake echo text. A local request has no separate user message: the current
 * USER turn is the last USER entry already inside canonical history.
 */
function scriptedUserText(request: RimAiRequest): string {
  if (request.continuityMode === "provider-conversation") {
    return request.userMessage;
  }
  for (let index = request.canonicalHistory.length - 1; index >= 0; index -= 1) {
    const entry = request.canonicalHistory[index];
    if (entry?.kind === "USER") {
      return entry.text;
    }
  }
  return "";
}

function conversationIdOf(
  request: RimConversationInitializationRequest,
  explicit: string | undefined,
): ProviderConversationId {
  return (explicit ?? `fake-conversation-${request.attemptId}`) as ProviderConversationId;
}
