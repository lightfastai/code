# Lightfast pending tasks after the core cutoff

This is the handoff for the core-testable prototype slice. Items marked complete are part of that
slice; unchecked work is deferred parity, polish, validation, or integration work rather than a
claim that the core is blocked.

## Core-shippable slice

- [x] **Upstream boundary classification fix — complete.** The finding-local boundary audit is
      clean; retain the classification when adding future bridge files.
- [x] **Provider-generation correlation fix — complete.** The upstream provider-generation
      correlation is covered in the accepted core baseline; do not regress it while resolving broader
      integration work.
- [x] **Mobile notebook core renderer — complete for the testable slice.** It loads cached
      revisions, exposes per-cell edit/run plus interrupt/restart/reconnect/save/revision controls,
      keeps selected books read-only, and bounds text, table, PNG, and sanitized SVG output.
- [x] **Voice scene lifecycle — complete for the testable slice.** A natural LiveKit disconnect
      clears the live semantic scene and a later room accepts a fresh generation; see the local
      [operator and test runbook](./local-testing.md#livekit-voice-and-semantic-3d-scenes).

## Next few days: validation and local tooling

- [ ] **Owner: mobile/native maintainer — validate the notebook renderer on a real iPad.** Pair
      the device with a Mac running the server and Docker runtime; accept only after the complete
      checklist in the [iPad runbook](./local-testing.md#expo-and-ipad) passes, including offline and
      reconnect mutation locks.
- [ ] **Owner: native terminal maintainer — unblock a full iOS simulator build.** The current
      build reaches native compilation and then fails emitting the pre-existing `T3TerminalNative`
      Swift module (`SwiftEmitModule` / `EmitSwiftModule`). Re-run the iOS development-client path
      after that module is repaired; until then, use public Expo config and prebuild as the reliable
      local native checks.
- [ ] **Owner: native CI maintainer — make optional native linters available.** `vp run lint:mobile`
      passes its static checks, but SwiftLint, ktlint, and detekt were unavailable locally and skipped.
      Install or provision them in a reproducible developer/CI image, then record their actual output.
- [ ] **Owner: web maintainer — resolve or explicitly waive validation noise.** `vp check` still
      reports nine pre-existing web `react(no-unstable-nested-components)` warnings. Preserve the
      warning count while unrelated work proceeds; create targeted fixes or an approved waiver before
      release hardening.
- [ ] **Owner: package and desktop maintainers — triage the current typecheck advisories.**
      `vp run typecheck` passes, with non-blocking `tsgo` suggestions in
      `packages/client-runtime/src/relay/discovery.ts` (`TS377019`) and
      `apps/desktop/src/backend/DesktopBackendPool.test.ts` (`TS377017`) plus
      `apps/desktop/src/wsl/DesktopWslEnvironment.ts` (`TS377047`). Keep these advisory-only until
      an owner either applies the suggested Effect refactor or records a reason to retain it.
- [ ] **Owner: release maintainer — re-run the core gates on the merge candidate.** Require
      `vp check`, `vp run typecheck`, `vp run lint:mobile`, and `vp test`; use `vp run test` only for a
      deliberate recursive package-script run. Follow the exact Docker, voice, study, and mobile
      commands in the [operator runbook](./local-testing.md).

## Next few days: mobile notebook parity and polish

These are intentionally outside the core renderer. They are concrete gaps in the current native
card, which presently offers per-cell source editing and Run but not the following UI workflows.

- [ ] **Owner: mobile notebook maintainer — add/remove/reorder/duplicate cells.** Preserve stable
      cell IDs, immutable revisions, and offline/pending mutation locks; acceptance includes native
      interaction tests for each operation.
- [ ] **Owner: mobile notebook maintainer — add Run Above and Run All.** Keep execution ordering,
      interruption, per-cell state, and the existing server resource limits explicit; acceptance proves
      no execution starts while the paired Mac is unavailable.
- [ ] **Owner: mobile notebook maintainer — expose import/export and revision comparison
      workflows.** The controller has import/export seams, but the current card does not expose those
      flows. Maintain immutable revision selection and do not widen selected-book scope.
- [ ] **Owner: mobile notebook maintainer — improve plot/output parity deliberately.** Current
      native rendering supports bounded text/JSON/tables, PNG, and sanitized SVG, while HTML,
      JavaScript, and unsupported active MIME remain inert fallbacks. Define safe, bounded plot formats
      with web parity tests before rendering anything richer.

## Future artifact parity

- [ ] **Owner: artifact/mobile maintainer — decide the mobile handoff for rich interactive
      artifacts.** Until an audited native renderer exists, keep full interactive 3D and any other
      richer artifact experience on the paired Mac/web handoff rather than embedding an executable
      payload in the iPad client. Acceptance requires an explicit capability matrix, safe fallback,
      and real-device coverage.

## Integration process debt

- [ ] **Owner: maintainers, before merging `main` — make the broad prototype decision explicit.**
      This branch intentionally spans upstream automation, notebook/runtime, mobile canvas, voice,
      artifacts, study, and orchestration. Either approve it as one atomic prototype baseline or split
      follow-up integration through non-rewriting cherry-picks or stacked pull requests. Never rewrite
      published history. This choice does not relax tests, capability boundaries, or ownership checks.
