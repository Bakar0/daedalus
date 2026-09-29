/**
 * Who each bot is dressed as. Daedalus built the labyrinth, so the workshop
 * is staffed from the same myths. The pick is stable per session: an agent
 * keeps its costume for as long as it lives, and two agents may share one,
 * which is better than a costume changing when somebody else leaves.
 */

export type PersonaId =
  | "daedalus"
  | "icarus"
  | "hermes"
  | "athena"
  | "zeus"
  | "poseidon"
  | "hephaestus"
  | "apollo"
  | "artemis"
  | "hades"
  | "medusa"
  | "heracles"
  | "odysseus"
  | "minotaur"
  | "ariadne"
  | "prometheus";

export interface Persona {
  id: PersonaId;
  name: string;
  /** Finishes "as Hermes, …" on the hover card. */
  epithet: string;
}

export const PERSONAS: readonly Persona[] = [
  { id: "daedalus", name: "Daedalus", epithet: "master inventor" },
  { id: "icarus", name: "Icarus", epithet: "who flew too close to the sun" },
  { id: "hermes", name: "Hermes", epithet: "messenger of the gods" },
  { id: "athena", name: "Athena", epithet: "goddess of wisdom" },
  { id: "zeus", name: "Zeus", epithet: "king of the gods" },
  { id: "poseidon", name: "Poseidon", epithet: "lord of the sea" },
  { id: "hephaestus", name: "Hephaestus", epithet: "smith of the gods" },
  { id: "apollo", name: "Apollo", epithet: "god of the sun and music" },
  { id: "artemis", name: "Artemis", epithet: "goddess of the hunt" },
  { id: "hades", name: "Hades", epithet: "lord of the underworld" },
  { id: "medusa", name: "Medusa", epithet: "the gorgon" },
  { id: "heracles", name: "Heracles", epithet: "the strongest hero" },
  { id: "odysseus", name: "Odysseus", epithet: "the cunning voyager" },
  { id: "minotaur", name: "Minotaur", epithet: "keeper of the labyrinth" },
  { id: "ariadne", name: "Ariadne", epithet: "keeper of the thread" },
  { id: "prometheus", name: "Prometheus", epithet: "bringer of fire" },
];

/** FNV-1a: stable, cheap, and well spread over short ids. */
export function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1)
    result = Math.imul(result ^ value.charCodeAt(index), 16777619) >>> 0;
  return result;
}

export function personaFor(sessionId: string): Persona {
  // Salted, so the costume does not follow the same bits as skin and hair.
  return PERSONAS[hash(`persona:${sessionId}`) % PERSONAS.length]!;
}

export const personaById = (id: PersonaId): Persona =>
  PERSONAS.find((persona) => persona.id === id)!;
