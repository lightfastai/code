// @effect-diagnostics nodeBuiltinImport:off - This verifies the checked-in runtime lock bytes.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { expect, it } from "vite-plus/test";

import { NOTEBOOK_RUNTIME_KERNEL_LOCK_HASH } from "./NotebookRuntimeIdentity.ts";

it("pins the notebook kernel identity to the exact runtime uv.lock bytes", async () => {
  const lock = await NodeFSP.readFile(
    new URL("../../../notebook-runtime/uv.lock", import.meta.url),
  );
  expect(NodeCrypto.createHash("sha256").update(lock).digest("hex")).toBe(
    NOTEBOOK_RUNTIME_KERNEL_LOCK_HASH,
  );
});
