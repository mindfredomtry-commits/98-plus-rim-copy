/**
 * Shared transport unwrap for a completed Responses body.
 * Generation and retrieval both use this. Application validateRimAiOutput
 * remains the semantic gate. A missing envelope or invalid JSON stays raw.
 */
export function extractRimCandidateFromCompletedText(text: unknown): unknown {
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
