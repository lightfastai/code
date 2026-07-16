import type { EnvironmentId, StudyDocument } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { BookOpenIcon, CheckIcon, RefreshCwIcon } from "lucide-react";

import { studyEnvironment } from "../../state/study";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { cn } from "~/lib/utils";

function formatLabel(format: StudyDocument["format"]): string {
  return format === "markdown" ? "MD" : format.toUpperCase();
}

export function ComposerStudyLibraryPicker({
  environmentId,
  selected,
  compact,
  disabled,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly selected: ReadonlyArray<StudyDocument>;
  readonly compact: boolean;
  readonly disabled?: boolean;
  readonly onChange: (documents: ReadonlyArray<StudyDocument>) => void;
}) {
  const [filter, setFilter] = useState("");
  const library = useEnvironmentQuery(studyEnvironment.library({ environmentId, input: {} }));
  const selectedIds = useMemo(() => new Set(selected.map((document) => document.id)), [selected]);
  const documents = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (!library.data || query.length === 0) return library.data ?? [];
    return library.data.filter((document) =>
      [document.title, document.fileName, ...document.tags]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [filter, library.data]);

  const toggle = (document: StudyDocument) => {
    onChange(
      selectedIds.has(document.id)
        ? selected.filter((selectedDocument) => selectedDocument.id !== document.id)
        : [...selected, document],
    );
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            className={cn(
              "shrink-0 gap-1.5 px-2 text-muted-foreground/70 hover:text-foreground/80",
              selected.length > 0 && "bg-violet-500/10 text-violet-500 hover:bg-violet-500/15",
              !compact && "sm:px-3",
            )}
            aria-label="Choose study books"
          />
        }
      >
        <BookOpenIcon className="size-4" />
        <span className={compact ? "sr-only" : "hidden sm:inline"}>Books</span>
        {selected.length > 0 ? (
          <span className="min-w-4 rounded-full bg-current/10 px-1 text-center text-[10px] font-semibold">
            {selected.length}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={8}
        className="w-[min(24rem,calc(100vw-1rem))]"
        viewportClassName="p-0"
      >
        <div className="border-b border-border/70 p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold">Study library</p>
              <p className="text-xs text-muted-foreground">
                Pin books as grounding scope for this conversation.
              </p>
            </div>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh study library"
              onClick={library.refresh}
            >
              <RefreshCwIcon className={cn("size-3.5", library.isPending && "animate-spin")} />
            </Button>
          </div>
          <div className="relative mt-3">
            <Input
              nativeInput
              type="search"
              size="sm"
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value)}
              placeholder="Search titles or tags"
              aria-label="Search study library"
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto p-1.5">
          {library.error ? (
            <div className="p-3 text-sm text-destructive">{library.error}</div>
          ) : library.isPending && library.data === null ? (
            <div className="p-3 text-sm text-muted-foreground">Loading library…</div>
          ) : documents.length === 0 ? (
            <div className="p-4 text-center">
              <p className="text-sm font-medium">
                {library.data?.length === 0 ? "No books imported yet" : "No matching books"}
              </p>
              {library.data?.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Import with{" "}
                  <code className="rounded bg-muted px-1">t3 study import &lt;file&gt;</code>.
                </p>
              ) : null}
            </div>
          ) : (
            documents.map((document) => {
              const isSelected = selectedIds.has(document.id);
              return (
                <button
                  key={document.id}
                  type="button"
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isSelected && "bg-violet-500/8",
                  )}
                  onClick={() => toggle(document)}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
                      isSelected
                        ? "border-violet-500 bg-violet-500 text-white"
                        : "border-input bg-background",
                    )}
                  >
                    {isSelected ? <CheckIcon className="size-3" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{document.title}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                      <span>{formatLabel(document.format)}</span>
                      {document.tags.slice(0, 3).map((tag) => (
                        <span key={tag} className="rounded bg-muted px-1">
                          {tag}
                        </span>
                      ))}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
