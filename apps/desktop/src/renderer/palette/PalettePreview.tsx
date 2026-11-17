/**
 * The palette's right pane: for a file, a content match or a plan, the lines
 * of the file (around the match, which is marked); for anything else, what
 * the row is. Lines are asked for a moment after the highlight settles, so
 * holding an arrow key does not read every file on the way.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { SearchPreviewDto } from "@daedalus/protocol";
import type { PaletteRow } from "./CommandPalette";
import { highlightRanges, KIND_LABELS } from "./palette-model";
import type { PaletteSearchSource } from "./use-palette-search";

const PREVIEW_DELAY_MS = 60;

/** `text` with the ranges wrapped in <mark>. */
export function Highlighted({
  text,
  ranges,
}: {
  text: string;
  ranges: readonly (readonly [number, number])[];
}) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], index) => {
    if (start < at || start >= text.length) return;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={index}>{text.slice(start, end)}</mark>);
    at = end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

export function PalettePreview({
  row,
  query,
  source,
}: {
  row: PaletteRow | undefined;
  query: string;
  source: PaletteSearchSource | undefined;
}) {
  const target = row?.preview;
  const key = target ? `${target.path}:${target.line ?? ""}` : "";
  const cache = useRef(new Map<string, SearchPreviewDto | null>());
  const [shown, setShown] = useState<{
    key: string;
    preview: SearchPreviewDto | null;
  }>();

  useEffect(() => {
    if (!target || !source) return;
    const cached = cache.current.get(key);
    if (cached !== undefined) {
      setShown({ key, preview: cached });
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      source.preview(target.path, target.line).then(
        (preview) => {
          cache.current.set(key, preview);
          if (live) setShown({ key, preview });
        },
        () => {
          cache.current.set(key, null);
          if (live) setShown({ key, preview: null });
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `target` is read through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, source]);

  if (!row) return <aside aria-hidden="true" className="palette-preview" />;
  if (!target)
    return (
      <aside aria-hidden="true" className="palette-preview">
        <div className="palette-preview-path">{KIND_LABELS[row.kind]}</div>
        <div className="palette-preview-title">{row.title}</div>
        {row.subtitle && (
          <div className="palette-preview-detail">{row.subtitle}</div>
        )}
      </aside>
    );
  const preview = shown?.key === key ? shown.preview : undefined;
  const text = query.trim();
  return (
    <aside aria-hidden="true" className="palette-preview">
      <div className="palette-preview-path">
        {target.path}
        {target.line ? `:${target.line}` : ""}
      </div>
      {preview === null && (
        <div className="palette-preview-detail">No preview.</div>
      )}
      {preview && preview.lines.length === 0 && (
        <div className="palette-preview-detail">Not a text file.</div>
      )}
      {preview && (
        <div className="palette-preview-lines">
          {preview.lines.map((line, index) => {
            const number = preview.start + index;
            return (
              <div
                className="palette-preview-line"
                data-on={number === target.line ? "true" : undefined}
                key={number}
              >
                <span className="palette-preview-number">{number}</span>
                <span className="palette-preview-text">
                  <Highlighted
                    ranges={text ? highlightRanges(text, line, false) : []}
                    text={line}
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
