import { describe, expect, it } from "vitest";
import {
  loadRimProviderConfig,
  publicRimProviderConfig,
  RimProviderConfigError,
} from "./rim-provider-config.ts";

const FAKE_KEY = "test-openai-key";
const FAKE_MODEL = "test-model";

describe("loadRimProviderConfig", () => {
  it("selects fake mode when RIM_PROVIDER is unset", () => {
    expect(loadRimProviderConfig({})).toEqual({ provider: "fake" });
    expect(publicRimProviderConfig(loadRimProviderConfig({}))).toEqual({ provider: "fake" });
  });

  it("selects fake mode when RIM_PROVIDER=fake and drops any key", () => {
    const config = loadRimProviderConfig({
      RIM_PROVIDER: "fake",
      OPENAI_API_KEY: FAKE_KEY,
      OPENAI_MODEL: FAKE_MODEL,
    });
    expect(config).toEqual({ provider: "fake" });
    expect(JSON.stringify(config)).not.toContain(FAKE_KEY);
    expect(publicRimProviderConfig(config)).toEqual({ provider: "fake" });
  });

  it("accepts openai mode when key and model are present", () => {
    const config = loadRimProviderConfig({
      RIM_PROVIDER: " openai ",
      OPENAI_API_KEY: `  ${FAKE_KEY}  `,
      OPENAI_MODEL: `  ${FAKE_MODEL}  `,
    });
    expect(config).toMatchObject({
      provider: "openai",
      apiKey: FAKE_KEY,
      model: FAKE_MODEL,
    });
    expect(publicRimProviderConfig(config)).toEqual({
      provider: "openai",
      model: FAKE_MODEL,
    });
  });

  it("fails when openai mode is missing the API key", () => {
    expect(() =>
      loadRimProviderConfig({
        RIM_PROVIDER: "openai",
        OPENAI_MODEL: FAKE_MODEL,
      }),
    ).toThrow(RimProviderConfigError);
    expect(() =>
      loadRimProviderConfig({
        RIM_PROVIDER: "openai",
        OPENAI_API_KEY: "   ",
        OPENAI_MODEL: FAKE_MODEL,
      }),
    ).toThrow(
      expect.objectContaining({
        name: "RimProviderConfigError",
        code: "OPENAI_API_KEY_REQUIRED",
      }),
    );
  });

  it("fails when openai mode is missing the model and does not reveal the key", () => {
    expect(() =>
      loadRimProviderConfig({
        RIM_PROVIDER: "openai",
        OPENAI_API_KEY: FAKE_KEY,
      }),
    ).toThrow(
      expect.objectContaining({
        name: "RimProviderConfigError",
        code: "OPENAI_MODEL_REQUIRED",
      }),
    );
    try {
      loadRimProviderConfig({
        RIM_PROVIDER: "openai",
        OPENAI_API_KEY: FAKE_KEY,
        OPENAI_MODEL: " ",
      });
      expect.unreachable("missing model must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RimProviderConfigError);
      expect((error as RimProviderConfigError).message).not.toContain(FAKE_KEY);
      expect(error).not.toMatchObject({ provider: "fake" });
    }
  });

  it("fails for an unknown provider", () => {
    expect(() => loadRimProviderConfig({ RIM_PROVIDER: "OpenAI" })).toThrow(
      expect.objectContaining({
        name: "RimProviderConfigError",
        code: "RIM_PROVIDER_UNKNOWN",
      }),
    );
    expect(() => loadRimProviderConfig({ RIM_PROVIDER: "anthropic" })).toThrow(
      /Unknown RIM_PROVIDER "anthropic"/,
    );
  });

  it("omits the API key from the public configuration and JSON serialization", () => {
    const config = loadRimProviderConfig({
      RIM_PROVIDER: "openai",
      OPENAI_API_KEY: FAKE_KEY,
      OPENAI_MODEL: FAKE_MODEL,
    });
    const publicConfig = publicRimProviderConfig(config);
    expect(publicConfig).toEqual({ provider: "openai", model: FAKE_MODEL });
    expect(Object.keys(publicConfig)).toEqual(["provider", "model"]);
    expect(JSON.stringify(publicConfig)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(config)).not.toContain(FAKE_KEY);
    expect(JSON.parse(JSON.stringify(config))).toEqual({
      provider: "openai",
      model: FAKE_MODEL,
    });
  });

  it("does not select fake mode after explicit openai intent", () => {
    try {
      const config = loadRimProviderConfig({
        RIM_PROVIDER: "openai",
        OPENAI_API_KEY: FAKE_KEY,
      });
      throw new Error(`parser returned provider ${config.provider} instead of failing`);
    } catch (error) {
      expect(error).toBeInstanceOf(RimProviderConfigError);
      expect((error as RimProviderConfigError).code).toBe("OPENAI_MODEL_REQUIRED");
      expect(error).not.toMatchObject({ provider: "fake" });
    }
  });
});
