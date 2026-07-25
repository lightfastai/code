import { notebookArtifactDefinition } from "./contracts.ts";

export {
  boundedNotebookText,
  planNotebookOutputRendering,
  planNotebookTableRendering,
} from "./notebook-output-rendering.ts";
export { sanitizeNotebookSvg } from "./notebook-sanitize.ts";

export const notebookMobileCapability = {
  name: "lightfast.notebook",
  artifactDefinition: notebookArtifactDefinition,
  presentation: {
    description: "Interactive notebook · run securely on your paired Mac",
  },
} as const;
