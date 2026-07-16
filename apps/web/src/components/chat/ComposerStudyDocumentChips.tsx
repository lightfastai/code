import type { StudyDocument } from "@t3tools/contracts";
import { BookOpenIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";

export function ComposerStudyDocumentChips({
  documents,
  onRemove,
  className,
}: {
  readonly documents: ReadonlyArray<StudyDocument>;
  readonly onRemove: (documentId: string) => void;
  readonly className?: string;
}) {
  if (documents.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)} aria-label="Selected study books">
      {documents.map((document) => (
        <span
          key={document.id}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-violet-500/20 bg-violet-500/8 px-2 py-1 text-xs text-foreground"
        >
          <BookOpenIcon className="size-3 shrink-0 text-violet-500" />
          <span className="max-w-56 truncate">{document.title}</span>
          <button
            type="button"
            className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Remove ${document.title}`}
            onClick={() => onRemove(document.id)}
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
