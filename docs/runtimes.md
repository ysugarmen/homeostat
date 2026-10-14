# Claude runtimes

The curator and the deep dive call Claude. `agents.runtime` in `homeostat.yaml` picks how, which decides where review comments go and whose contract covers them. The plugin, hooks and MCP server never call a model, whatever the runtime.

| Runtime | Where prompts go | Credentials | Use it when |
| --- | --- | --- | --- |
| `api` (default) | Anthropic's Claude API | `ANTHROPIC_API_KEY` (a Console key) | Most teams. API data is not used for training by default; zero data retention is available on request. |
| `bedrock` | Claude in Amazon Bedrock, inside your AWS account | The AWS credential chain: an IAM role in CI (OIDC), SSO, or `AWS_*` variables | Data must stay inside your AWS boundary and contracts. |
| `vertex` | Claude on Google Cloud (Agent Platform), inside your project | Application Default Credentials: workload identity federation in CI, or `gcloud auth application-default login` | Data must stay inside your Google Cloud boundary. |
| `claude-code` | Whatever Claude Code is logged in to | A Claude Code login | Personal use, or a Team/Enterprise plan. A personal subscription is for non-commercial use only. |

## Cloud setup

```yaml
agents:
  runtime: bedrock
  bedrock:
    region: eu-west-1        # optional; else AWS_REGION
```

```yaml
agents:
  runtime: vertex
  vertex:
    projectId: my-project    # else ANTHROPIC_VERTEX_PROJECT_ID
    region: eu               # global (default), us, eu, or a region
```

Model names stay as they are (`claude-opus-5-5`); on Bedrock the `anthropic.` prefix is added for you, and a full inference-profile ARN is passed through unchanged.

The cloud SDKs are optional, so teams on the default runtime don't install the AWS or Google libraries. Add the SDK to the CI command:

```sh
npx --yes -p homeostat@<version> -p @anthropic-ai/bedrock-sdk@0.34 homeostat curate
npx --yes -p homeostat@<version> -p @anthropic-ai/vertex-sdk@0.20 homeostat curate
```

Give the CI identity only what it needs: on AWS, `bedrock-mantle:CreateInference` on the model ARNs you use; on Google Cloud, the Vertex AI User role on the project. Prefer federated identities (GitHub OIDC to an IAM role or to workload identity) over stored keys.

## Differences on the clouds

- Neither cloud supports the server-side refusal fallback, so it is not sent; a refused thread is skipped and the run continues.
- Bedrock's Messages endpoint has no structured outputs, so on both clouds the answer comes back as one forced tool call whose input is checked against the same schema.
- Every model call is logged locally as a `model-call` event with its runtime, model and size, never its content.
