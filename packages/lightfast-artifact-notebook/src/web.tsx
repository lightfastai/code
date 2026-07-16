import type { ArtifactEnvelope } from "@t3tools/lightfast-capability-core/artifacts";
import { createContext, type ComponentType, type ReactNode, use } from "react";

import {
  type NotebookDocument,
  notebookArtifactDefinition,
  type NotebookOutput,
  type NotebookRevision,
} from "./contracts.ts";

export { NotebookCell, type NotebookCellProps } from "./NotebookCell.tsx";
export { NotebookMarkdown, NotebookOutput } from "./NotebookOutput.tsx";
export { sanitizeNotebookSvg } from "./notebook-sanitize.ts";

export type NotebookProjectScope = {
  readonly environmentId: string;
  readonly projectId: string;
};

export type NotebookRuntimeView = {
  readonly kernelStatus:
    | "disconnected"
    | "starting"
    | "busy"
    | "idle"
    | "interrupted"
    | "restarted"
    | "terminated";
  readonly lastSequence: number;
  readonly recoveryAfterSequence: number | null;
  readonly outputsByCell: ReadonlyMap<string, ReadonlyArray<NotebookOutput>>;
  readonly executionCountByCell: ReadonlyMap<string, number | null>;
  readonly runningCellIds: ReadonlySet<string>;
  readonly error: string | null;
};

export type NotebookAgentExecutionPermission = {
  readonly status: "granted" | "denied" | "unavailable";
  readonly label: string;
  readonly change?: () => void;
};

type RuntimeRequest = {
  readonly scope: NotebookProjectScope;
  readonly sessionId: string;
  readonly onState: (state: NotebookRuntimeView) => void;
};

export interface NotebookArtifactController {
  readonly readRevision: (
    scope: NotebookProjectScope,
    documentId: string,
    revisionId: string,
  ) => Promise<NotebookRevision>;
  readonly saveRevision: (
    scope: NotebookProjectScope,
    documentId: string,
    document: NotebookDocument,
  ) => Promise<NotebookRevision>;
  readonly importRevision: (
    scope: NotebookProjectScope,
    ipynbJson: string,
  ) => Promise<NotebookRevision>;
  readonly exportRevision: (
    scope: NotebookProjectScope,
    documentId: string,
    revisionId: string,
  ) => Promise<{
    readonly fileName: string;
    readonly contentType: string;
    readonly ipynbJson: string;
  }>;
  readonly downloadExport: (file: {
    readonly fileName: string;
    readonly contentType: string;
    readonly ipynbJson: string;
  }) => void;
  readonly connect: (request: RuntimeRequest & { readonly kernelName: string }) => Promise<void>;
  readonly recover: (request: RuntimeRequest) => Promise<void>;
  readonly executeCell: (
    request: RuntimeRequest & { readonly cellId: string; readonly code: string },
  ) => Promise<void>;
  readonly interrupt: (request: RuntimeRequest) => Promise<void>;
  readonly restart: (request: RuntimeRequest) => Promise<void>;
  readonly dispose: (request: RuntimeRequest) => Promise<void>;
  readonly clearError: (request: RuntimeRequest) => void;
}

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
