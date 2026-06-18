/**
 * Redaction wiring. Mirrors PluginOptions hide-flags into the environment
 * variables that @arizeai/openinference-core reads, so any code paths using
 * OITracer also honor them. See DESIGN.md §6.7.
 */
import type { ResolvedConfig } from "./config.js";

export function applyRedactionEnv(config: ResolvedConfig): void {
  const map: Record<string, boolean> = {
    OPENINFERENCE_HIDE_INPUTS: config.hideInputs,
    OPENINFERENCE_HIDE_OUTPUTS: config.hideOutputs,
    OPENINFERENCE_HIDE_INPUT_MESSAGES: config.hideInputMessages,
    OPENINFERENCE_HIDE_OUTPUT_MESSAGES: config.hideOutputMessages,
  };
  for (const [key, on] of Object.entries(map)) {
    if (on && process.env[key] === undefined) {
      process.env[key] = "true";
    }
  }
}
