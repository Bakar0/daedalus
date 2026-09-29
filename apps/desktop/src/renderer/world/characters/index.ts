import type { WorldCharacter } from "../world-theme";
import { botsCharacter } from "./bots";
import { chibiCharacter } from "./chibi";
import { crittersCharacter } from "./critters";
import { pixelCharacter } from "./pixel";

/**
 * Every character style the picker offers. Adding one is a file in this
 * directory implementing `WorldCharacter` and a line here.
 */
// Bots first: the user's pick, and the default.
export const WORLD_CHARACTERS: readonly WorldCharacter[] = [
  botsCharacter,
  chibiCharacter,
  crittersCharacter,
  pixelCharacter,
];

export const DEFAULT_WORLD_CHARACTER_ID = botsCharacter.id;

export const worldCharacterById = (
  id: string | null | undefined,
): WorldCharacter =>
  WORLD_CHARACTERS.find((character) => character.id === id) ??
  WORLD_CHARACTERS.find(
    (character) => character.id === DEFAULT_WORLD_CHARACTER_ID,
  )!;
