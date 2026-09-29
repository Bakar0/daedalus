/**
 * Every character style in every state, animated, for choosing a look.
 * One row per style and provider; one column per state. `?theme=light`
 * shows the light appearance. Nothing here is used by the app.
 */
import { Application, Container, Graphics, Text } from "pixi.js";
import { WORLD_CHARACTERS } from "./world/characters";
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

// Each style and provider gets a band; a band holds `lines` rows of states,
// each state titled above its figure.
const figures: Array<{ figure: ActorFigure; walking: boolean }> = [];
const bandHeight = lines * CELL_H;
let band = 0;
for (const character of styles) {
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
  const width = LABEL_W + wrap * CELL_W + 8;
  const height = band * (bandHeight + 8);
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
app.ticker.add((ticker) => {
  time += ticker.deltaMS / 1000;
  for (const { figure, walking } of figures)
    figure.animate({ time, walking, facing: walking ? 1 : 0 });
});
(window as unknown as { __gallery: boolean }).__gallery = true;
