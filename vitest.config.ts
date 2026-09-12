import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    typecheck: {
      enabled: true,
      include: ["packages/**/*.test-d.ts"],
      tsconfig: "./tsconfig.json",
    },
  },
});
