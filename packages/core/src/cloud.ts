import { z } from "zod";
import { type Asker, ClaudeUnavailableError, type Effort } from "./claude.ts";

/**
 * Claude through the team's own cloud account, so prompts stay inside its contracts and region
 * (security plan T5/T6). Structured outputs are not available on Bedrock's Messages endpoint, so
 * both clouds get their JSON the same way: one forced tool call whose input is the schema.
 * Neither cloud supports the server-side refusal fallback, so it is not sent.
 */

/** The slice of a cloud client this runtime uses, so tests can pass a stub. */
export interface CloudClient {
  messages: {
    create(body: Record<string, unknown>): Promise<{
      stop_reason: string | null;
      content: { type: string; name?: string; input?: unknown }[];
    }>;
  };
}

export interface CloudAskerOptions {
  model: string;
  effort: Effort;
  /** Bedrock: an AWS region (else AWS_REGION). Vertex: `global`, `us`, `eu` or a region. */
  region?: string;
  /** Vertex only: the Google Cloud project (else ANTHROPIC_VERTEX_PROJECT_ID). */
  projectId?: string;
  /** Defaults to the SDK client, loaded only when this runtime is used. */
  client?: CloudClient;
}

const TOOL = "answer";

/** Bedrock's Messages endpoint names models with an `anthropic.` prefix. */
export function bedrockModelId(model: string): string {
  return model.startsWith("anthropic.") || model.includes(":") ? model : `anthropic.${model}`;
}

async function load<T>(pkg: string, runtime: string, make: (mod: any) => T): Promise<T> {
  try {
    return make(await import(pkg));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      throw new ClaudeUnavailableError(
        `agents.runtime: ${runtime} needs ${pkg}; install it next to homeostat (npx -p homeostat -p ${pkg} homeostat ...)`,
      );
    }
    throw e;
  }
}

function cloudAsker(
  runtime: "bedrock" | "vertex",
  model: string,
  opts: CloudAskerOptions,
  makeClient: () => Promise<CloudClient>,
): Asker {
  let client = opts.client;
  return async (system, user, schema) => {
    client ??= await makeClient();
    let response: Awaited<ReturnType<CloudClient["messages"]["create"]>>;
    try {
      response = await client.messages.create({
        model,
        max_tokens: 16000,
        output_config: { effort: opts.effort },
        system,
        tools: [
          {
            name: TOOL,
            description: "Give your answer. Call this exactly once.",
            input_schema: z.toJSONSchema(schema, { io: "input" }),
          },
        ],
        tool_choice: { type: "tool", name: TOOL },
        messages: [{ role: "user", content: user }],
      });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 403) {
        throw new ClaudeUnavailableError(
          `${runtime} refused the credentials (${status}): check the cloud identity the agent runs as and its model access`,
        );
      }
      if (status !== undefined) {
        throw new ClaudeUnavailableError(`${runtime} error ${status}: ${(e as Error).message}`);
      }
      throw e;
    }
    if (response.stop_reason === "refusal") return null;
    const call = response.content.find((b) => b.type === "tool_use" && b.name === TOOL);
    const parsed = schema.safeParse(call?.input);
    return parsed.success ? parsed.data : null;
  };
}

/** Claude in Amazon Bedrock (the Messages endpoint), signed with the AWS credential chain. */
export function bedrockAsker(opts: CloudAskerOptions): Asker {
  return cloudAsker("bedrock", bedrockModelId(opts.model), opts, () =>
    load("@anthropic-ai/bedrock-sdk", "bedrock", (m) => {
      return new m.AnthropicBedrockMantle(opts.region ? { awsRegion: opts.region } : {});
    }),
  );
}

/** Claude on Google Cloud's Agent Platform (Vertex AI), with Application Default Credentials. */
export function vertexAsker(opts: CloudAskerOptions): Asker {
  return cloudAsker("vertex", opts.model, opts, () =>
    load("@anthropic-ai/vertex-sdk", "vertex", (m) => {
      return new m.AnthropicVertex({
        region: opts.region ?? "global",
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
      });
    }),
  );
}
