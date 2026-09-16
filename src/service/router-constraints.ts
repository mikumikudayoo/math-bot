export interface RoutingConstraints {
  knowledge?: 'internal' | 'web_required';
  tool?: 'none' | 'calculate';
  reasons: string[];
}

export function routingConstraints(
  prompt: string,
): RoutingConstraints {
  const p = prompt.trim();

  // Explicit no-web instructions have highest priority.
  const noWeb =
    /\b(?:do not|don't|dont)\s+(?:search|browse|use\s+(?:the\s+)?web|check\s+online|look\s+(?:it|anything|this|that)?\s*up)\b/i.test(p) ||
    /\bwithout\s+(?:searching|browsing|using\s+(?:the\s+)?web|looking\s+(?:it|anything|this|that)?\s*up)\b/i.test(p) ||
    /\bno\s+(?:web|internet|online\s+search)\b/i.test(p);

  if (noWeb) {
    return {
      knowledge: 'internal',
      reasons: ['explicit no-web request'],
    };
  }

  // Explicit requests to retrieve or verify external information.
  const requireWeb =
    /^(?:please\s+)?(?:search\b|look\s+up\b|lookup\b|fact[- ]?check\b|verify\b|check\s+online\b)/i.test(p) ||
    /\b(?:can|could|would|will)\s+(?:you\s+)?(?:search|look\s+up|fact[- ]?check|verify|check\s+online)\b/i.test(p) ||
    /\b(?:give|find|provide)\s+(?:me\s+)?(?:(?:a|the)\s+)?(?:reliable\s+)?(?:source|sources|citation|citations)\b/i.test(p);

  if (requireWeb) {
    return {
      knowledge: 'web_required',
      reasons: ['explicit web request'],
    };
  }

  return {
    reasons: [],
  };
}
