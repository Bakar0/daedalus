import type { WorkspaceFileDto } from "@daedalus/protocol";
import { modelUri, monaco } from "./monaco";

/**
 * One open file: the Monaco model holding what the user sees, and the file as
 * it was last read from or written to disk.
 *
 * Documents live outside React on purpose. A trip to the Board unmounts the
 * editor, and in VS Code an unsaved edit and its undo history survive closing
 * the editor's view of it; they survive here because the model does.
 */
export interface OpenDocument {
  readonly workspaceId: string;
  readonly path: string;
  /** The content on disk as of the last read or save. */
  file: WorkspaceFileDto;
  readonly model: monaco.editor.ITextModel;
  /** Monaco's alternative version id at the last read or save. */
  savedVersion: number;
  viewState?: monaco.editor.ICodeEditorViewState | null;
}

const key = (workspaceId: string, path: string) =>
  `${workspaceId}\u0000${path}`;

const documents = new Map<string, OpenDocument>();
const listeners = new Set<() => void>();
let revision = 0;

const notify = () => {
  revision += 1;
  for (const listener of listeners) listener();
};

/** For `useSyncExternalStore`: a number that moves whenever any document's dirty state can have changed. */
export const documentsRevision = () => revision;

export function subscribeDocuments(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getDocument = (workspaceId: string, path: string) =>
  documents.get(key(workspaceId, path));

export const documentsIn = (workspaceId: string) =>
  [...documents.values()].filter((doc) => doc.workspaceId === workspaceId);

/**
 * The alternative version id returns to its old value when an edit is undone,
 * which is how VS Code clears the dirty dot after undoing back to the save.
 */
export const isDirty = (doc: OpenDocument) =>
  doc.model.getAlternativeVersionId() !== doc.savedVersion;

export function openDocument(
  workspaceId: string,
  file: WorkspaceFileDto,
): OpenDocument {
  const existing = getDocument(workspaceId, file.path);
  if (existing) return existing;
  const uri = modelUri(workspaceId, file.path);
  // A model can outlive its document when a rename raced a close; reuse it
  // rather than fail on the duplicate URI.
  const model =
    monaco.editor.getModel(uri) ??
    monaco.editor.createModel(file.content, undefined, uri);
  const doc: OpenDocument = {
    workspaceId,
    path: file.path,
    file,
    model,
    savedVersion: model.getAlternativeVersionId(),
  };
  model.onDidChangeContent(() => notify());
  documents.set(key(workspaceId, file.path), doc);
  notify();
  return doc;
}

/**
 * Records a successful save or a fresh read as the new clean state. `version`
 * is the model version the written content came from, when it was captured
 * before a round trip the user may have typed through.
 */
export function markSaved(
  doc: OpenDocument,
  file: WorkspaceFileDto,
  version = doc.model.getAlternativeVersionId(),
) {
  doc.file = file;
  doc.savedVersion = version;
  notify();
}

/**
 * Takes new content from disk into a clean document. Applied as an edit
 * rather than `setValue`, so the cursor stays put and Cmd+Z can still step
 * back past an agent's rewrite.
 */
export function reloadDocument(doc: OpenDocument, file: WorkspaceFileDto) {
  if (doc.model.getValue() !== file.content)
    doc.model.pushEditOperations(
      [],
      [{ range: doc.model.getFullModelRange(), text: file.content }],
      () => null,
    );
  markSaved(doc, file);
}

export function closeDocument(doc: OpenDocument) {
  documents.delete(key(doc.workspaceId, doc.path));
  doc.model.dispose();
  notify();
}

/**
 * A model's URI is fixed, so a renamed file gets a new model carrying the old
 * one's text. Unsaved edits follow the file; the undo history does not.
 */
export function renameDocument(
  doc: OpenDocument,
  file: WorkspaceFileDto,
): OpenDocument {
  const dirty = isDirty(doc);
  const text = doc.model.getValue();
  closeDocument(doc);
  const moved = openDocument(doc.workspaceId, file);
  if (dirty) moved.model.setValue(text);
  return moved;
}
