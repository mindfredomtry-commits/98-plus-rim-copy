import { startApiProcess } from "./start.ts";

try {
  await startApiProcess({ env: process.env, handleSignals: true });
} catch (error) {
  const message = error instanceof Error ? error.message : "startup failed";
  process.stderr.write(`startup failed: ${message}\n`);
  process.exit(1);
}
