/**
 * v1.4.3 — query-document hygiene.
 *
 * The Unraid GraphQL endpoint rejects `/* ... *​/` block comments inside a
 * query DOCUMENT with a parse error (HTTP 400, GRAPHQL_PARSE_FAILED): the
 * GraphQL spec only defines `#` line comments. METRICS_QUERY carried one
 * Dutch block comment since v1.3.20 and the cpu/memory/network section has
 * been silently unavailable ever since (SectionProvider logged nothing;
 * the 400 only surfaced as `reason` in the API payload). Any query editor
 * must keep explanatory text in JS comments OUTSIDE the template literal
 * or use `#` inside it — this test pins that for every exported document.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  ARRAY_QUERY,
  CONNECTION_PING_QUERY,
  DETAIL_QUERY,
  DOCKER_QUERY,
  DOCKER_STATE_QUERY,
  IDENTITY_QUERY,
  LOG_FILE_QUERY,
  LOG_FILES_QUERY,
  METRICS_QUERY,
  NETWORK_INTERFACES_QUERY,
  NOTIFICATIONS_LIST_QUERY,
  NOTIFICATIONS_SUMMARY_QUERY,
  SYSTEM_QUERY,
  TEMPERATURE_QUERY,
  VMS_QUERY,
} from "../src/server/unraid/queries";

const QUERIES: Record<string, string> = {
  IDENTITY_QUERY,
  METRICS_QUERY,
  TEMPERATURE_QUERY,
  SYSTEM_QUERY,
  ARRAY_QUERY,
  DOCKER_QUERY,
  NOTIFICATIONS_SUMMARY_QUERY,
  NOTIFICATIONS_LIST_QUERY,
  VMS_QUERY,
  NETWORK_INTERFACES_QUERY,
  DETAIL_QUERY,
  CONNECTION_PING_QUERY,
  LOG_FILES_QUERY,
  LOG_FILE_QUERY,
  DOCKER_STATE_QUERY,
};

describe("v1.4.3: Unraid GraphQL documents never contain block comments", () => {
  test("every exported query document is free of /* */ (the API 400s on them)", () => {
    for (const [name, query] of Object.entries(QUERIES)) {
      assert.ok(!query.includes("/*"), `${name} must not contain a /* block comment — the Unraid API rejects the document with GRAPHQL_PARSE_FAILED (HTTP 400)`);
    }
  });

  test("METRICS_QUERY is the exact document that failed in production — pinned", () => {
    assert.ok(METRICS_QUERY.includes("query Metrics"));
    assert.ok(!METRICS_QUERY.includes("sensoren verhuisd"));
  });

  test("source-level: every template literal in queries.ts is comment-free", () => {
    const source = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), "../src/server/unraid/queries.ts"),
      "utf8",
    );
    const templates = source.match(/`[^`]*`/g) ?? [];
    const documents = templates.filter((block) => /query\s+\w+[\s(]/.test(block));
    assert.ok(documents.length >= Object.keys(QUERIES).length, "all query templates detected");
    for (const block of documents) {
      assert.ok(!block.includes("/*"), `query template contains a block comment: ${block.slice(0, 60)}…`);
    }
  });
});
