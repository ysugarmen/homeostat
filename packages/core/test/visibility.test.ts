import { describe, expect, test } from "vitest";
import { type Config, parseConfig } from "../src/config.ts";
import { exportable, inRepo, visibleTo } from "../src/visibility.ts";

const config = parseConfig(`version: 1
team:
  members:
    - { id: dana, handle: "@dana", role: senior, areas: [api/payments] }
    - { id: lee, handle: "@lee", role: member, areas: [] }
repos:
  api:
    source: acme/api
    areas:
      payments: ["services/payments/**"]
  worker:
    source: acme/worker
security:
  teamOnlyAreas: [api/payments]
`).config as Config;

const item = (path: string, area: string) => ({ path, frontmatter: { area } });

describe("visibility in a multi-repo KB", () => {
  const shared = item("knowledge/core/a.md", "core");
  const payments = item("knowledge/api/payments/b.md", "payments");
  const worker = item("knowledge/worker/core/c.md", "core");

  test("a repo's session sees shared items and its own repo's", () => {
    expect(inRepo([shared, payments, worker], config, "api")).toEqual([shared, payments]);
    expect(inRepo([shared, payments, worker], config, undefined)).toEqual([shared]);
  });

  test("team-only areas are named <repo>/<area>, and stay with their members", () => {
    expect(visibleTo([shared, payments], config, "dana")).toEqual([shared, payments]);
    expect(visibleTo([shared, payments], config, "lee")).toEqual([shared]);
    expect(exportable([shared, payments], config)).toEqual([shared]);
  });
});
