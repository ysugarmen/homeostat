import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * One structured question to Claude: the reply is validated against `schema`. Null when Claude
 * declines or the reply does not fit. Implemented by the API runtime and the Claude Code runtime.
 */
export type Asker = <S extends z.ZodType>(
  system: string,
  user: string,
  schema: S,
) => Promise<z.infer<S> | null>;

/** Claude could not be reached or refused the credentials; the agent run cannot continue. */
export class ClaudeUnavailableError extends Error {}

/** The part of the Anthropic client the API runtime uses, so tests can pass a stub. */
export type ClaudeClient = Pick<Anthropic, "beta">;

export interface ApiAskerOptions {
  model: string;
  effort: Effort;
  /** Defaults to a client built from `env`. */
  client?: ClaudeClient;
  /**
   * Where to read ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN. When given, only these are used, so
   * a caller's environment (or a test's empty one) is never bypassed. Defaults to the SDK's own.
   */
  env?: Readonly<Record<string, string | undefined>>;
}

// The SDK reports missing credentials with a plain Error, so match its message.
const isMissingCredentials = (e: unknown) =>
  e instanceof Error && e.message.startsWith("Could not resolve authentication method");

/**
 * The API runtime: the Messages API through @anthropic-ai/sdk, billed per use to a Claude
 * Console key. Uses structured outputs and the server-side refusal fallback.
 */
export function apiAsker(opts: ApiAskerOptions): Asker {
  let client = opts.client;
  return async (system, user, schema) => {
    client ??= opts.env
      ? new Anthropic({
          apiKey: opts.env.ANTHROPIC_API_KEY || null,
          authToken: opts.env.ANTHROPIC_AUTH_TOKEN || null,
        })
      : new Anthropic();
    let response: Awaited<ReturnType<ClaudeClient["beta"]["messages"]["parse"]>>;
    try {
      response = await client.beta.messages.parse({
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
          "no usable Claude API credentials: set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN), or use agents.runtime: claude-code",
        );
      }
      if (e instanceof Anthropic.APIError) {
        throw new ClaudeUnavailableError(`Claude API error ${e.status ?? ""}: ${e.message}`.trim());
      }
      throw e;
    }
    if (response.stop_reason === "refusal") return null;
    const parsed = schema.safeParse(response.parsed_output);
    return parsed.success ? parsed.data : null;
  };
}
