import { assert, it } from "@effect/vitest";

import policyJson from "../config/lightfast-upstream-boundary.json" with { type: "json" };
import { auditUpstreamDiff, parseUpstreamBoundaryPolicy } from "./lightfast-upstream-audit.ts";

const policy = parseUpstreamBoundaryPolicy(policyJson);

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
