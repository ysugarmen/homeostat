import { describe, expect, test } from "vitest";
import { docTopic, estimate, existingDocs } from "../src/bootstrap.ts";
import { DATA_FILES, INFRA_FILES, isSecretManifest, snapshotRepo } from "../src/seed.ts";

const TOKEN = ["ghp_", "Z".repeat(18), "y".repeat(18)].join("");

describe("existingDocs", () => {
  test("picks docs, agent notes, ADRs and READMEs; leaves out changelogs and vendored files", () => {
    const tracked = [
      "README.md",
      "CLAUDE.md",
      "docs/setup.md",
      "docs/adr/0001-queues.md",
      "services/api/README.md",
      "CHANGELOG.md",
      "node_modules/x/README.md",
      ".github/PULL_REQUEST_TEMPLATE.md",
      "terraform/secrets/README.md",
      "src/index.ts",
    ];
    expect(existingDocs(tracked, [])).toEqual([
      "CLAUDE.md",
      "README.md",
      "docs/setup.md",
      "docs/adr/0001-queues.md",
      "services/api/README.md",
    ]);
    expect(existingDocs(tracked, ["docs/**"])).not.toContain("docs/setup.md");
  });

  test("names each document after its path", () => {
    expect(docTopic("docs/setup.md")).toBe("setup");
    expect(docTopic("services/api/README.md")).toBe("services-api-readme");
  });
});

describe("data and infrastructure pickers", () => {
  const files: Record<string, string> = {
    "db/migrations/0001_init.sql": "CREATE TABLE users (id int);",
    "db/migrations/0002_orders.sql": "CREATE TABLE orders (id int);",
    "app/alembic/versions/a1_add_x.py": "def upgrade(): ...",
    "app/alembic/versions/b2_add_y.py": "def upgrade(): ...",
    "app/sql/mappers/users.py": "users = Table('users', metadata, Column('id'))",
    "app/sql/mappers/helpers.py": "def helper(): return 1",
    "tests/models/test_users.py": "class User: __tablename__ = 'users'",
    "charts/api/Chart.yaml": "name: api",
    "charts/api/values.yaml": "replicas: 2",
    "k8s/creds.yaml": "apiVersion: v1\nkind: Secret\ndata:\n  x: eA==",
    "charts/dev.yaml": `a: ${TOKEN}\nb: ${TOKEN}x\npassword: hunter2hunter2\nc: ${TOKEN}y`,
    "infra/prod.tfstate": "{}",
    ".env.production": "X=1",
  };
  const tracked = Object.keys(files);
  const read = (p: string) => files[p];

  test("data reads migrations from every history and tables found by their text", () => {
    const s = snapshotRepo("app", tracked, read, [], DATA_FILES);
    const paths = s.files.map((f) => f.path);
    expect(paths).toContain("app/sql/mappers/users.py");
    expect(paths).not.toContain("app/sql/mappers/helpers.py");
    expect(paths).not.toContain("tests/models/test_users.py");
    expect(paths).toEqual(
      expect.arrayContaining(["db/migrations/0002_orders.sql", "app/alembic/versions/b2_add_y.py"]),
    );
    // Newest first, one folder after the other.
    expect(paths.indexOf("app/alembic/versions/b2_add_y.py")).toBeLessThan(
      paths.indexOf("db/migrations/0001_init.sql"),
    );
  });

  test("infrastructure never reads state, env files, Secret manifests or files full of secrets", () => {
    const s = snapshotRepo("app", tracked, read, [], INFRA_FILES);
    const paths = s.files.map((f) => f.path);
    expect(paths).toEqual(["charts/api/Chart.yaml", "charts/api/values.yaml"]);
    expect(s.skipped).toBe(2);
    expect(s.paths).not.toContain("infra/prod.tfstate");
    expect(s.paths).not.toContain(".env.production");
    expect(isSecretManifest("kind: SealedSecret")).toBe(true);
    expect(isSecretManifest("kind: Deployment")).toBe(false);
  });

  test("CI pipelines get a larger limit than other manifests", () => {
    const big = {
      "bitbucket-pipelines.yml": `steps:\n${"  - step: x\n".repeat(2_000)}`,
      "charts/a/values.yaml": "x: 1\n".repeat(3_000),
    };
    const s = snapshotRepo(
      "app",
      Object.keys(big),
      (p) => big[p as keyof typeof big],
      [],
      INFRA_FILES,
    );
    const len = (p: string) => s.files.find((f) => f.path === p)?.text.length ?? 0;
    expect(len("bitbucket-pipelines.yml")).toBeGreaterThan(20_000);
    expect(len("charts/a/values.yaml")).toBeLessThan(7_000);
  });

  test("estimates tokens and cost by model family", () => {
    const snapshot = snapshotRepo("app", tracked, read, [], DATA_FILES);
    const e = estimate([{ snapshot, topic: "data" }], "claude-sonnet-5-5");
    expect(e.inputTokens).toBeGreaterThan(100);
    expect(e.outputTokens).toBe(2_500);
    expect(e.dollars).toBeGreaterThan(0);
    expect(estimate([{ snapshot, topic: "data" }], "some-other-model").dollars).toBeUndefined();
  });
});
