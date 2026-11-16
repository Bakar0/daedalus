/**
 * When the user last pressed a key or a pointer, anywhere in the window. A
 * change that follows one closely is the user's doing, such as a tab picked
 * with a click or a tab-switch key; one with no input behind it is
 * Daedalus's own (a restore at launch, a session the CLI started), and must
 * not move the caret.
 */
let lastInput = 0;
let listening = false;

function listen(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  const mark = () => {
    lastInput = Date.now();
  };
  window.addEventListener("pointerdown", mark, true);
  window.addEventListener("keydown", mark, true);
}

listen();

/** Whether the user pressed something in the last `withinMs`. */
export function byUser(withinMs = 800): boolean {
  listen();
  return Date.now() - lastInput < withinMs;
}
