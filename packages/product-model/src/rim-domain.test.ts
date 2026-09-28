import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  ApplicationProposal,
  RelationshipContextData,
  RimAiResult,
  ThreeSuggestions,
} from "./entities.ts";
import {
  AI_REQUEST_ID,
  CHAT_ID,
  CONTACT_A,
  eventOf,
  kernelContext,
  makeChat,
  pendingAi,
  readyContext,
  withChat,
  withControlState,
} from "./kernel.fixtures.ts";
import { emptySnapshot } from "./kernel/snapshot.ts";
import { reduce } from "./kernel/reduce.ts";
import type { ExecutionProbability, ProposalId } from "./ids.ts";
import {
  isValidExecutionProbability,
  RELATIONSHIP_BAN_LIMIT,
  RIM_SUGGESTION_COUNT,
} from "./primitives.ts";

function suggestion(executionProbability: number) {
  return {
    banText: "no phones",
    executionProbability: executionProbability as ExecutionProbability,
  };
}

const THREE_PROPOSALS: ThreeSuggestions = [suggestion(0), suggestion(0.5), suggestion(1)];

describe("MVP14 Pass 1 canonical RIM domain", () => {
  it("accepts only MESSAGE and BAN_PROPOSALS, with exactly three proposals", () => {
    const message: RimAiResult = { kind: "MESSAGE", text: "ok" };
    const proposals: RimAiResult = {
      kind: "BAN_PROPOSALS",
      message: "three bans",
      proposals: THREE_PROPOSALS,
    };
    expect(message.kind).toBe("MESSAGE");
    expect(proposals.kind).toBe("BAN_PROPOSALS");
    expect(proposals.proposals).toHaveLength(RIM_SUGGESTION_COUNT);
    expect(proposals.proposals).toHaveLength(3);
  });

  it("treats executionProbability as the closed unit interval", () => {
    expect(isValidExecutionProbability(0)).toBe(true);
    expect(isValidExecutionProbability(0.73)).toBe(true);
    expect(isValidExecutionProbability(1)).toBe(true);
    expect(isValidExecutionProbability(-0.01)).toBe(false);
    expect(isValidExecutionProbability(1.01)).toBe(false);
    expect(isValidExecutionProbability(73)).toBe(false);
    expect(isValidExecutionProbability(Number.NaN)).toBe(false);
  });

  it("stores USER-relative RelationshipContextData and caps recent bans at 10", () => {
    const data: RelationshipContextData = {
      aggregates: {
        userToContact: {
          bansSentCount: 1,
          statusCounts: { bantastic: 0, banflict: 1, fairEnough: 0, overboard: 0 },
        },
        contactToUser: {
          bansSentCount: 0,
          statusCounts: { bantastic: 0, banflict: 0, fairEnough: 0, overboard: 0 },
        },
      },
      recentBans: [
        {
          direction: "USER_TO_CONTACT",
          banText: "no phones",
          ageHours: 4,
          result: {
            kind: "CHECK_COMPLETED",
            userAnswer: "FULFILLED",
            contactAnswer: "NOT_FULFILLED",
            status: "BANFLICT",
          },
        },
      ],
    };
    expect(data.aggregates.contactToUser.bansSentCount).toBe(0);
    expect(data.recentBans[0]?.result.kind).toBe("CHECK_COMPLETED");
    expect(data.recentBans.length).toBeLessThanOrEqual(RELATIONSHIP_BAN_LIMIT);
    expect(RELATIONSHIP_BAN_LIMIT).toBe(10);
  });

  it("initializes a normal RimChat with askRimOrigin null", () => {
    expect(makeChat().askRimOrigin).toBeNull();
    const started = reduce(
      withControlState(emptySnapshot(), "RIM.LOBBY"),
      eventOf("RIM.PRESS_START_CHAT", {}),
      kernelContext(),
    );
    expect(started.outcome).toBe("APPLIED");
    expect(started.snapshot.extended.rimChat?.askRimOrigin).toBeNull();
  });

  it("mints proposalIds only inside the canonical BAN_PROPOSALS message", () => {
    const proposal: ApplicationProposal = {
      proposalId: "proposal-1" as ProposalId,
      banText: "no phones",
      executionProbability: 0.73 as ExecutionProbability,
    };
    expect(proposal.proposalId).toBe("proposal-1");
    expect(isValidExecutionProbability(proposal.executionProbability)).toBe(true);
    for (const providerProposal of THREE_PROPOSALS) {
      expect(providerProposal).not.toHaveProperty("proposalId");
    }

    const received = reduce(
      withChat(
        withControlState(emptySnapshot(), "RIM.CHAT"),
        makeChat({
          selectedContactId: CONTACT_A,
          relationshipContext: readyContext(),
          aiOperation: pendingAi(),
        }),
      ),
      eventOf("RIM.AI_RESULT_RECEIVED", {
        rimChatId: CHAT_ID,
        requestId: AI_REQUEST_ID,
        result: { kind: "BAN_PROPOSALS", message: "three bans", proposals: THREE_PROPOSALS },
      }),
      kernelContext(),
    );
    const stored = received.snapshot.extended.rimChat?.messages.at(-1);
    expect(stored?.kind).toBe("BAN_PROPOSALS");
    if (stored?.kind !== "BAN_PROPOSALS") return;
    expect(stored.message).toBe("three bans");
    expect(stored.proposals.map((item) => item.proposalId)).toEqual([
      "proposal-1",
      "proposal-2",
      "proposal-3",
    ]);
    expect(stored.proposals.map((item) => item.banText)).toEqual(
      THREE_PROPOSALS.map((item) => item.banText),
    );
    expect(stored.proposals.map((item) => item.executionProbability)).toEqual(
      THREE_PROPOSALS.map((item) => item.executionProbability),
    );
  });

  it("does not keep legacy RIM field names on the canonical entity model", () => {
    const source = readFileSync(new URL("./entities.ts", import.meta.url), "utf8");
    for (const legacy of [
      "fulfillmentProbability",
      "bantasticPercentage",
      "CONVERSATIONAL",
      "BAN_SUGGESTIONS",
      "recentBansChronological",
    ]) {
      expect(source).not.toContain(legacy);
    }
  });
});
