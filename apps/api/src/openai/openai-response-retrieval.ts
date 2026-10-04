import type { OpenAI } from "openai";
import {
  type ProviderResponseId,
  type RetrievedProviderStatus,
  type RimProviderRetrieval,
  type RimProviderRetrievalPort,
} from "@98plus/application";
import { OPENAI_CLIENT_MAX_RETRIES } from "./openai-client.ts";
import { extractRimCandidateFromCompletedText } from "./rim-completed-output.ts";

/**
 * OpenAI Responses retrieval for one already-known response id.
 * One shared client is reused. One call performs one GET. This transport
 * does not generate, poll, initialize a Conversation, or select the runtime.
 */

const RETRIEVED_PROVIDER_STATUSES = [
  "queued",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "incomplete",
] as const satisfies readonly RetrievedProviderStatus[];

export type OpenAiRetrievedResponse = {
  readonly id?: string;
  readonly status?: string;
  readonly output_text?: string;
};

export type OpenAiRetrievalClient = {
  responses: {
    retrieve(responseId: string, options: { maxRetries: 0 }): Promise<OpenAiRetrievedResponse>;
  };
};

/**
 * Adapts one official SDK client into the retrieval seam.
 * Call this once per shared client, not once per retrieval.
 */
export function openAiRetrievalClient(client: Pick<OpenAI, "responses">): OpenAiRetrievalClient {
  return {
    responses: {
      retrieve(responseId, options) {
        return client.responses.retrieve(responseId, options);
      },
    },
  };
}

function knownStatus(status: string | undefined): RetrievedProviderStatus | null {
  if (status !== undefined && (RETRIEVED_PROVIDER_STATUSES as readonly string[]).includes(status)) {
    return status as RetrievedProviderStatus;
  }
  return null;
}

function retrievalOf(
  responseId: ProviderResponseId,
  response: OpenAiRetrievedResponse,
): RimProviderRetrieval | null {
  if (response.id !== responseId) {
    return null;
  }
  const providerStatus = knownStatus(response.status);
  if (!providerStatus) {
    return null;
  }
  if (providerStatus === "completed") {
    return {
      responseId,
      providerStatus,
      output: extractRimCandidateFromCompletedText(response.output_text),
    };
  }
  return { responseId, providerStatus };
}

export class OpenAiResponseRetriever implements RimProviderRetrievalPort {
  constructor(private readonly client: OpenAiRetrievalClient) {}

  async retrieve(responseId: ProviderResponseId): Promise<RimProviderRetrieval | null> {
    const response = await this.client.responses.retrieve(responseId, {
      maxRetries: OPENAI_CLIENT_MAX_RETRIES,
    });
    return retrievalOf(responseId, response);
  }
}
