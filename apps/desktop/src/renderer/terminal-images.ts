import { TERMINAL_IMAGE_TYPES } from "@daedalus/protocol";

/**
 * Images pasted or dropped on a terminal. A terminal sends only text, and
 * ⌘V with only a screenshot on the clipboard sends an empty paste, which
 * Codex ignores. Codex and Claude Code both attach an image when its path is
 * pasted, so the image is saved to a file and its path pasted instead, which
 * is also what a drop from Finder does in Terminal.
 */

/** What a paste or drop carries, as `DataTransfer` gives it. */
export interface TransferLike {
  readonly files: ArrayLike<File>;
  getData(format: string): string;
}

/**
 * The images to save from a paste or a drop, or none when the terminal's
 * own handling is right. A paste with text in it is text: copying from a
 * browser can put an image and its text on the clipboard together.
 */
export function transferImages(
  transfer: TransferLike,
  kind: "paste" | "drop",
): File[] {
  if (kind === "paste" && transfer.getData("text/plain")) return [];
  return Array.from(transfer.files).filter(
    (file) => file.type in TERMINAL_IMAGE_TYPES,
  );
}

/** A path as a shell reads it back, quoted only when it has to be. */
export function shellQuote(path: string): string {
  if (/^[A-Za-z0-9_./@%+=:,-]+$/.test(path)) return path;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** What is pasted for saved images: their paths, a space apart. */
export function pastedImagePaths(paths: readonly string[]): string {
  return paths.map(shellQuote).join(" ");
}

/** A file's bytes in base64, for the request that saves it. */
export async function fileBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}
