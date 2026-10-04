import { OpenAI } from "openai";

/**
 * Official SDK client factory for a future RIM adapter.
 *
 * Construction does not call the OpenAI API. Automatic SDK retries are
 * disabled here so later provider calls cannot inherit the SDK default of 2.
 * Timeout is left unset so the SDK network default stays an SDK concern.
 */

/** Client-level retry ceiling. Do not rely on the SDK default. */
export const OPENAI_CLIENT_MAX_RETRIES = 0;

export type OpenAiClientConstruction = Readonly<{
  apiKey: string;
  maxRetries: typeof OPENAI_CLIENT_MAX_RETRIES;
}>;

/** Options passed to `new OpenAI(...)`. No timeout, organization, or project. */
export function openAiClientConstruction(apiKey: string): OpenAiClientConstruction {
  return {
    apiKey,
    maxRetries: OPENAI_CLIENT_MAX_RETRIES,
  };
}

export type OpenAiClientConstructor = new (options: OpenAiClientConstruction) => OpenAI;

/**
 * `new OpenAI({ apiKey, maxRetries: 0 })`.
 * The constructor argument exists so tests can observe the construction
 * without a network call. Production code uses the official SDK.
 */
export function createOpenAiClient(apiKey: string, Sdk: OpenAiClientConstructor = OpenAI): OpenAI {
  return new Sdk(openAiClientConstruction(apiKey));
}
