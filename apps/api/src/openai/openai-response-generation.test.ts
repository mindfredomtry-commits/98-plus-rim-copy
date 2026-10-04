import { describe, expect, it } from "vitest";
import type { OpenAI } from "openai";
import type {
  AiRequestId,
  AskRimOrigin,
  BanId,
  ContextRequestId,
  ExecutionProbability,
  NotificationItemId,
  RelationshipContextData,
  RimChatId,
} from "@98plus/product-model";
import {
  PRODUCT_SEMANTICS_MVP15,
  PRODUCT_SEMANTICS_UNAVAILABLE,
  RIM_PROMPT_UNAVAILABLE,
  RIM_PROMPT_V1,
  validateRimAiOutput,
  type LocalRimAiRequest,
  type ProviderConversationId,
  type ProviderRimAiRequest,
  type RimAiResponseObserver,
} from "@98plus/application";
import { PRODUCT_SEMANTICS_MVP15_TEXT } from "../../../../packages/application/src/rim/semantics/product-semantics-mvp15.ts";
import { RIM_PROMPT_V1_TEXT } from "../../../../packages/application/src/rim/semantics/rim-prompt-v1.ts";
import { canonicalJson } from "./canonical-json.ts";
import { extractRimCandidateFromCompletedText } from "./rim-completed-output.ts";
import {
  OpenAiGenerationTransportError,
  OpenAiResponseGenerator,
  openAiGenerationClient,
  type OpenAiGenerationBody,
  type OpenAiGenerationEvent,
  type OpenAiGenerationStream,
} from "./openai-response-generation.ts";
import { RIM_OUTPUT_FORMAT } from "./rim-output-format.ts";

const MODEL = "configured-test-model";
const CONVERSATION_ID = "conv_test_stored" as ProviderConversationId;
const CURRENT_USER = "semantic-user-turn-9f3";
const PRIOR_TEXT = "prior-transcript-7aa";
const CONTEXT_BAN = "context-ban-4c1";
const HIDDEN_PROPOSAL_ID = "hidden-proposal-id";

const CONTEXT: RelationshipContextData = {
  aggregates: {
    userToContact: {
      bansSentCount: 1,
      statusCounts: { bantastic: 1, banflict: 0, fairEnough: 0, overboard: 0 },
    },
    contactToUser: {
      bansSentCount: 0,
      statusCounts: { bantastic: 0, banflict: 0, fairEnough: 0, overboard: 0 },
    },
  },
  recentBans: [
    {
      direction: "USER_TO_CONTACT",
      banText: CONTEXT_BAN,
      ageHours: 4,
      result: { kind: "ACTIVE" },
    },
  ],
};

const ASK_ORIGIN: AskRimOrigin = {
  sourceStatusItemId: "item-ask-1" as NotificationItemId,
  banId: "ban-ask-1" as BanId,
  status: "BANTASTIC",
  sourceRole: "RECEIVER",
};

const PROPOSALS = [
  {
    banText: "не обсуждать работу",
    executionProbability: 0.2 as ExecutionProbability,
    proposalId: HIDDEN_PROPOSAL_ID,
  },
  { banText: "не опаздывать", executionProbability: 0.5 as ExecutionProbability },
  { banText: "не повышать голос", executionProbability: 0.8 as ExecutionProbability },
];

type RecordedCreate = {
  body: OpenAiGenerationBody;
  options: { maxRetries?: number; idempotencyKey?: string; timeout?: number };
};

function created(id: string): OpenAiGenerationEvent {
  return { type: "response.created", response: { id, status: "in_progress", output_text: "" } };
}

function completed(output: unknown, id = "resp_test_1"): OpenAiGenerationEvent {
  return {
    type: "response.completed",
    response: { id, status: "completed", output_text: JSON.stringify({ output }) },
  };
}

function messageOutput(text: string) {
  return { type: "MESSAGE", text };
}

function streamFrom(
  events: readonly OpenAiGenerationEvent[],
  throwAt?: number,
): { stream: OpenAiGenerationStream; aborted: () => boolean } {
  let aborted = false;
  return {
    aborted: () => aborted,
    stream: {
      controller: {
        abort() {
          aborted = true;
        },
      },
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < events.length; index += 1) {
          if (throwAt === index) {
            throw new Error("socket closed");
          }
          const event = events[index];
          if (event) {
            yield event;
          }
        }
      },
    },
  };
}

function projecting(events: readonly object[]) {
  const calls: RecordedCreate[] = [];
  let retrieves = 0;
  let aborted = false;
  const sdk = {
    responses: {
      async create(body: OpenAiGenerationBody, options: RecordedCreate["options"]) {
        calls.push({ body, options });
        return {
          controller: {
            abort() {
              aborted = true;
            },
          },
          async *[Symbol.asyncIterator]() {
            for (const event of events) {
              yield event;
            }
          },
        };
      },
      async retrieve() {
        retrieves += 1;
        return { id: "resp_retrieved" };
      },
    },
  };
  return {
    calls,
    aborted: () => aborted,
    retrieves: () => retrieves,
    client: openAiGenerationClient(sdk as unknown as Pick<OpenAI, "responses">),
  };
}

function recording(events: readonly OpenAiGenerationEvent[], throwAt?: number) {
  const calls: RecordedCreate[] = [];
  let retrieves = 0;
  const active = streamFrom(events, throwAt);
  return {
    calls,
    aborted: active.aborted,
    retrieves: () => retrieves,
    client: {
      responses: {
        async create(body: OpenAiGenerationBody, options: RecordedCreate["options"]) {
          calls.push({ body, options });
          return active.stream;
        },
        async retrieve() {
          retrieves += 1;
          return { id: "resp_retrieved" };
        },
      },
    },
  };
}

function providerRequest(): ProviderRimAiRequest {
  return {
    continuityMode: "provider-conversation",
    requestId: "request-1" as AiRequestId,
    rimChatId: "chat-1" as RimChatId,
    conversationId: CONVERSATION_ID,
    userMessage: CURRENT_USER,
    contextRequestId: "context-1" as ContextRequestId,
    relationshipContext: CONTEXT,
    messages: [
      { kind: "RIM", text: PRIOR_TEXT },
      { kind: "USER", text: CURRENT_USER },
    ],
    conversationalOrigin: ASK_ORIGIN,
  };
}

function localRequest(origin: AskRimOrigin | null): LocalRimAiRequest {
  return {
    continuityMode: "local-canonical-history",
    requestId: "request-1" as AiRequestId,
    rimChatId: "chat-1" as RimChatId,
    contextRequestId: "context-1" as ContextRequestId,
    relationshipContext: CONTEXT,
    conversationalOrigin: origin,
    rimPrompt: RIM_PROMPT_V1,
    productSemantics: PRODUCT_SEMANTICS_MVP15,
    canonicalHistory: [
      { kind: "USER", text: "первый-ход" },
      { kind: "RIM", text: "ответ-рим" },
      {
        kind: "BAN_PROPOSALS",
        message: "три запрета",
        proposals: PROPOSALS,
      },
      { kind: "USER", text: CURRENT_USER },
    ],
  };
}

function acceptObserver(seen: string[]): RimAiResponseObserver {
  return {
    async onResponseCreated(responseId) {
      seen.push(responseId);
      return { accepted: true };
    },
  };
}

function inputItems(body: OpenAiGenerationBody) {
  expect(Array.isArray(body.input)).toBe(true);
  if (!Array.isArray(body.input)) {
    throw new Error("expected local input items");
  }
  return body.input;
}

describe("OpenAiResponseGenerator", () => {
  it("sends one provider continuation with the new USER message only", async () => {
    const transport = recording([
      created("resp_test_1"),
      { type: "response.output_text.delta", delta: "PARTIAL_DELTA" },
      completed(messageOutput("готово")),
    ]);
    const seen: string[] = [];
    const result = await new OpenAiResponseGenerator(transport.client, MODEL).respond(
      providerRequest(),
      acceptObserver(seen),
    );

    expect(transport.calls).toHaveLength(1);
    expect(transport.retrieves()).toBe(0);
    expect(seen).toEqual(["resp_test_1"]);
    const call = transport.calls[0];
    expect(call).toBeDefined();
    if (!call) {
      return;
    }
    expect(call.body.model).toBe(MODEL);
    expect(call.body.conversation).toBe(CONVERSATION_ID);
    expect(call.body.input).toBe(CURRENT_USER);
    expect(call.body.store).toBe(true);
    expect(call.body.stream).toBe(true);
    expect(call.body.text.format).toBe(RIM_OUTPUT_FORMAT);
    expect(call.options).toEqual({ maxRetries: 0 });
    expect(Object.keys(call.options)).toEqual(["maxRetries"]);
    expect(Object.hasOwn(call.options, "idempotencyKey")).toBe(false);
    expect(Object.hasOwn(call.options, "timeout")).toBe(false);
    expect(Object.hasOwn(call.body, "previous_response_id")).toBe(false);
    expect(Object.hasOwn(call.body, "temperature")).toBe(false);
    expect(Object.hasOwn(call.body, "max_output_tokens")).toBe(false);
    const encoded = JSON.stringify(call);
    expect(encoded).not.toContain(RIM_PROMPT_V1_TEXT.slice(0, 40));
    expect(encoded).not.toContain(PRODUCT_SEMANTICS_MVP15_TEXT.slice(0, 40));
    expect(encoded).not.toContain(CONTEXT_BAN);
    expect(encoded).not.toContain("BANTASTIC");
    expect(encoded).not.toContain(PRIOR_TEXT);
    expect(encoded).not.toContain("previous_response_id");
    expect(encoded).not.toContain("request-1");
    expect(encoded).not.toContain("PARTIAL_DELTA");
    expect(result).toEqual(messageOutput("готово"));
  });

  it("sends local canonical history without a conversation or previous response id", async () => {
    const transport = recording([created("resp_local"), completed(messageOutput("локально"))]);
    const result = await new OpenAiResponseGenerator(transport.client, MODEL).respond(
      localRequest(null),
      acceptObserver([]),
    );
    const call = transport.calls[0];
    expect(call).toBeDefined();
    if (!call) {
      return;
    }
    expect(Object.hasOwn(call.body, "conversation")).toBe(false);
    expect(Object.hasOwn(call.body, "previous_response_id")).toBe(false);
    expect(call.body.store).toBe(true);
    expect(call.body.stream).toBe(true);
    expect(call.options).toEqual({ maxRetries: 0 });
    const items = inputItems(call.body);
    expect(items.map((item) => item.role)).toEqual([
      "developer",
      "developer",
      "developer",
      "developer",
      "user",
      "assistant",
      "assistant",
      "user",
    ]);
    expect(items[0]?.content).toBe(RIM_PROMPT_V1_TEXT);
    expect(items[0]?.content).toBe(RIM_PROMPT_V1.text);
    expect(items.filter((item) => item.content === RIM_PROMPT_V1_TEXT)).toHaveLength(1);
    expect(items[1]?.content).toBe(PRODUCT_SEMANTICS_MVP15_TEXT);
    expect(items[1]?.content).toBe(PRODUCT_SEMANTICS_MVP15.text);
    expect(items.filter((item) => item.content === PRODUCT_SEMANTICS_MVP15_TEXT)).toHaveLength(1);
    expect(JSON.parse(items[2]?.content ?? "")).toEqual({ relationshipContext: CONTEXT });
    expect(items.filter((item) => item.content.includes(CONTEXT_BAN))).toHaveLength(1);
    expect(items[3]?.content).toBe('{"origin":null}');
    expect(items[4]).toEqual({ type: "message", role: "user", content: "первый-ход" });
    expect(items[5]).toEqual({ type: "message", role: "assistant", content: "ответ-рим" });
    expect(items[6]?.role).toBe("assistant");
    expect(JSON.parse(items[6]?.content ?? "")).toEqual({
      type: "BAN_PROPOSALS",
      message: "три запрета",
      proposals: [
        { banText: "не обсуждать работу", executionProbability: 0.2 },
        { banText: "не опаздывать", executionProbability: 0.5 },
        { banText: "не повышать голос", executionProbability: 0.8 },
      ],
    });
    expect(items[6]?.content).toBe(
      canonicalJson({
        type: "BAN_PROPOSALS",
        message: "три запрета",
        proposals: PROPOSALS.map((proposal) => ({
          banText: proposal.banText,
          executionProbability: proposal.executionProbability,
        })),
      }),
    );
    expect(items[7]).toEqual({ type: "message", role: "user", content: CURRENT_USER });
    expect(items.filter((item) => item.content === CURRENT_USER)).toHaveLength(1);
    const history = items.slice(4);
    const encodedHistory = JSON.stringify(history);
    expect(encodedHistory).not.toContain(HIDDEN_PROPOSAL_ID);
    expect(encodedHistory).not.toContain("proposalId");
    expect(encodedHistory).not.toContain("duration");
    const proposals = JSON.parse(items[6]?.content ?? "") as {
      proposals: Array<Record<string, unknown>>;
    };
    for (const proposal of proposals.proposals) {
      expect(Object.keys(proposal).sort()).toEqual(["banText", "executionProbability"]);
    }
    expect(result).toEqual(messageOutput("локально"));
  });

  it("sends the exact Ask RIM origin in local mode", async () => {
    const transport = recording([created("resp_ask"), completed(messageOutput("из статуса"))]);
    await new OpenAiResponseGenerator(transport.client, MODEL).respond(
      localRequest(ASK_ORIGIN),
      acceptObserver([]),
    );
    const body = transport.calls[0]?.body;
    expect(body).toBeDefined();
    if (!body) {
      return;
    }
    const items = inputItems(body);
    const origin = JSON.parse(items[3]?.content ?? "") as { origin: AskRimOrigin };
    expect(origin).toEqual({ origin: ASK_ORIGIN });
    expect(origin.origin.status).toBe("BANTASTIC");
    expect(items.filter((item) => item.content === items[3]?.content)).toHaveLength(1);
  });

  it("rejects unavailable semantics before responses.create", async () => {
    const transport = recording([created("resp_unused"), completed(messageOutput("нет"))]);
    const generator = new OpenAiResponseGenerator(transport.client, MODEL);
    await expect(
      generator.respond(
        { ...localRequest(null), rimPrompt: RIM_PROMPT_UNAVAILABLE },
        acceptObserver([]),
      ),
    ).rejects.toThrow(/not provider-ready/);
    await expect(
      generator.respond(
        { ...localRequest(null), productSemantics: PRODUCT_SEMANTICS_UNAVAILABLE },
        acceptObserver([]),
      ),
    ).rejects.toThrow(/not provider-ready/);
    expect(transport.calls).toHaveLength(0);
    expect(transport.retrieves()).toBe(0);
  });

  it("awaits response.created before a completed body can escape", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transport = recording([
      created("resp_order"),
      { type: "response.output_text.delta", delta: "PARTIAL_DELTA" },
      { type: "response.output_text.done", text: "DONE_NOT_CANONICAL" },
      completed(messageOutput("после-наблюдателя"), "resp_order"),
    ]);
    let settled = false;
    const pending = new OpenAiResponseGenerator(transport.client, MODEL)
      .respond(providerRequest(), {
        async onResponseCreated(responseId) {
          expect(responseId).toBe("resp_order");
          entered();
          await gate;
          return { accepted: true };
        },
      })
      .then((value) => {
        settled = true;
        return value;
      });
    await enteredGate;
    expect(settled).toBe(false);
    release();
    await expect(pending).resolves.toEqual(messageOutput("после-наблюдателя"));
    expect(JSON.stringify(await pending)).not.toContain("PARTIAL_DELTA");
    expect(JSON.stringify(await pending)).not.toContain("DONE_NOT_CANONICAL");
  });

  it("drops a refused response and does not generate another", async () => {
    const transport = recording([created("resp_refused"), completed(messageOutput("нельзя"))]);
    const seen: string[] = [];
    await expect(
      new OpenAiResponseGenerator(transport.client, MODEL).respond(providerRequest(), {
        async onResponseCreated(responseId) {
          seen.push(responseId);
          return { accepted: false };
        },
      }),
    ).rejects.toBeInstanceOf(OpenAiGenerationTransportError);
    expect(seen).toEqual(["resp_refused"]);
    expect(transport.calls).toHaveLength(1);
    expect(transport.aborted()).toBe(true);
    expect(transport.retrieves()).toBe(0);
  });

  it("observes one response id once and fails closed on a different id", async () => {
    const repeated = recording([
      created("resp_same"),
      created("resp_same"),
      completed(messageOutput("один"), "resp_same"),
    ]);
    const seen: string[] = [];
    await expect(
      new OpenAiResponseGenerator(repeated.client, MODEL).respond(
        providerRequest(),
        acceptObserver(seen),
      ),
    ).resolves.toEqual(messageOutput("один"));
    expect(seen).toEqual(["resp_same"]);

    const conflict = recording([
      created("resp_first"),
      created("resp_second"),
      completed(messageOutput("чужой"), "resp_second"),
    ]);
    const conflictSeen: string[] = [];
    await expect(
      new OpenAiResponseGenerator(conflict.client, MODEL).respond(providerRequest(), {
        async onResponseCreated(responseId) {
          conflictSeen.push(responseId);
          return { accepted: true };
        },
      }),
    ).rejects.toThrow(/response id conflict/);
    expect(conflictSeen).toEqual(["resp_first"]);
    expect(conflict.calls).toHaveLength(1);
    expect(conflict.aborted()).toBe(true);
    expect(conflict.retrieves()).toBe(0);
  });

  it("does not retry when the stream fails before or after response.created", async () => {
    const before = recording([created("resp_never")], 0);
    await expect(
      new OpenAiResponseGenerator(before.client, MODEL).respond(
        providerRequest(),
        acceptObserver([]),
      ),
    ).rejects.toThrow("socket closed");
    expect(before.calls).toHaveLength(1);
    expect(before.retrieves()).toBe(0);

    const after = recording([created("resp_known"), completed(messageOutput("поздно"))], 1);
    const seen: string[] = [];
    await expect(
      new OpenAiResponseGenerator(after.client, MODEL).respond(
        providerRequest(),
        acceptObserver(seen),
      ),
    ).rejects.toThrow("socket closed");
    expect(seen).toEqual(["resp_known"]);
    expect(after.calls).toHaveLength(1);
    expect(after.retrieves()).toBe(0);
  });

  it("turns failed, cancelled, and incomplete terminal events into transport failures", async () => {
    const cases: OpenAiGenerationEvent[] = [
      {
        type: "response.failed",
        response: { id: "resp_fail", status: "failed", error: { message: "upstream" } },
      },
      { type: "response.incomplete", response: { id: "resp_inc", status: "incomplete" } },
      { type: "response.incomplete", response: { id: "resp_cancel", status: "cancelled" } },
      { type: "response.cancelled", response: { id: "resp_cancel_event", status: "cancelled" } },
      { type: "error", message: "stream error" },
    ];
    for (const event of cases) {
      const transport = recording([created("resp_terminal"), event]);
      await expect(
        new OpenAiResponseGenerator(transport.client, MODEL).respond(
          providerRequest(),
          acceptObserver([]),
        ),
      ).rejects.toBeInstanceOf(OpenAiGenerationTransportError);
      expect(transport.calls).toHaveLength(1);
      expect(transport.retrieves()).toBe(0);
    }
  });

  it("returns raw envelope output without repairing it", async () => {
    const generatorFor = (outputText: string) => {
      const transport = recording([
        created("resp_raw"),
        {
          type: "response.completed",
          response: { id: "resp_raw", status: "completed", output_text: outputText },
        },
      ]);
      return new OpenAiResponseGenerator(transport.client, MODEL).respond(
        providerRequest(),
        acceptObserver([]),
      );
    };

    const message = await generatorFor(
      JSON.stringify({ output: { type: "MESSAGE", text: "сырой текст" } }),
    );
    expect(message).toEqual({ type: "MESSAGE", text: "сырой текст" });
    expect(message).not.toHaveProperty("proposalId");
    expect(validateRimAiOutput(message)).toEqual({
      ok: true,
      result: { kind: "MESSAGE", text: "сырой текст" },
    });

    const proposals = {
      type: "BAN_PROPOSALS",
      message: "три запрета",
      proposals: [
        { banText: "не обсуждать работу", executionProbability: 0.2 },
        { banText: "не опаздывать", executionProbability: 0.5 },
        { banText: "не повышать голос", executionProbability: 1 },
      ],
    };
    const ban = await generatorFor(JSON.stringify({ output: proposals }));
    expect(ban).toEqual(proposals);
    expect(JSON.stringify(ban)).not.toContain("proposalId");

    const short = {
      type: "BAN_PROPOSALS",
      message: "мало",
      proposals: [{ banText: "один", executionProbability: 0.4 }],
    };
    const unrepaired = await generatorFor(JSON.stringify({ output: short }));
    expect(unrepaired).toEqual(short);
    expect(validateRimAiOutput(unrepaired)).toEqual({ ok: false, reason: "proposal-count" });

    const high = {
      type: "BAN_PROPOSALS",
      message: "выше",
      proposals: [
        { banText: "а", executionProbability: 1.5 },
        { banText: "б", executionProbability: 0.2 },
        { banText: "в", executionProbability: 0.3 },
      ],
    };
    const unclamped = await generatorFor(JSON.stringify({ output: high }));
    expect(unclamped).toEqual(high);
    expect(validateRimAiOutput(unclamped)).toEqual({ ok: false, reason: "proposal-probability" });

    const malformed = await generatorFor("not-json{");
    expect(malformed).toBe("not-json{");
    expect(validateRimAiOutput(malformed)).toEqual({ ok: false, reason: "not-an-object" });

    const unwrapped = await generatorFor(JSON.stringify({ type: "MESSAGE", text: "без конверта" }));
    expect(unwrapped).toBe(JSON.stringify({ type: "MESSAGE", text: "без конверта" }));
    expect(validateRimAiOutput(unwrapped)).toEqual({ ok: false, reason: "not-an-object" });
  });

  it("keeps completed-body extraction identical to the shared transport helper", async () => {
    const samples = [
      JSON.stringify({ output: messageOutput("общий") }),
      JSON.stringify({
        output: {
          type: "BAN_PROPOSALS",
          message: "три",
          proposals: [
            { banText: "а", executionProbability: 0.1 },
            { banText: "б", executionProbability: 0.2 },
            { banText: "в", executionProbability: 0.3 },
          ],
        },
      }),
      "not-json{",
      JSON.stringify({ type: "MESSAGE", text: "без конверта" }),
      JSON.stringify({ output: { type: "MESSAGE" } }),
    ];
    for (const outputText of samples) {
      const transport = recording([
        created("resp_shared"),
        {
          type: "response.completed",
          response: { id: "resp_shared", status: "completed", output_text: outputText },
        },
      ]);
      const result = await new OpenAiResponseGenerator(transport.client, MODEL).respond(
        providerRequest(),
        acceptObserver([]),
      );
      expect(result).toEqual(extractRimCandidateFromCompletedText(outputText));
    }
  });
});

const BAN_OUTPUT = {
  type: "BAN_PROPOSALS",
  message: "три запрета",
  proposals: [
    { banText: "не обсуждать работу", executionProbability: 0.2 },
    { banText: "не опаздывать", executionProbability: 0.5 },
    { banText: "не повышать голос", executionProbability: 1 },
  ],
};

function completedFromOutput(output: readonly unknown[], id = "resp_output") {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output,
    },
  };
}

function messageItem(text: string) {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

describe("streaming completed output extraction", () => {
  it("keeps a string output_text ahead of response.output", async () => {
    const transport = projecting([
      created("resp_prefer"),
      {
        type: "response.completed",
        response: {
          id: "resp_prefer",
          status: "completed",
          output_text: JSON.stringify({ output: messageOutput("из-поля") }),
          output: [messageItem(JSON.stringify({ output: messageOutput("из-массива") }))],
        },
      },
    ]);
    const result = await new OpenAiResponseGenerator(transport.client, MODEL).respond(
      providerRequest(),
      acceptObserver([]),
    );
    expect(result).toEqual(messageOutput("из-поля"));
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.options).toEqual({ maxRetries: 0 });
    expect(transport.retrieves()).toBe(0);
  });

  it("reads the live completed payload that has no output_text field", async () => {
    const envelope = JSON.stringify({ output: messageOutput("из-сообщения") });
    const completedEvent = completedFromOutput(
      [
        { type: "reasoning", content: [] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: envelope }],
        },
      ],
      "resp_live",
    );
    expect(Object.hasOwn(completedEvent.response, "output_text")).toBe(false);
    const transport = projecting([
      created("resp_live"),
      { type: "response.output_text.delta", delta: "PARTIAL_DELTA" },
      { type: "response.output_text.done", text: "DONE_NOT_CANONICAL" },
      completedEvent,
    ]);
    const seen: string[] = [];
    const result = await new OpenAiResponseGenerator(transport.client, MODEL).respond(
      providerRequest(),
      acceptObserver(seen),
    );
    expect(seen).toEqual(["resp_live"]);
    expect(result).toEqual(messageOutput("из-сообщения"));
    expect(validateRimAiOutput(result)).toEqual({
      ok: true,
      result: { kind: "MESSAGE", text: "из-сообщения" },
    });
    expect(JSON.stringify(result)).not.toContain("DONE_NOT_CANONICAL");
    expect(JSON.stringify(result)).not.toContain("PARTIAL_DELTA");
    expect(transport.calls).toHaveLength(1);
    expect(transport.retrieves()).toBe(0);
    const call = transport.calls[0];
    expect(call?.body.model).toBe(MODEL);
    expect(call?.body.conversation).toBe(CONVERSATION_ID);
    expect(call?.body.input).toBe(CURRENT_USER);
    expect(call?.body.store).toBe(true);
    expect(call?.body.stream).toBe(true);
    expect(call?.body.text.format).toBe(RIM_OUTPUT_FORMAT);
    expect(call?.options).toEqual({ maxRetries: 0 });
    expect(Object.hasOwn(call?.body ?? {}, "previous_response_id")).toBe(false);
  });

  it("returns a BAN_PROPOSALS candidate from message output_text content", async () => {
    const transport = projecting([
      created("resp_ban"),
      completedFromOutput(
        [{ type: "reasoning" }, messageItem(JSON.stringify({ output: BAN_OUTPUT }))],
        "resp_ban",
      ),
    ]);
    const result = await new OpenAiResponseGenerator(transport.client, MODEL).respond(
      providerRequest(),
      acceptObserver([]),
    );
    expect(result).toEqual(BAN_OUTPUT);
    expect(validateRimAiOutput(result)).toEqual({
      ok: true,
      result: {
        kind: "BAN_PROPOSALS",
        message: BAN_OUTPUT.message,
        proposals: BAN_OUTPUT.proposals,
      },
    });
  });

  it("joins message output_text fragments in order and ignores other items", async () => {
    const joined = JSON.stringify({ output: messageOutput("склеено") });
    const splitAt = joined.indexOf("склеено");
    const transport = projecting([
      created("resp_join"),
      completedFromOutput(
        [
          { type: "reasoning", content: [{ type: "summary_text", text: "скрыто" }] },
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "refusal", refusal: "нет" },
              { type: "output_text", text: joined.slice(0, splitAt) },
              { type: "input_image" },
              { type: "output_text", text: 12 },
            ],
          },
          { type: "function_call", name: "ignored" },
          messageItem(joined.slice(splitAt)),
        ],
        "resp_join",
      ),
    ]);
    const result = await new OpenAiResponseGenerator(transport.client, MODEL).respond(
      providerRequest(),
      acceptObserver([]),
    );
    expect(result).toEqual(messageOutput("склеено"));
    expect(JSON.stringify(result)).not.toContain("скрыто");
    expect(JSON.stringify(result)).not.toContain("нет");
  });

  it("does not repair malformed or unenveloped text taken from output", async () => {
    const malformed = projecting([
      created("resp_bad"),
      completedFromOutput([messageItem("not-json{")], "resp_bad"),
    ]);
    const malformedResult = await new OpenAiResponseGenerator(malformed.client, MODEL).respond(
      providerRequest(),
      acceptObserver([]),
    );
    expect(malformedResult).toBe("not-json{");
    expect(validateRimAiOutput(malformedResult)).toEqual({ ok: false, reason: "not-an-object" });

    const bare = JSON.stringify({ type: "MESSAGE", text: "без конверта" });
    const missing = projecting([
      created("resp_bare"),
      completedFromOutput([messageItem(bare)], "resp_bare"),
    ]);
    const missingResult = await new OpenAiResponseGenerator(missing.client, MODEL).respond(
      providerRequest(),
      acceptObserver([]),
    );
    expect(missingResult).toBe(bare);
    expect(validateRimAiOutput(missingResult)).toEqual({ ok: false, reason: "not-an-object" });
  });

  it("keeps absence of completed text unusable", async () => {
    const transport = projecting([
      created("resp_none"),
      completedFromOutput(
        [
          { type: "reasoning", content: [] },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "refusal", refusal: "нет" }],
          },
          { type: "function_call" },
        ],
        "resp_none",
      ),
    ]);
    const result = await new OpenAiResponseGenerator(transport.client, MODEL).respond(
      providerRequest(),
      acceptObserver([]),
    );
    expect(result).toBeNull();
    expect(validateRimAiOutput(result)).toEqual({ ok: false, reason: "not-an-object" });
    expect(transport.calls).toHaveLength(1);
    expect(transport.retrieves()).toBe(0);
  });

  it("still waits for the observer before returning output-derived text", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transport = projecting([
      created("resp_live_order"),
      completedFromOutput(
        [{ type: "reasoning" }, messageItem(JSON.stringify({ output: messageOutput("после") }))],
        "resp_live_order",
      ),
    ]);
    let settled = false;
    const pending = new OpenAiResponseGenerator(transport.client, MODEL)
      .respond(providerRequest(), {
        async onResponseCreated() {
          entered();
          await gate;
          return { accepted: true };
        },
      })
      .then((value) => {
        settled = true;
        return value;
      });
    await enteredGate;
    expect(settled).toBe(false);
    release();
    await expect(pending).resolves.toEqual(messageOutput("после"));
  });

  it("still discards a refused body taken from response.output", async () => {
    const transport = projecting([
      created("resp_live_refused"),
      completedFromOutput(
        [messageItem(JSON.stringify({ output: messageOutput("нельзя") }))],
        "resp_live_refused",
      ),
    ]);
    await expect(
      new OpenAiResponseGenerator(transport.client, MODEL).respond(providerRequest(), {
        async onResponseCreated() {
          return { accepted: false };
        },
      }),
    ).rejects.toBeInstanceOf(OpenAiGenerationTransportError);
    expect(transport.calls).toHaveLength(1);
    expect(transport.aborted()).toBe(true);
    expect(transport.retrieves()).toBe(0);
  });
});

describe("RIM_OUTPUT_FORMAT", () => {
  it("is a strict object envelope with MESSAGE and BAN_PROPOSALS under output", () => {
    expect(RIM_OUTPUT_FORMAT.type).toBe("json_schema");
    expect(RIM_OUTPUT_FORMAT.name).toBe("rim_ai_output");
    expect(RIM_OUTPUT_FORMAT.strict).toBe(true);
    expect(RIM_OUTPUT_FORMAT.schema.type).toBe("object");
    expect(RIM_OUTPUT_FORMAT.schema).not.toHaveProperty("anyOf");
    expect(RIM_OUTPUT_FORMAT.schema.additionalProperties).toBe(false);
    expect(RIM_OUTPUT_FORMAT.schema.required).toEqual(["output"]);

    const message = RIM_OUTPUT_FORMAT.schema.properties.output.anyOf[0];
    const ban = RIM_OUTPUT_FORMAT.schema.properties.output.anyOf[1];
    expect(message.required).toEqual(["type", "text"]);
    expect(message.additionalProperties).toBe(false);
    expect(message.properties.type.enum).toEqual(["MESSAGE"]);
    expect(ban.required).toEqual(["type", "message", "proposals"]);
    expect(ban.additionalProperties).toBe(false);
    expect(ban.properties.type.enum).toEqual(["BAN_PROPOSALS"]);
    expect(ban.properties.proposals.minItems).toBe(3);
    expect(ban.properties.proposals.maxItems).toBe(3);
    expect(ban.properties.proposals.items.required).toEqual(["banText", "executionProbability"]);
    expect(ban.properties.proposals.items.additionalProperties).toBe(false);
    expect(ban.properties.proposals.items.properties.executionProbability.minimum).toBe(0);
    expect(ban.properties.proposals.items.properties.executionProbability.maximum).toBe(1);

    const encoded = JSON.stringify(RIM_OUTPUT_FORMAT);
    expect(encoded).not.toContain("duration");
    expect(encoded).not.toContain("proposalId");
  });
});
