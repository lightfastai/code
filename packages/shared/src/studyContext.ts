import type {
  SelectedStudyDocumentIds,
  StudyContextCapsule,
  StudyDocument,
  StudyDocumentId,
} from "@t3tools/contracts";

export function normalizeStudyDocumentIds(
  documentIds: ReadonlyArray<StudyDocumentId>,
): SelectedStudyDocumentIds {
  return Array.from(new Set(documentIds)).sort();
}

export function selectedStudyDocumentIds(
  documents: ReadonlyArray<StudyDocument>,
): SelectedStudyDocumentIds {
  return normalizeStudyDocumentIds(documents.map((document) => document.id));
}

export function narrowStudyDocumentIds(
  authority: ReadonlyArray<StudyDocumentId>,
  requested: ReadonlyArray<StudyDocumentId>,
): SelectedStudyDocumentIds | null {
  const normalizedAuthority = normalizeStudyDocumentIds(authority);
  const normalizedRequested = normalizeStudyDocumentIds(requested);
  const allowed = new Set(normalizedAuthority);
  return normalizedRequested.every((documentId) => allowed.has(documentId))
    ? normalizedRequested
    : null;
}

export function appendStudyDocumentsToPrompt(
  prompt: string,
  documents: ReadonlyArray<StudyDocument>,
): string {
  if (documents.length === 0) return prompt;

  const scope = documents.map((document) => ({
    documentId: document.id,
    title: document.title,
    format: document.format,
    tags: document.tags,
  }));
  const block = [
    '<study_context version="1">',
    JSON.stringify({ selectedDocuments: scope }),
    "Ground book-specific claims with study_library_search scoped to these documentIds. Preserve the returned page, spine, or heading anchors in the answer.",
    "</study_context>",
  ].join("\n");

  return prompt.trim().length > 0 ? `${prompt}\n\n${block}` : block;
}

export function appendStudyContextCapsulesToPrompt(
  prompt: string,
  capsules: ReadonlyArray<StudyContextCapsule>,
): string {
  if (capsules.length === 0) return prompt;

  const block = [
    '<study_context_capsules version="1">',
    JSON.stringify({ capsules }),
    "Treat canvas-region selections as the exact area the student is asking about. A matching snapshot image is attached when snapshotName is present. Ground book-specific claims with study_library_search using the separately selected document scope.",
    "</study_context_capsules>",
  ].join("\n");

  return prompt.trim().length > 0 ? `${prompt}\n\n${block}` : block;
}
