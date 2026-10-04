/**
 * Strict Structured Output envelope for RIM generation.
 * The root is one object. MESSAGE and BAN_PROPOSALS live under `output`.
 * Application validateRimAiOutput remains the semantic gate.
 */
export const RIM_OUTPUT_FORMAT = {
  type: "json_schema",
  name: "rim_ai_output",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["output"],
    properties: {
      output: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "text"],
            properties: {
              type: { type: "string", enum: ["MESSAGE"] },
              text: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "message", "proposals"],
            properties: {
              type: { type: "string", enum: ["BAN_PROPOSALS"] },
              message: { type: "string" },
              proposals: {
                type: "array",
                minItems: 3,
                maxItems: 3,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["banText", "executionProbability"],
                  properties: {
                    banText: { type: "string" },
                    executionProbability: { type: "number", minimum: 0, maximum: 1 },
                  },
                },
              },
            },
          },
        ],
      },
    },
  },
} as const;
