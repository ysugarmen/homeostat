import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

/** The part of the Anthropic client the agents use, so tests can pass a stub. */
export type ClaudeClient = Pick<Anthropic, "beta">;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeOptions {
  model: string;
  effort: Effort;
  /** Defaults to a client reading ANTHROPIC_API_KEY (or the other standard credentials). */
  client?: ClaudeClient;
}

/**
 * One structured-output call: the reply is parsed against `schema`. Uses the server-side refusal
 * fallback; returns null when the request is still refused or the output does not parse.
 */
export async function askClaude<S extends z.ZodType>(
  opts: ClaudeOptions & { client: ClaudeClient },
  system: string,
  user: string,
  schema: S,
): Promise<z.infer<S> | null> {
  let response: Awaited<ReturnType<ClaudeClient["beta"]["messages"]["parse"]>>;
  try {
    response = await opts.client.beta.messages.parse({
      model: opts.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: opts.effort, format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: "user", content: user }],
    });
  } catch (e) {
    // The SDK has already retried what is retryable; anything left stops the whole run.
    if (e instanceof Anthropic.AuthenticationError || isMissingCredentials(e)) {
      throw new ClaudeUnavailableError(
        "no usable Claude API credentials: set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)",
      );
    }
    if (e instanceof Anthropic.APIError) {
      throw new ClaudeUnavailableError(`Claude API error ${e.status ?? ""}: ${e.message}`.trim());
    }
    throw e;
  }
  if (response.stop_reason === "refusal") return null;
  return (response.parsed_output as z.infer<S> | null | undefined) ?? null;
}

/** Claude could not be reached or refused the credentials; the agent run cannot continue. */
export class ClaudeUnavailableError extends Error {}

// The SDK reports missing credentials with a plain Error, so match its message.
const isMissingCredentials = (e: unknown) =>
  e instanceof Error && e.message.startsWith("Could not resolve authentication method");

export const defaultClient = (client?: ClaudeClient): ClaudeClient => client ?? new Anthropic();
