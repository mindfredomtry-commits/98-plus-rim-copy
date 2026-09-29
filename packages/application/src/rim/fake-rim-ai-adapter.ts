import type {
  ExecutionProbability,
  Failure,
  RimAiResult,
  ThreeSuggestions,
} from "@98plus/product-model";
import type { RimAiPort, RimAiRequest } from "./rim-ai-port.ts";

export class FakeRimAiFailure extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    super("RIM_AI_FAILED");
    this.name = "FakeRimAiFailure";
    this.failure = failure;
  }
}

export type FakeRimAiStep =
  | { readonly kind: "MESSAGE"; readonly text: string }
  | {
      readonly kind: "BAN_PROPOSALS";
      readonly message: string;
      readonly proposals: ThreeSuggestions;
    }
  | { readonly kind: "FAILURE"; readonly failure: Failure };

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
 * Deterministic provider stand-in. It sees only RimAiRequest and returns RimAiResult.
 * A scripted step is one technical call. It does not mint proposalId or touch Product state.
 */
export class FakeRimAiAdapter implements RimAiPort {
  private index = 0;

  constructor(private readonly steps: readonly FakeRimAiStep[] = []) {}

  async respond(request: RimAiRequest): Promise<RimAiResult> {
    const scripted = this.steps[this.index];
    if (scripted) {
      this.index += 1;
      return stepToResult(scripted);
    }
    if (request.userMessage.toLowerCase().includes("предложи")) {
      return {
        kind: "BAN_PROPOSALS",
        message: "три запрета",
        proposals: DEFAULT_PROPOSALS,
      };
    }
    return { kind: "MESSAGE", text: request.userMessage };
  }
}
