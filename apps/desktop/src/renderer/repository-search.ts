const boundaryCharacters = new Set(["/", "-", "_", ".", " ", ":"]);

function termScore(query: string, value: string): number | undefined {
  const needle = query.toLowerCase();
  const candidate = value.toLowerCase();
  if (!needle) return 0;
  if (needle === candidate) return 1_000;

  let previousScores = new Array<number>(candidate.length).fill(
    Number.NEGATIVE_INFINITY,
  );
  for (let queryIndex = 0; queryIndex < needle.length; queryIndex += 1) {
    const scores = new Array<number>(candidate.length).fill(
      Number.NEGATIVE_INFINITY,
    );
    for (
      let candidateIndex = 0;
      candidateIndex < candidate.length;
      candidateIndex += 1
    ) {
      if (candidate[candidateIndex] !== needle[queryIndex]) continue;
      const boundary =
        candidateIndex === 0 ||
        boundaryCharacters.has(candidate[candidateIndex - 1] ?? "") ||
        (/[A-Z]/.test(value[candidateIndex] ?? "") &&
          /[a-z]/.test(value[candidateIndex - 1] ?? ""));
      const characterScore = 10 + (boundary ? 18 : 0);
      if (queryIndex === 0) {
        scores[candidateIndex] = characterScore - candidateIndex * 0.2;
        continue;
      }
      for (
        let previousIndex = queryIndex - 1;
        previousIndex < candidateIndex;
        previousIndex += 1
      ) {
        const previous = previousScores[previousIndex];
        if (previous === undefined || !Number.isFinite(previous)) continue;
        const consecutive = previousIndex === candidateIndex - 1;
        const gap = candidateIndex - previousIndex - 1;
        scores[candidateIndex] = Math.max(
          scores[candidateIndex] ?? Number.NEGATIVE_INFINITY,
          previous + characterScore + (consecutive ? 24 : -gap * 1.5),
        );
      }
    }
    previousScores = scores;
  }

  const best = Math.max(...previousScores);
  if (!Number.isFinite(best)) return undefined;
  const prefixBonus = candidate.startsWith(needle) ? 80 : 0;
  return best + prefixBonus - candidate.length * 0.08;
}

export function fuzzyScore(query: string, value: string): number | undefined {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  let score = 0;
  for (const term of terms) {
    const result = termScore(term, value);
    if (result === undefined) return undefined;
    score += result;
  }
  return score;
}

export function repositoryFuzzyScore(
  query: string,
  name: string,
  details: string,
): number | undefined {
  if (!query.trim()) return 0;
  const nameScore = fuzzyScore(query, name);
  const fullScore = fuzzyScore(query, `${name} ${details}`);
  if (nameScore === undefined && fullScore === undefined) return undefined;
  return Math.max(
    nameScore === undefined ? Number.NEGATIVE_INFINITY : nameScore + 60,
    fullScore ?? Number.NEGATIVE_INFINITY,
  );
}
