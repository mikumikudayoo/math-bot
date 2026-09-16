export function routingClauses(prompt: string): string[] {
  const normalized = prompt
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return [];

  const clauses = normalized
    .split(
      /(?:[.!?;]+\s+|\s+(?:and|but|also|then)\s+|,\s+(?:and|but|then)\s+)/i,
    )
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);

  return clauses.length > 1
    ? clauses
    : [normalized];
}
