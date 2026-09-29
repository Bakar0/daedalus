/**
 * Every character style in every state, animated, for choosing a look.
 * One row per style and provider; one column per state. `?theme=light`
 * shows the light appearance. Nothing here is used by the app.
 */
import { Application, Container, Graphics, Text } from "pixi.js";

// Kept for a check to read: a throw inside a Pixi tick stops the ticker for
// good, so the first one is the one that matters.
const errors: string[] = [];
(window as unknown as { __errors: string[] }).__errors = errors;
window.addEventListener("error", (event) =>
  errors.push(`${event.message} ${event.error?.stack ?? ""}`),
);
import { WORLD_CHARACTERS } from "./world/characters";
import { createBot } from "./world/characters/bots";
import { PERSONAS } from "./world/characters/personas";
import type { WorldActor } from "./world/world-model";
import type { ActorFigure, WorldLook } from "./world/world-theme";

const COLUMNS: Array<{
  title: string;
  actor: Partial<WorldActor>;
  walking?: boolean;
}> = [
  { title: "reading", actor: { mood: "working", place: "read" } },
  { title: "editing", actor: { mood: "working", place: "edit" } },
  { title: "shell", actor: { mood: "working", place: "run" } },
  { title: "git push", actor: { mood: "working", place: "ship" } },
  { title: "web", actor: { mood: "working", place: "web" } },
  { title: "subagent", actor: { mood: "working", place: "delegate" } },
  { title: "planning", actor: { mood: "working", place: "plan" } },
  { title: "thinking", actor: { mood: "working", place: "think" } },
  {
    title: "walking",
    actor: { mood: "working", place: "edit" },
    walking: true,
  },
  {
    title: "needs permission",
    actor: { mood: "attention", label: "needs permission", place: "ship" },
  },
  {
    title: "needs input",
    actor: { mood: "attention", label: "needs input", place: "think" },
  },
  { title: "idle", actor: { mood: "idle", place: "lounge" } },
  { title: "done", actor: { mood: "done", place: "lounge" } },
  { title: "error", actor: { mood: "error", place: "run" } },
  { title: "lost", actor: { mood: "lost", place: "door" } },
];
const PROVIDERS = ["claude", "codex"] as const;
const CELL_W = 96;
const CELL_H = 110;
const LABEL_W = 110;

const params = new URLSearchParams(location.search);
// `?only=chibi` shows one style; `?wrap=5` puts five states on a line, for a
// closer look.
const only = params.get("only");
const wrap = Number(params.get("wrap")) || COLUMNS.length;
const styles = WORLD_CHARACTERS.filter(
  (character) => !only || character.id === only,
);
const lines = Math.ceil(COLUMNS.length / wrap);
const appearance: WorldLook["appearance"] =
  new URLSearchParams(location.search).get("theme") === "light"
    ? "light"
    : "dark";
const look: WorldLook = { appearance };
const ink = appearance === "dark" ? 0xeff4fc : 0x111a2f;
const muted = appearance === "dark" ? 0x8491a9 : 0x5d6b84;

const app = new Application();
await app.init({
  antialias: true,
  autoDensity: true,
  background: appearance === "dark" ? 0x0b1020 : 0xe9eef6,
  preference: "webgl",
  resizeTo: document.getElementById("root")!,
  resolution: window.devicePixelRatio || 1,
});
document.getElementById("root")!.append(app.canvas);

const sheet = new Container();
app.stage.addChild(sheet);
const label = (value: string, size: number, fill: number) =>
  new Text({
    text: value,
    resolution: 3,
    style: {
      fill,
      fontSize: size,
      fontWeight: "600",
      fontFamily: "-apple-system, sans-serif",
      align: "center",
      wordWrap: true,
      wordWrapWidth: CELL_W - 8,
    },
  });

// `?personas` shows every bot costume instead, each cycling through the
// states so one screen shows how a costume reads in all of them.
const personaMode = params.has("personas");
const CYCLE: Array<{
  label: string;
  actor: Partial<WorldActor>;
  walking?: boolean;
}> = [
  { label: "working", actor: { mood: "working", place: "edit" } },
  { label: "walking", actor: { mood: "working", place: "run" }, walking: true },
  {
    label: "needs you",
    actor: { mood: "attention", label: "needs permission" },
  },
  { label: "idle", actor: { mood: "idle", place: "lounge" } },
  { label: "done", actor: { mood: "done", place: "lounge" } },
  { label: "error", actor: { mood: "error", place: "run" } },
];
const cycling: Array<{ figure: ActorFigure; actor: WorldActor }> = [];

// Each style and provider gets a band; a band holds `lines` rows of states,
// each state titled above its figure.
const figures: Array<{ figure: ActorFigure; walking: boolean }> = [];
const bandHeight = lines * CELL_H;
let band = 0;
if (personaMode) {
  const perRow = 8;
  PERSONAS.forEach((persona, index) => {
    for (const [side, provider] of PROVIDERS.entries()) {
      const slot = index * 2 + side;
      const x = LABEL_W / 2 + (slot % perRow) * CELL_W + CELL_W / 2;
      const y = 30 + Math.floor(slot / perRow) * (CELL_H + 18);
      const title = label(persona.name, 11, ink);
      title.anchor.set(0.5, 0);
      title.position.set(x, y + CELL_H + 2);
      sheet.addChild(title);
      const actor: WorldActor = {
        sessionId: `${persona.id}-${provider}`,
        zoneId: "gallery",
        name: provider === "claude" ? "Claude" : "Codex",
        provider,
        taskLabel: null,
        mood: "working",
        label: "working",
        place: "edit",
        detail: null,
        since: null,
        unconfirmed: false,
        contextPercent: null,
        model: null,
      };
      const figure = createBot(actor, look, persona);
      figure.update(actor);
      figure.view.position.set(x, y + CELL_H - 22);
      sheet.addChild(figure.view);
      cycling.push({ figure, actor });
    }
  });
  band = Math.ceil((PERSONAS.length * 2) / perRow);
}
for (const character of personaMode ? [] : styles) {
  for (const provider of PROVIDERS) {
    const top = band * (bandHeight + 8);
    sheet.addChild(
      new Graphics()
        .roundRect(4, top, LABEL_W + wrap * CELL_W - 4, bandHeight, 10)
        .fill({
          color: appearance === "dark" ? 0xffffff : 0x000000,
          alpha: band % 2 ? 0.03 : 0.06,
        }),
    );
    const name = label(`${character.label}\n${provider}`, 13, ink);
    name.position.set(14, top + bandHeight / 2 - 16);
    sheet.addChild(name);
    COLUMNS.forEach((column, index) => {
      const x = LABEL_W + (index % wrap) * CELL_W + CELL_W / 2;
      const y = top + Math.floor(index / wrap) * CELL_H;
      const title = label(column.title, 10, muted);
      title.anchor.set(0.5, 0);
      title.position.set(x, y + 4);
      sheet.addChild(title);
      const actor: WorldActor = {
        sessionId: `${character.id}-${provider}-${index}-${band}`,
        zoneId: "gallery",
        name: provider === "claude" ? "Claude" : "Codex",
        provider,
        taskLabel: null,
        mood: "working",
        label: "working",
        place: "edit",
        detail: null,
        since: null,
        unconfirmed: false,
        contextPercent: null,
        model: null,
        ...column.actor,
      };
      const figure = character.create(actor, look);
      figure.update(actor);
      figure.view.position.set(x, y + CELL_H - 22);
      sheet.addChild(figure.view);
      figures.push({ figure, walking: column.walking ?? false });
    });
    band += 1;
  }
}

const fit = () => {
  const width = personaMode
    ? LABEL_W + 8 * CELL_W
    : LABEL_W + wrap * CELL_W + 8;
  const height = personaMode
    ? 30 + band * (CELL_H + 18) + 8
    : band * (bandHeight + 8);
  const scale = Math.min(app.screen.width / width, app.screen.height / height);
  sheet.scale.set(scale);
  sheet.position.set(
    (app.screen.width - width * scale) / 2,
    (app.screen.height - height * scale) / 2,
  );
};
fit();
app.renderer.on("resize", fit);

let time = 0;
app.ticker.maxFPS = 30;
const stateLabel = new Text({
  text: "",
  resolution: 3,
  style: {
    fill: muted,
    fontSize: 14,
    fontWeight: "600",
    fontFamily: "-apple-system, sans-serif",
  },
});
stateLabel.position.set(12, 8);
if (personaMode) app.stage.addChild(stateLabel);
let shown = -1;
app.ticker.add((ticker) => {
  time += ticker.deltaMS / 1000;
  if (personaMode) {
    // `?state=2` holds one state instead of cycling.
    const held = params.get("state");
    const index =
      held === null
        ? Math.floor(time / 3) % CYCLE.length
        : Number(held) % CYCLE.length;
    const beat = CYCLE[index]!;
    if (index !== shown) {
      shown = index;
      stateLabel.text = `Every costume, now: ${beat.label}`;
      for (const item of cycling) {
        item.actor = { ...item.actor, ...beat.actor } as WorldActor;
        item.figure.update(item.actor);
      }
    }
    for (const item of cycling)
      item.figure.animate({
        time,
        walking: beat.walking ?? false,
        facing: beat.walking ? 1 : 0,
      });
    return;
  }
  for (const { figure, walking } of figures)
    figure.animate({ time, walking, facing: walking ? 1 : 0 });
});
(window as unknown as { __gallery: boolean }).__gallery = true;
(window as unknown as { __app: Application }).__app = app;
(window as unknown as { __cycling: typeof cycling }).__cycling = cycling;
