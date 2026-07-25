import {
  StudyLibraryListInput,
  StudyLibraryListResult,
  StudySearchInput,
  StudySearchResult,
  StudyToolError,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ServerConfig.ServerConfig,
  FileSystem.FileSystem,
  Path.Path,
];

export const StudyLibraryListTool = Tool.make("study_library_list", {
  description:
    "List the user's local PDF, EPUB, and Markdown study library, including exact document ids and tags. Use this before searching when the user names a book ambiguously.",
  parameters: StudyLibraryListInput,
  success: StudyLibraryListResult,
  failure: StudyToolError,
  dependencies,
})
  .annotate(Tool.Title, "List study library")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const StudyLibrarySearchTool = Tool.make("study_library_search", {
  description:
    "Search extracted text from the user's local books and notes. Returns source-grounded excerpts with durable PDF page, EPUB spine, or Markdown heading anchors. Use documentIds or tags to scope a conversation to selected books.",
  parameters: StudySearchInput,
  success: StudySearchResult,
  failure: StudyToolError,
  dependencies,
})
  .annotate(Tool.Title, "Search study library")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const StudyToolkit = Toolkit.make(StudyLibraryListTool, StudyLibrarySearchTool);
