import { describe, expect, it } from "vitest";
import { OpenAI } from "openai";
import {
  createOpenAiClient,
  OPENAI_CLIENT_MAX_RETRIES,
  openAiClientConstruction,
  type OpenAiClientConstruction,
} from "./openai-client.ts";

const FAKE_KEY = "test-openai-key";

describe("createOpenAiClient", () => {
  it("constructs the official SDK client with effective maxRetries 0", () => {
    const client = createOpenAiClient(FAKE_KEY);
    expect(client).toBeInstanceOf(OpenAI);
    expect(client.maxRetries).toBe(0);
    expect(client.maxRetries).toBe(OPENAI_CLIENT_MAX_RETRIES);
    expect(client.apiKey).toBe(FAKE_KEY);
    expect(client.timeout).toBe(OpenAI.DEFAULT_TIMEOUT);
  });

  it("passes maxRetries 0 into construction and does not set a timeout", () => {
    const received: OpenAiClientConstruction[] = [];
    class RecordingClient extends OpenAI {
      constructor(options: OpenAiClientConstruction) {
        received.push(options);
        super(options);
      }
    }

    const client = createOpenAiClient(FAKE_KEY, RecordingClient);
    expect(client).toBeInstanceOf(OpenAI);
    expect(client.maxRetries).toBe(0);
    expect(received).toEqual([{ apiKey: FAKE_KEY, maxRetries: 0 }]);
    expect(openAiClientConstruction(FAKE_KEY)).toEqual({
      apiKey: FAKE_KEY,
      maxRetries: 0,
    });
    expect(Object.keys(openAiClientConstruction(FAKE_KEY))).toEqual(["apiKey", "maxRetries"]);
    const construction = received[0];
    expect(construction).toBeDefined();
    expect(Object.hasOwn(construction ?? {}, "timeout")).toBe(false);
    expect(Object.hasOwn(construction ?? {}, "organization")).toBe(false);
    expect(Object.hasOwn(construction ?? {}, "project")).toBe(false);
  });
});
