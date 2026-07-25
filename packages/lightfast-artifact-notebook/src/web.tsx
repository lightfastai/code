import type { ArtifactEnvelope } from "@t3tools/lightfast-capability-core/artifacts";
import { createContext, type ComponentType, type ReactNode, use } from "react";

import { notebookArtifactDefinition } from "./contracts.ts";

export { NotebookCell, notebookOutputKey, type NotebookCellProps } from "./NotebookCell.tsx";
export { NotebookMarkdown, NotebookOutput } from "./NotebookOutput.tsx";
export {
  NOTEBOOK_OUTPUT_RENDER_MAX_BYTES_PER_CELL,
  NOTEBOOK_OUTPUT_RENDER_MAX_BYTES_PER_SESSION,
  NOTEBOOK_OUTPUT_RENDER_MAX_CHARACTERS,
  NOTEBOOK_OUTPUT_RENDER_MAX_ENTRIES_PER_CELL,
  NOTEBOOK_OUTPUT_RENDER_MAX_ENTRIES_PER_SESSION,
  NOTEBOOK_OUTPUT_RENDER_MAX_LINES,
  NOTEBOOK_TABLE_RENDER_MAX_CELLS,
  NOTEBOOK_TABLE_RENDER_MAX_CELLS_PER_SESSION,
  NOTEBOOK_TABLE_RENDER_MAX_COLUMNS,
  NOTEBOOK_TABLE_RENDER_MAX_ROWS,
  boundedNotebookText,
  planNotebookOutputRendering,
  type NotebookOutputRenderInput,
  type NotebookOutputRenderPlan,
  type NotebookOutputRetentionNotice,
} from "./notebook-output-rendering.ts";
export { sanitizeNotebookSvg } from "./notebook-sanitize.ts";
export {
  isNotebookExecutionDisabled,
  isNotebookRevisionSwitchDisabled,
} from "./runtime-lifecycle.ts";
export type {
  NotebookAgentExecutionPermission,
  NotebookArtifactController,
  NotebookProjectScope,
  NotebookRuntimeView,
} from "./runtime-lifecycle.ts";
import type {
  NotebookAgentExecutionPermission,
  NotebookArtifactController,
  NotebookProjectScope,
} from "./runtime-lifecycle.ts";

export type NotebookWebBindings = {
  readonly scope: NotebookProjectScope;
  readonly controller: NotebookArtifactController;
  readonly agentExecutionPermission: NotebookAgentExecutionPermission;
};

const NotebookWebContext = createContext<NotebookWebBindings | null>(null);

export function NotebookWebProvider({
  bindings,
  children,
}: {
  readonly bindings: NotebookWebBindings | null;
  readonly children: ReactNode;
}) {
  return <NotebookWebContext value={bindings}>{children}</NotebookWebContext>;
}

export function useNotebookWebBindings(): NotebookWebBindings | null {
  return use(NotebookWebContext);
}

type ArtifactRenderer = ComponentType<{ readonly artifact: ArtifactEnvelope }>;

const loadNotebookEnvelopeRenderer = (): Promise<{ readonly default: ArtifactRenderer }> =>
  import("./web-renderer.tsx").then((module) => ({
    default: module.NotebookArtifactEnvelopeRenderer as ArtifactRenderer,
  }));

export const notebookWebCapability = {
  artifactDefinition: notebookArtifactDefinition,
  loadRenderer: loadNotebookEnvelopeRenderer,
} as const;
