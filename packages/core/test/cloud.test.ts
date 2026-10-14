import { describe, expect, test } from "vitest";
import { z } from "zod";
import { ClaudeUnavailableError } from "../src/claude.ts";
import { bedrockAsker, bedrockModelId, type CloudClient, vertexAsker } from "../src/cloud.ts";

const schema = z.object({ keep: z.boolean(), title: z.string() });

function stub(reply: Awaited<ReturnType<CloudClient["messages"]["create"]>> | Error) {
  const sent: Record<string, unknown>[] = [];
  const client: CloudClient = {
    messages: {
      async create(body) {
        sent.push(body);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
  return { client, sent };
}

const answer = (input: unknown) => ({
  stop_reason: "tool_use",
  content: [{ type: "tool_use", name: "answer", input }],
});

describe.each([
  ["bedrock", bedrockAsker, "anthropic.claude-opus-5-5"],
  ["vertex", vertexAsker, "claude-opus-5-5"],
] as const)("%s runtime (T6)", (_, make, model) => {
  test("forces one tool call with the schema and returns its validated input", async () => {
    const { client, sent } = stub(answer({ keep: true, title: "Use withRetry()" }));
    const ask = make({ model: "claude-opus-5-5", effort: "medium", client });
    expect(await ask("sys", "user", schema)).toEqual({ keep: true, title: "Use withRetry()" });
    expect(sent[0]).toMatchObject({
      model,
      system: "sys",
      output_config: { effort: "medium" },
      tool_choice: { type: "tool", name: "answer" },
      messages: [{ role: "user", content: "user" }],
    });
    const [tool] = sent[0]?.tools as { input_schema: { properties: object } }[];
    expect(Object.keys(tool?.input_schema.properties ?? {})).toEqual(["keep", "title"]);
    // Neither cloud supports the server-side refusal fallback.
    expect(sent[0]).not.toHaveProperty("fallbacks");
  });

  test("null on a refusal or an answer that does not fit the schema", async () => {
    const refused = stub({ stop_reason: "refusal", content: [] });
    expect(
      await make({ model: "m", effort: "low", client: refused.client })("s", "u", schema),
    ).toBeNull();
    const wrong = stub(answer({ keep: "yes" }));
    expect(
      await make({ model: "m", effort: "low", client: wrong.client })("s", "u", schema),
    ).toBeNull();
  });

  test("refused credentials stop the run with a clear error", async () => {
    const { client } = stub(Object.assign(new Error("forbidden"), { status: 403 }));
    const ask = make({ model: "m", effort: "low", client });
    await expect(ask("s", "u", schema)).rejects.toThrow(ClaudeUnavailableError);
  });
});

test("bedrock model ids get the anthropic. prefix unless already qualified", () => {
  expect(bedrockModelId("claude-opus-5-5")).toBe("anthropic.claude-opus-5-5");
  expect(bedrockModelId("anthropic.claude-opus-5-5")).toBe("anthropic.claude-opus-5-5");
  expect(bedrockModelId("arn:aws:bedrock:us-east-1:1:inference-profile/x")).toContain("arn:");
});

test("the real SDK clients load lazily and expose messages.create", async () => {
  const { AnthropicBedrockMantle } = await import("@anthropic-ai/bedrock-sdk");
  const { AnthropicVertex } = await import("@anthropic-ai/vertex-sdk");
  const bedrock = new AnthropicBedrockMantle({ awsRegion: "us-east-1" });
  // A stub auth client: no Google credential lookup in tests.
  const vertex = new AnthropicVertex({
    region: "global",
    projectId: "p",
    authClient: {} as never,
  });
  expect(typeof bedrock.messages.create).toBe("function");
  expect(typeof vertex.messages.create).toBe("function");
});
