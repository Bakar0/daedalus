import { themeIcons } from "seti-icons";

// VS Code's own colours for the Seti icon theme (extensions/theme-seti, MIT),
// so files look as they do in VS Code's default theme.
const setiIcon = themeIcons({
  blue: "#519aba",
  grey: "#4d5a5e",
  "grey-light": "#6d8086",
  green: "#8dc149",
  orange: "#e37933",
  pink: "#f55385",
  purple: "#a074c4",
  red: "#cc3e44",
  white: "#d4d7d6",
  yellow: "#cbcb41",
  ignore: "#41535b",
});

const cache = new Map<string, { svg: string; color: string }>();

const iconFor = (name: string) => {
  let icon = cache.get(name);
  if (!icon) {
    icon = setiIcon(name);
    cache.set(name, icon);
  }
  return icon;
};

/**
 * A file's Seti icon, chosen by its name as VS Code chooses it (a full name
 * like `Dockerfile` first, then the extension). The SVG comes from the
 * package, not from anything a user or agent wrote.
 */
export function FileTypeIcon({ name }: { name: string }) {
  const { svg, color } = iconFor(name);
  return (
    <span
      aria-hidden="true"
      className="file-type-icon"
      dangerouslySetInnerHTML={{ __html: svg }}
      style={{ color }}
    />
  );
}
