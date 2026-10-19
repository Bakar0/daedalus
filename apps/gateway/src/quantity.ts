/** A Kubernetes quantity such as "2", "500m" or "4Gi". */
const QUANTITY = /^(\d+(?:\.\d+)?)(m|k|M|G|T|Ki|Mi|Gi|Ti)?$/;

const FACTOR: Record<string, number> = {
  "": 1,
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
};

/** The quantity's value (cores or bytes), or null when it is not one. */
export function parseQuantity(text: string): number | null {
  const match = QUANTITY.exec(text);
  if (!match) return null;
  return Number(match[1]) * FACTOR[match[2] ?? ""]!;
}
