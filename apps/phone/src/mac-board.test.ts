import { expect, test } from "bun:test";
import {
  DESKTOP_CSS,
  PHONE_CSS,
  phoneBoardCss,
} from "../../../scripts/phone-board-css";

test("the phone's copy of the Mac's board styles is current", async () => {
  const expected = phoneBoardCss(await Bun.file(DESKTOP_CSS).text());
  // Stale: run `bun run scripts/phone-board-css.ts`.
  expect(await Bun.file(PHONE_CSS).text()).toBe(expected);
});
