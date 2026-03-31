/**
 * Consensus vote parsing utilities
 *
 * Ported from three-minds — detects [CONSENSUS: YES/NO] tags in agent
 * responses with multiple fallback patterns for variant formats.
 */

/** Remove all [CONSENSUS: YES/NO] tags from text */
export function stripConsensusTags(text: string): string {
  return text.replace(/\[\s*CONSENSUS\s*[:：]\s*(?:YES|NO)\s*\]/gi, '').trim();
}

/** Check whether text contains any consensus vote marker */
export function hasConsensusMarker(text: string): boolean {
  return /\[\s*CONSENSUS\s*[:：]\s*(?:YES|NO)\s*\]/i.test(text) ||
    /consensus[:\s]+(yes|no)/i.test(text) ||
    /共识投票[:：\s]+(YES|NO)/i.test(text);
}

/**
 * Parse a consensus vote from agent response text.
 *
 * Priority chain:
 * 1. Strict format: [CONSENSUS: YES] / [CONSENSUS: NO]
 * 2. Common variants: consensus: yes, **consensus**: no, CONSENSUS=YES, etc.
 * 3. Tail fallback: analyse last 8 lines for positive/negative signals
 * 4. Default: false (no consensus)
 */
export function parseConsensus(content: string): boolean {
  // Strict format (supports Chinese colon) — take the LAST match
  const strictMatches = [...content.matchAll(/\[\s*CONSENSUS\s*[:：]\s*(YES|NO)\s*\]/gi)];
  if (strictMatches.length > 0) {
    return strictMatches[strictMatches.length - 1][1].toUpperCase() === 'YES';
  }

  // Fallback: common variants — also take the last match
  const variantPatterns = [
    /consensus[:\s]+(yes|no)/gi,
    /\*\*consensus\*\*[:\s]+(yes|no)/gi,
    /CONSENSUS=(YES|NO)/gi,
    /共识投票[:：\s]+(YES|NO)/gi,
    /\[CONSENSUS\][:\s]+(YES|NO)/gi,
  ];
  for (const pattern of variantPatterns) {
    const matches = [...content.matchAll(pattern)];
    if (matches.length > 0) {
      return matches[matches.length - 1][1].toUpperCase() === 'YES';
    }
  }

  // Last resort: analyse final 8 non-empty lines
  const lastLines = content.split('\n').filter(l => l.trim()).slice(-8).join(' ').toLowerCase();

  const hasNegative =
    lastLines.includes('consensus: no')
    || lastLines.includes('consensus no')
    || /\b(?:not|no)\s+(?:reach(?:ed)?|achieve(?:d)?)\s+consensus\b/.test(lastLines)
    || /(?:未|没|沒有|没有)达成共识/.test(lastLines);
  if (hasNegative) return false;

  const hasPositive =
    lastLines.includes('consensus: yes')
    || lastLines.includes('consensus yes')
    || /达成共识/.test(lastLines);
  if (hasPositive) return true;

  return false;
}
