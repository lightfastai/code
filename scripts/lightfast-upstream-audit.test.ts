// @effect-diagnostics nodeBuiltinImport:off - This test reads the workflow fixture before an Effect runtime exists.
import * as NodeFS from "node:fs";

import { assert, it } from "@effect/vitest";
import { parseDocument } from "yaml";

import policyJson from "../config/lightfast-upstream-boundary.json" with { type: "json" };
import { auditUpstreamDiff, parseUpstreamBoundaryPolicy } from "./lightfast-upstream-audit.ts";

const policy = parseUpstreamBoundaryPolicy(policyJson);
const upstreamSyncWorkflow = NodeFS.readFileSync(
  new URL("../.github/workflows/lightfast-upstream-sync.yml", import.meta.url),
  "utf8",
);

it("classifies Lightfast-owned paths, bridges, shared manifests, and unexpected edits", () => {
  const report = auditUpstreamDiff(
    [
      "apps/web/src/components/ChatView.tsx",
      "packages/lightfast-capability-core/src/registry.ts",
      "apps/web/src/lightfast/register.tsx",
      "apps/server/package.json",
      "pnpm-lock.yaml",
      "apps/voice-agent/src/index.ts",
    ],
    policy,
  );

  assert.deepStrictEqual(report, {
    lightfastOwned: [
      "apps/voice-agent/src/index.ts",
      "packages/lightfast-capability-core/src/registry.ts",
    ],
    bridges: ["apps/web/src/lightfast/register.tsx"],
    sharedSurfaces: ["apps/server/package.json", "pnpm-lock.yaml"],
    unexpected: ["apps/web/src/components/ChatView.tsx"],
  });
});

it("normalizes, de-duplicates, and sorts paths while preserving bridge precedence", () => {
  const report = auditUpstreamDiff(
    [
      "./apps/server/src/lightfast/register.ts",
      "apps\\server\\src\\lightfast\\register.ts",
      "docs/lightfast/upstream-sync.md",
      "apps/notebook-runtime/package.json",
    ],
    policy,
  );

  assert.deepStrictEqual(report, {
    lightfastOwned: ["apps/notebook-runtime/package.json", "docs/lightfast/upstream-sync.md"],
    bridges: ["apps/server/src/lightfast/register.ts"],
    sharedSurfaces: [],
    unexpected: [],
  });
});

it("refreshes only repository-owned integration branches without rewriting their tips", () => {
  assert.lengthOf(parseDocument(upstreamSyncWorkflow).errors, 0);
  assert.include(upstreamSyncWorkflow, "--limit 100");
  assert.include(upstreamSyncWorkflow, "--json number,headRefName,isCrossRepository,updatedAt");
  assert.include(upstreamSyncWorkflow, "select(.isCrossRepository == false");
  assert.include(upstreamSyncWorkflow, "sort_by(.updatedAt) | reverse");
  assert.include(
    upstreamSyncWorkflow,
    'git fetch --no-tags origin "+refs/heads/$branch:refs/remotes/origin/$branch"',
  );
  assert.include(upstreamSyncWorkflow, 'git switch --force-create "$branch" "origin/$branch"');
  assert.notInclude(upstreamSyncWorkflow, "--force-with-lease");
  assert.include(upstreamSyncWorkflow, 'git push origin "HEAD:refs/heads/$BRANCH"');
});

it("continues a repeated semantic-conflict refresh when the brief is unchanged", () => {
  assert.include(
    upstreamSyncWorkflow,
    `          git add -- "$brief"
          set +e
          git diff --cached --quiet -- "$brief"
          brief_diff_exit=$?
          set -e
          if [[ "$brief_diff_exit" -eq 1 ]]; then
            git commit -m "docs: record upstream merge conflicts for $sync_date"
          elif [[ "$brief_diff_exit" -ne 0 ]]; then
            exit "$brief_diff_exit"
          fi
          echo "outcome=conflict" >> "$GITHUB_OUTPUT"
          echo "conflict_brief=$brief" >> "$GITHUB_OUTPUT"`,
  );
});
