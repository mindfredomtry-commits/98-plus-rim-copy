import type { ProviderResponseId, RetrievedProviderStatus } from "./rim-provider-runtime.ts";

/**
 * A retrieved provider operation. Distinct from submitting a USER turn.
 * `output` is present only when the provider returned a completed body.
 * Status alone is not a body.
 */
export type RimProviderRetrieval = Readonly<{
  responseId: ProviderResponseId;
  providerStatus: RetrievedProviderStatus;
  output?: unknown;
}>;

/** Retrieves one already-known provider Response. It must not submit USER input. */
export type RimProviderRetrievalPort = {
  retrieve(responseId: ProviderResponseId): Promise<RimProviderRetrieval | null>;
};
