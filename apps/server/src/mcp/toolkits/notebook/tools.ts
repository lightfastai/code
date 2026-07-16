import {
  ArtifactPublishError,
  NotebookAgentExecuteAllInput,
  NotebookAgentExecuteCellInput,
  NotebookAgentExecutionResult,
  NotebookAgentToolError,
  PublishNotebookArtifactInput,
  PublishNotebookArtifactResult,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as ServerConfig from "../../../config.ts";
import { NotebookRevisionStore } from "../../../notebook/NotebookRevisionStore.ts";
import { NotebookRuntimeManagerService } from "../../../notebook/NotebookRuntimeManager.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";

const sharedDependencies = [
  McpInvocationContext.McpInvocationContext,
  NotebookRevisionStore,
  ProjectionSnapshotQuery,
];

export const PublishNotebookArtifactTool = Tool.make("artifact_publish_notebook", {
  description:
    "Publish an exact immutable notebook revision into this conversation. This does not execute code and remains available when agent notebook execution is disabled.",
  parameters: PublishNotebookArtifactInput,
  success: PublishNotebookArtifactResult,
  failure: ArtifactPublishError,
  dependencies: [...sharedDependencies, OrchestrationEngineService],
})
  .annotate(Tool.Title, "Publish notebook")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const executionDependencies = [
  ...sharedDependencies,
  NotebookRuntimeManagerService,
  ServerConfig.ServerConfig,
  FileSystem.FileSystem,
  Path.Path,
  McpSessionRegistry.McpSessionRegistry,
];

export const ExecuteNotebookCellTool = Tool.make("notebook_execute_cell", {
  description:
    "Execute one code cell from an exact immutable notebook revision in an isolated local runtime. Requires the explicit notebook execution grant for this thread.",
  parameters: NotebookAgentExecuteCellInput,
  success: NotebookAgentExecutionResult,
  failure: NotebookAgentToolError,
  dependencies: executionDependencies,
})
  .annotate(Tool.Title, "Execute notebook cell")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ExecuteNotebookAllTool = Tool.make("notebook_execute_all", {
  description:
    "Execute every code cell, in document order, from an exact immutable notebook revision in an isolated local runtime. Requires the explicit notebook execution grant for this thread.",
  parameters: NotebookAgentExecuteAllInput,
  success: NotebookAgentExecutionResult,
  failure: NotebookAgentToolError,
  dependencies: executionDependencies,
})
  .annotate(Tool.Title, "Execute all notebook cells")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const NotebookToolkit = Toolkit.make(
  PublishNotebookArtifactTool,
  ExecuteNotebookCellTool,
  ExecuteNotebookAllTool,
);
