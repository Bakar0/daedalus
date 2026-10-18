/**
 * A compact whole-percent field for the rebirth thresholds. It keeps what the
 * user types as a draft and saves on Enter or blur, so a half-typed value
 * such as the 7 of 75 is not refused and snapped back on the way.
 */
import { useEffect, useState } from "react";

export function PercentInput({
  label,
  value,
  min = 10,
  max = 100,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, Math.round(parsed)));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <span className="percent-input">
      <input
        aria-label={label}
        disabled={disabled}
        inputMode="numeric"
        onBlur={commit}
        onChange={(event) =>
          setDraft(event.target.value.replace(/[^\d]/g, "").slice(0, 3))
        }
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            // Steps of 5, and kept from a menu's own arrow-key moves.
            event.preventDefault();
            event.stopPropagation();
            const step = event.key === "ArrowUp" ? 5 : -5;
            const next = Math.min(max, Math.max(min, value + step));
            if (next !== value) onCommit(next);
          } else if (event.key === "Home" || event.key === "End") {
            event.stopPropagation();
          }
        }}
        type="text"
        value={draft}
      />
      %
    </span>
  );
}
