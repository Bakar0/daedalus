/**
 * The palette's searches that are not in the entry list: the files under
 * the search root (the workspace on screen, or the Daedalus home at Home),
 * the lines inside them, and the plan files among them. Each arrives on its
 * own and shows when it does; there is no spinner. A content search waits a
 * moment after typing stops, and while it runs the previous results that
 * still contain the query stay on screen.
 */
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type {
  SearchContentDto,
  SearchFilesDto,
  SearchPlansDto,
  SearchPreviewDto,
} from "@daedalus/protocol";
import type { PaletteRow } from "./CommandPalette";
import {
  CONTENT_MIN_QUERY,
  highlightRanges,
  type PaletteScope,
  rankFiles,
  type SearchedRows,
} from "./palette-model";

/** What the host offers the palette to search with. */
export interface PaletteSearchSource {
  /** Where the search looks, as the field says it: a workspace, or Home. */
  where: string;
  listFiles(): Promise<SearchFilesDto>;
  /**
   * The lines found for `query` from line `from` on. The host runs one
   * search at a time and stops the previous one when a new query comes.
   */
  searchContent(query: string, from: number): Promise<SearchContentDto>;
  plans(): Promise<SearchPlansDto>;
  preview(path: string, line?: number): Promise<SearchPreviewDto>;
  /** Opens a file under `root` in the editor, at `line` when given. */
  open(root: string, path: string, line?: number): void;
}

/** How long typing must pause before content is searched. */
const CONTENT_DELAY_MS = 120;
/** How many files a scope lists at most. */
const FILE_ROWS = 200;

const split = (path: string) => {
  const slash = path.lastIndexOf("/");
  return {
    name: path.slice(slash + 1),
    folder: slash < 0 ? "" : path.slice(0, slash),
  };
};

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const PLAN_STATE: Record<string, string> = {
  draft: "draft",
  todo: "to do",
  doing: "in progress",
  done: "done",
  blocked: "blocked",
  dropped: "dropped",
};

export interface PaletteSearchResult {
  files: SearchedRows<PaletteRow>;
  content: SearchedRows<PaletteRow>;
  /** Plan files and their tasks, ranked with the other entries. */
  plans: PaletteRow[];
  /** Why content has no rows: no ripgrep, a failure, a short query. */
  contentNote?: string;
  /** How many files the root holds, once listed. */
  fileCount?: number;
  filesTruncated: boolean;
}

export function usePaletteSearch(
  source: PaletteSearchSource | undefined,
  query: string,
  scope: PaletteScope,
): PaletteSearchResult {
  const [files, setFiles] = useState<SearchFilesDto>();
  const [plans, setPlans] = useState<SearchPlansDto>();
  const [content, setContent] = useState<SearchContentDto>();
  const [contentError, setContentError] = useState<string>();

  useEffect(() => {
    if (!source) return;
    let live = true;
    source
      .listFiles()
      .then((list) => live && setFiles(list))
      .catch(() => undefined);
    source
      .plans()
      .then((found) => live && setPlans(found))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [source]);

  const text = query.trim();
  const wantsContent =
    Boolean(source) &&
    (scope === "all" || scope === "content") &&
    text.length >= CONTENT_MIN_QUERY;
  useEffect(() => {
    if (!source || !wantsContent) return;
    let live = true;
    // Lines are asked for again and again while the search runs, each
    // answer adding what ripgrep found since the last.
    const pull = (found: SearchContentDto["matches"]) =>
      source.searchContent(text, found.length).then(
        (slice) => {
          if (!live) return;
          const matches = [...found, ...slice.matches];
          setContent({ ...slice, query: text, matches, from: 0 });
          setContentError(undefined);
          if (!slice.done) void pull(matches);
        },
        (error: unknown) => {
          if (live)
            setContentError(`Content search failed: ${messageOf(error)}`);
        },
      );
    const timer = setTimeout(() => void pull([]), CONTENT_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, text, wantsContent]);

  // Scoring tens of thousands of paths waits for typing, not the other way.
  const fileQuery = useDeferredValue(text);
  const fileRows = useMemo((): SearchedRows<PaletteRow> => {
    if (!source || !files || !fileQuery) return { rows: [], total: 0 };
    const ranked = rankFiles(files.files, fileQuery, FILE_ROWS);
    return {
      rows: ranked.paths.map((path): PaletteRow => {
        const { name, folder } = split(path);
        return {
          key: `search-file:${path}`,
          kind: "file",
          title: name,
          ...(folder ? { subtitle: folder } : {}),
          highlight: highlightRanges(fileQuery, name),
          preview: { path },
          primary: "Open File",
          run: () => source.open(files.root, path),
        };
      }),
      total: ranked.total,
      ...(ranked.best !== undefined ? { best: ranked.best } : {}),
    };
  }, [source, files, fileQuery]);

  const contentRows = useMemo((): SearchedRows<PaletteRow> => {
    if (!source || !content || !wantsContent || content.unavailable)
      return { rows: [], total: 0 };
    const lower = text.toLowerCase();
    // Until the search for this text answers, the last answer's lines that
    // still hold it stand in.
    const matches =
      content.query === text
        ? content.matches
        : content.matches.filter((match) =>
            match.text.toLowerCase().includes(lower),
          );
    const rows = matches.map((match): PaletteRow => ({
      key: `content:${match.path}:${match.line}`,
      kind: "content",
      title: match.text.trim() || match.text,
      subtitle: `${match.path}:${match.line}`,
      highlight: highlightRanges(text, match.text.trim() || match.text, false),
      preview: { path: match.path, line: match.line },
      primary: "Open at Line",
      run: () => source.open(content.root, match.path, match.line),
    }));
    return { rows, total: rows.length };
  }, [source, content, text, wantsContent]);

  const planRows = useMemo((): PaletteRow[] => {
    if (!source || !plans) return [];
    return plans.plans.flatMap((plan): PaletteRow[] => {
      const { folder } = split(plan.path);
      return [
        {
          key: `plan:${plan.path}`,
          kind: "plan",
          title: plan.title,
          subtitle: [
            folder,
            `${plan.done} of ${plan.total} tasks done`,
            plan.owner ? `@${plan.owner}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
          keywords: plan.path,
          preview: { path: plan.path },
          primary: "Open Plan",
          run: () => source.open(plans.root, plan.path),
        },
        ...plan.tasks.map((task): PaletteRow => ({
          key: `plan-task:${plan.path}#${task.key}`,
          kind: "plan-task",
          title: task.title,
          subtitle: [
            `${plan.title} › ${PLAN_STATE[task.state] ?? task.state}`,
            task.owner ? `@${task.owner}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
          preview: { path: plan.path, line: task.line },
          primary: "Open in Plan",
          run: () => source.open(plans.root, plan.path, task.line),
        })),
      ];
    });
  }, [source, plans]);

  const contentNote = !source
    ? undefined
    : (content?.unavailable ??
      contentError ??
      (scope === "content" && text.length < CONTENT_MIN_QUERY
        ? `Type ${CONTENT_MIN_QUERY} characters to search inside files.`
        : undefined));

  return {
    files: fileRows,
    content: contentRows,
    plans: planRows,
    ...(contentNote ? { contentNote } : {}),
    ...(files ? { fileCount: files.files.length } : {}),
    filesTruncated: files?.truncated ?? false,
  };
}
