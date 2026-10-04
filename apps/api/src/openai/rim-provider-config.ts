/**
 * Server-side RIM provider configuration.
 *
 * Parsing does not construct an OpenAI client. Runtime selection lives in
 * selectRimProvider. OPENAI_API_KEY stays on the server config object and is
 * omitted from the public view and from JSON serialization.
 */

export type RimProviderConfigErrorCode =
  "RIM_PROVIDER_UNKNOWN" | "OPENAI_API_KEY_REQUIRED" | "OPENAI_MODEL_REQUIRED";

export class RimProviderConfigError extends Error {
  readonly code: RimProviderConfigErrorCode;

  constructor(code: RimProviderConfigErrorCode, message: string) {
    super(message);
    this.name = "RimProviderConfigError";
    this.code = code;
  }
}

export type FakeRimProviderConfig = Readonly<{
  provider: "fake";
}>;

export type PublicOpenAiRimProviderConfig = Readonly<{
  provider: "openai";
  model: string;
}>;

export type PublicRimProviderConfig = FakeRimProviderConfig | PublicOpenAiRimProviderConfig;

export type OpenAiRimProviderConfig = Readonly<{
  provider: "openai";
  apiKey: string;
  model: string;
  toJSON: () => PublicOpenAiRimProviderConfig;
}>;

export type RimProviderConfig = FakeRimProviderConfig | OpenAiRimProviderConfig;

const FAKE_CONFIG: FakeRimProviderConfig = Object.freeze({ provider: "fake" });

function requiredText(value: string | undefined): string {
  return value?.trim() ?? "";
}

function openAiRimProviderConfig(apiKey: string, model: string): OpenAiRimProviderConfig {
  return {
    provider: "openai",
    apiKey,
    model,
    toJSON: () => ({ provider: "openai", model }),
  };
}

/**
 * Read RIM provider settings from an explicit env object.
 * Unset and `fake` keep fake mode. `openai` requires both key and model.
 * Invalid explicit openai settings throw; they do not fall back to fake.
 */
export function loadRimProviderConfig(env: NodeJS.ProcessEnv = process.env): RimProviderConfig {
  const provider = requiredText(env.RIM_PROVIDER);
  if (provider === "" || provider === "fake") {
    return FAKE_CONFIG;
  }
  if (provider !== "openai") {
    throw new RimProviderConfigError(
      "RIM_PROVIDER_UNKNOWN",
      `Unknown RIM_PROVIDER "${provider}". Expected unset, "fake", or "openai".`,
    );
  }

  const apiKey = requiredText(env.OPENAI_API_KEY);
  if (apiKey === "") {
    throw new RimProviderConfigError(
      "OPENAI_API_KEY_REQUIRED",
      "RIM_PROVIDER=openai requires OPENAI_API_KEY.",
    );
  }

  const model = requiredText(env.OPENAI_MODEL);
  if (model === "") {
    throw new RimProviderConfigError(
      "OPENAI_MODEL_REQUIRED",
      "RIM_PROVIDER=openai requires OPENAI_MODEL.",
    );
  }

  return openAiRimProviderConfig(apiKey, model);
}

/** User-facing provider settings. Never includes OPENAI_API_KEY. */
export function publicRimProviderConfig(config: RimProviderConfig): PublicRimProviderConfig {
  if (config.provider === "fake") {
    return FAKE_CONFIG;
  }
  return config.toJSON();
}
