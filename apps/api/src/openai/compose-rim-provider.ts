import type { OpenAI } from "openai";
import {
  FakeRimAiAdapter,
  type RimAiPort,
  type RimConversationInitializationPort,
  type RimProviderRetrievalPort,
} from "@98plus/application";
import { createOpenAiClient } from "./openai-client.ts";
import {
  openAiConversationInitializationClient,
  OpenAiConversationInitializer,
} from "./openai-conversation-initialization.ts";
import { openAiGenerationClient, OpenAiResponseGenerator } from "./openai-response-generation.ts";
import { openAiRetrievalClient, OpenAiResponseRetriever } from "./openai-response-retrieval.ts";
import { loadRimProviderConfig } from "./rim-provider-config.ts";

/**
 * Server-side RIM provider selection.
 * Fake mode constructs no OpenAI client. OpenAI mode builds one shared client
 * and all three provider ports, or fails before a runtime is returned.
 * The API key stays inside that client and is not part of this result.
 */

export type OpenAiSdkClient = Pick<OpenAI, "conversations" | "responses">;

export type RimProviderSelection = Readonly<{
  provider: "fake" | "openai";
  model: string | null;
  rimAi: RimAiPort;
  rimConversationInitialization: RimConversationInitializationPort | null;
  rimProviderRetrieval: RimProviderRetrievalPort | null;
}>;

export type SelectRimProviderInput = Readonly<{
  env?: NodeJS.ProcessEnv;
  createClient?: (apiKey: string) => OpenAiSdkClient;
}>;

function fakeSelection(): RimProviderSelection {
  return {
    provider: "fake",
    model: null,
    rimAi: new FakeRimAiAdapter(),
    rimConversationInitialization: null,
    rimProviderRetrieval: null,
  };
}

/**
 * Resolve provider ports from an explicit env object.
 * Omitted env stays Fake and does not read process.env, so tests and the
 * default HTTP runtime do not construct a client from ambient configuration.
 * Startup passes the process env once.
 */
export function selectRimProvider(input: SelectRimProviderInput = {}): RimProviderSelection {
  if (input.env === undefined) {
    return fakeSelection();
  }
  const config = loadRimProviderConfig(input.env);
  if (config.provider === "fake") {
    return fakeSelection();
  }
  const createClient = input.createClient ?? ((apiKey: string) => createOpenAiClient(apiKey));
  const client = createClient(config.apiKey);
  return {
    provider: "openai",
    model: config.model,
    rimAi: new OpenAiResponseGenerator(openAiGenerationClient(client), config.model),
    rimConversationInitialization: new OpenAiConversationInitializer(
      openAiConversationInitializationClient(client),
    ),
    rimProviderRetrieval: new OpenAiResponseRetriever(openAiRetrievalClient(client)),
  };
}
