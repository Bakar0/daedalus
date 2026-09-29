import type { WorldCharacter } from "../world-theme";
import { botsCharacter } from "./bots";
import { chibiCharacter } from "./chibi";
import { crittersCharacter } from "./critters";
import { pixelCharacter } from "./pixel";

/**
 * Every character style the picker offers. Adding one is a file in this
 * directory implementing `WorldCharacter` and a line here.
 */
export const WORLD_CHARACTERS: readonly WorldCharacter[] = [
  chibiCharacter,
  botsCharacter,
  crittersCharacter,
  pixelCharacter,
];

export const DEFAULT_WORLD_CHARACTER_ID = chibiCharacter.id;

export const worldCharacterById = (
  id: string | null | undefined,
): WorldCharacter =>
  WORLD_CHARACTERS.find((character) => character.id === id) ?? chibiCharacter;
