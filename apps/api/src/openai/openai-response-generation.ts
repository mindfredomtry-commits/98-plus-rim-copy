import type { OpenAI } from "openai";
import type { RimAiResult } from "@98plus/product-model";
import {
  assertProviderReadySemantics,
  localModelFacingHistory,
  providerModelFacingTurn,
  type LocalCanonicalHistoryEntry,
  type ProviderResponseId,
  type RimAiPort,
  type RimAiRequest,
  type RimAiResponseObserver,
} from "@98plus/application";
import { canonicalJson } from "./canonical-json.ts";
import { OPENAI_CLIENT_MAX_RETRIES } from "./openai-client.ts";
import { RIM_OUTPUT_FORMAT } from "./rim-output-format.ts";

/**
 * OpenAI Responses generation for one USER attempt.
 * One shared client is reused. Streaming exists so response.id can be observed
 * before the completed body. This transport does not retrieve, retry, or
 * select the production runtime.
 */

export class OpenAiGenerationTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiGenerationTransportError";
  }
}

export type OpenAiGenerationInputItem = {
  type: "message";
  role: "developer" | "user" | "assistant";
  content: string;
};

export type OpenAiGenerationBody = {
  model: string;
  input: string | OpenAiGenerationInputItem[];
  store: true;
  stream: true;
  text: { format: typeof RIM_OUTPUT_FORMAT };
  conversation?: string;
};

export type OpenAiGenerationEvent = {
  type: string;
  message?: string;
  delta?: string;
  text?: string;
  response?: {
    id?: string;
    output_text?: string;
    status?: string;
    error?: { message?: string } | null;
  };
};

export type OpenAiGenerationStream = AsyncIterable<OpenAiGenerationEvent> & {
  readonly controller?: { abort: () => void };
};

export type OpenAiGenerationClient = {
  responses: {
    create(body: OpenAiGenerationBody, options: { maxRetries: 0 }): Promise<OpenAiGenerationStream>;
  };
};

/** Keeps only the string fields this transport reads from one SDK stream event. */
function generationEvent(event: { readonly type: string }): OpenAiGenerationEvent {
  const record = event as {
    message?: unknown;
    delta?: unknown;
    text?: unknown;
    response?: {
      id?: unknown;
      output_text?: unknown;
      status?: unknown;
      error?: { message?: unknown } | null;
    };
  };
  const response = record.response;
  const projected: OpenAiGenerationEvent = { type: event.type };
  if (typeof record.message === "string") {
    projected.message = record.message;
  }
  if (typeof record.delta === "string") {
    projected.delta = record.delta;
  }
  if (typeof record.text === "string") {
    projected.text = record.text;
  }
  if (response) {
    const errorMessage = response.error?.message;
    projected.response = {
      ...(typeof response.id === "string" ? { id: response.id } : {}),
      ...(typeof response.output_text === "string" ? { output_text: response.output_text } : {}),
      ...(typeof response.status === "string" ? { status: response.status } : {}),
      ...(typeof errorMessage === "string" ? { error: { message: errorMessage } } : {}),
    };
  }
  return projected;
}

/**
 * Adapts one official SDK client into the generation seam.
 * Call this once per shared client, not once per USER attempt.
 */
export function openAiGenerationClient(client: Pick<OpenAI, "responses">): OpenAiGenerationClient {
  return {
    responses: {
      async create(body, options) {
        const stream = await client.responses.create(body, options);
        return {
          controller: stream.controller,
          async *[Symbol.asyncIterator]() {
            for await (const event of stream) {
              yield generationEvent(event);
            }
          },
        };
      },
    },
  };
}

function developerMessage(content: string): OpenAiGenerationInputItem {
  return { type: "message", role: "developer", content };
}

function historyItem(entry: LocalCanonicalHistoryEntry): OpenAiGenerationInputItem {
  if (entry.kind === "USER") {
    return { type: "message", role: "user", content: entry.text };
  }
  if (entry.kind === "RIM") {
    return { type: "message", role: "assistant", content: entry.text };
  }
  return {
    type: "message",
    role: "assistant",
    content: canonicalJson({
      type: "BAN_PROPOSALS",
      message: entry.message,
      proposals: entry.proposals.map((proposal) => ({
        banText: proposal.banText,
        executionProbability: proposal.executionProbability,
      })),
    }),
  };
}

function generationBody(model: string, request: RimAiRequest): OpenAiGenerationBody {
  const format = { format: RIM_OUTPUT_FORMAT } as const;
  if (request.continuityMode === "provider-conversation") {
    const turn = providerModelFacingTurn(request);
    return {
      model,
      conversation: turn.conversationId,
      input: turn.userMessage,
      store: true,
      stream: true,
      text: format,
    };
  }
  const ready = assertProviderReadySemantics(request);
  const history = localModelFacingHistory(request);
  return {
    model,
    input: [
      developerMessage(ready.rimPrompt.text),
      developerMessage(ready.productSemantics.text),
      developerMessage(canonicalJson({ relationshipContext: request.relationshipContext })),
      developerMessage(canonicalJson({ origin: request.conversationalOrigin })),
      ...history.map(historyItem),
    ],
    store: true,
    stream: true,
    text: format,
  };
}

function responseIdOf(event: OpenAiGenerationEvent): string | null {
  const id = event.response?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function terminalFailure(event: OpenAiGenerationEvent): OpenAiGenerationTransportError | null {
  if (event.type === "response.failed") {
    return new OpenAiGenerationTransportError(failureText("failed", event));
  }
  if (event.type === "response.incomplete") {
    const kind = event.response?.status === "cancelled" ? "cancelled" : "incomplete";
    return new OpenAiGenerationTransportError(failureText(kind, event));
  }
  if (event.type === "response.cancelled" || event.type === "response.canceled") {
    return new OpenAiGenerationTransportError(failureText("cancelled", event));
  }
  if (event.type === "error") {
    const detail = typeof event.message === "string" ? event.message : "error";
    return new OpenAiGenerationTransportError(`OpenAI response error: ${detail}`);
  }
  return null;
}

function failureText(kind: string, event: OpenAiGenerationEvent): string {
  const detail = event.response?.error?.message;
  return typeof detail === "string" && detail.length > 0
    ? `OpenAI response ${kind}: ${detail}`
    : `OpenAI response ${kind}`;
}

function unwrapCompletedOutput(event: OpenAiGenerationEvent): unknown {
  const text = event.response?.output_text;
  if (typeof text !== "string") {
    return text ?? null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "output" in parsed
    ) {
      return parsed.output;
    }
    return text;
  } catch {
    return text;
  }
}

function stop(stream: OpenAiGenerationStream, error: OpenAiGenerationTransportError): never {
  stream.controller?.abort();
  throw error;
}

async function consumeGeneration(
  stream: OpenAiGenerationStream,
  observer: RimAiResponseObserver,
): Promise<unknown> {
  let knownResponseId: string | null = null;
  let accepted = false;
  for await (const event of stream) {
    if (event.type === "response.created") {
      const responseId = responseIdOf(event);
      if (!responseId) {
        stop(
          stream,
          new OpenAiGenerationTransportError("OpenAI response.created had no response id"),
        );
      }
      if (knownResponseId === null) {
        knownResponseId = responseId;
        let observation: Awaited<ReturnType<RimAiResponseObserver["onResponseCreated"]>>;
        try {
          observation = await observer.onResponseCreated(responseId as ProviderResponseId);
        } catch (error) {
          stream.controller?.abort();
          throw error;
        }
        if (!observation.accepted) {
          stop(stream, new OpenAiGenerationTransportError("OpenAI response id was not accepted"));
        }
        accepted = true;
        continue;
      }
      if (responseId !== knownResponseId) {
        stop(stream, new OpenAiGenerationTransportError("OpenAI response id conflict"));
      }
      continue;
    }
    if (event.type === "response.output_text.delta" || event.type === "response.output_text.done") {
      continue;
    }
    const failed = terminalFailure(event);
    if (failed) {
      stop(stream, failed);
    }
    if (event.type === "response.completed") {
      const status = event.response?.status;
      if (status === "failed" || status === "cancelled" || status === "incomplete") {
        stop(stream, new OpenAiGenerationTransportError(failureText(status, event)));
      }
      if (!accepted) {
        stop(
          stream,
          new OpenAiGenerationTransportError(
            "OpenAI response completed before response id was accepted",
          ),
        );
      }
      return unwrapCompletedOutput(event);
    }
  }
  throw new OpenAiGenerationTransportError("OpenAI response stream ended before completion");
}

export class OpenAiResponseGenerator implements RimAiPort {
  constructor(
    private readonly client: OpenAiGenerationClient,
    private readonly model: string,
  ) {
    if (model.trim() === "") {
      throw new Error("OpenAI generation requires a model");
    }
  }

  async respond(request: RimAiRequest, observer: RimAiResponseObserver): Promise<RimAiResult> {
    const stream = await this.client.responses.create(generationBody(this.model, request), {
      maxRetries: OPENAI_CLIENT_MAX_RETRIES,
    });
    return (await consumeGeneration(stream, observer)) as RimAiResult;
  }
}
