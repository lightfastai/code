#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off - This single-shot repository audit runs directly as a Node CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface UpstreamBoundaryPolicy {
  readonly lightfastOwnedPrefixes: readonly string[];
  readonly bridgePaths: readonly string[];
  readonly sharedSurfacePaths: readonly string[];
  readonly sharedSurfacePrefixes: readonly string[];
  readonly sharedSurfaceSuffixes: readonly string[];
}

export interface UpstreamDiffReport {
  readonly lightfastOwned: readonly string[];
  readonly bridges: readonly string[];
  readonly sharedSurfaces: readonly string[];
  readonly unexpected: readonly string[];
}

const normalizePath = (path: string): string => path.replaceAll("\\", "/").replace(/^\.\//, "");

const matchesAnyPrefix = (path: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => path.startsWith(prefix));

const matchesAnySuffix = (path: string, suffixes: readonly string[]): boolean =>
  suffixes.some((suffix) => path.endsWith(suffix));

export function auditUpstreamDiff(
  paths: readonly string[],
  policy: UpstreamBoundaryPolicy,
): UpstreamDiffReport {
  const report: {
    lightfastOwned: string[];
    bridges: string[];
    sharedSurfaces: string[];
    unexpected: string[];
  } = {
    lightfastOwned: [],
    bridges: [],
    sharedSurfaces: [],
    unexpected: [],
  };
  const bridgePaths = new Set(policy.bridgePaths.map(normalizePath));
  const sharedSurfacePaths = new Set(policy.sharedSurfacePaths.map(normalizePath));

  for (const path of new Set(paths.map(normalizePath).filter(Boolean))) {
    if (bridgePaths.has(path)) {
      report.bridges.push(path);
    } else if (matchesAnyPrefix(path, policy.lightfastOwnedPrefixes)) {
      report.lightfastOwned.push(path);
    } else if (
      sharedSurfacePaths.has(path) ||
      matchesAnyPrefix(path, policy.sharedSurfacePrefixes) ||
      matchesAnySuffix(path, policy.sharedSurfaceSuffixes)
    ) {
      report.sharedSurfaces.push(path);
    } else {
      report.unexpected.push(path);
    }
  }

  report.lightfastOwned.sort();
  report.bridges.sort();
  report.sharedSurfaces.sort();
  report.unexpected.sort();

  return report;
}

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);

const readStringArray = (candidate: Record<string, unknown>, key: string): readonly string[] => {
  const value = candidate[key];
  if (!isStringArray(value)) {
    throw new Error(`Upstream boundary policy field '${key}' must be an array of strings.`);
  }
  return value;
};

export function parseUpstreamBoundaryPolicy(value: unknown): UpstreamBoundaryPolicy {
  if (typeof value !== "object" || value === null) {
    throw new Error("Upstream boundary policy must be a JSON object.");
  }

  const candidate = value as Record<string, unknown>;

  return {
    lightfastOwnedPrefixes: readStringArray(candidate, "lightfastOwnedPrefixes"),
    bridgePaths: readStringArray(candidate, "bridgePaths"),
    sharedSurfacePaths: readStringArray(candidate, "sharedSurfacePaths"),
    sharedSurfacePrefixes: readStringArray(candidate, "sharedSurfacePrefixes"),
    sharedSurfaceSuffixes: readStringArray(candidate, "sharedSurfaceSuffixes"),
  };
}

interface AuditArguments {
  readonly base: string;
  readonly head: string;
}

const parseArguments = (arguments_: readonly string[]): AuditArguments => {
  let base: string | undefined;
  let head: string | undefined;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];

    if ((argument === "--base" || argument === "--head") && value) {
      if (argument === "--base") base = value;
      else head = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown or incomplete argument: ${argument ?? ""}`);
  }

  if (!base || !head) {
    throw new Error("Usage: node scripts/lightfast-upstream-audit.ts --base <ref> --head <ref>");
  }

  return { base, head };
};

const main = (): void => {
  const { base, head } = parseArguments(process.argv.slice(2));
  const policyPath = NodeURL.fileURLToPath(
    new URL("../config/lightfast-upstream-boundary.json", import.meta.url),
  );
  const policy = parseUpstreamBoundaryPolicy(JSON.parse(NodeFS.readFileSync(policyPath, "utf8")));
  const output = NodeChildProcess.execFileSync(
    "git",
    ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", `${base}...${head}`],
    { encoding: "utf8" },
  );
  const report = auditUpstreamDiff(output.split("\0"), policy);

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.unexpected.length > 0) {
    process.stderr.write(
      `Upstream boundary audit found ${report.unexpected.length} unexpected path(s).\n`,
    );
    process.exitCode = 1;
  }
};

const isDirectExecution =
  process.argv[1] !== undefined &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1]);

if (isDirectExecution) {
  main();
}
