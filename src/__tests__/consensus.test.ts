/**
 * Unit tests for consensus vote parsing
 *
 * Run with: npx tsx src/__tests__/consensus.test.ts
 */

import assert from 'node:assert/strict';
import { parseConsensus, stripConsensusTags, hasConsensusMarker } from '../consensus.js';

// ─── parseConsensus ─────────────────────────────────────────────────────────

const cases: Array<{ name: string; content: string; expected: boolean }> = [
  // Strict format
  { name: 'standard YES', content: 'Some text\n[CONSENSUS: YES]\n', expected: true },
  { name: 'standard NO', content: 'Some text\n[CONSENSUS: NO]\n', expected: false },
  { name: 'Chinese colon YES', content: 'Report\n[CONSENSUS：YES]\n', expected: true },
  { name: 'Chinese colon NO', content: 'Report\n[CONSENSUS：NO]\n', expected: false },
  { name: 'extra whitespace', content: '[ CONSENSUS :  YES ]', expected: true },

  // Variant formats
  { name: 'lowercase consensus: yes', content: 'consensus: yes', expected: true },
  { name: 'markdown bold no', content: '**consensus**: no', expected: false },
  { name: 'CONSENSUS=YES', content: 'CONSENSUS=YES', expected: true },
  { name: 'Chinese voting YES', content: '共识投票：YES', expected: true },
  { name: '[CONSENSUS]: NO', content: '[CONSENSUS]: NO', expected: false },

  // Tail fallback — positive
  { name: 'tail: consensus yes', content: 'Text here\nconsensus yes', expected: true },
  { name: 'tail: 达成共识', content: 'Report\n我们已达成共识', expected: true },

  // Tail fallback — negative
  { name: 'tail: did not reach consensus', content: 'Summary: we did not reach consensus yet', expected: false },
  { name: 'tail: 未达成共识', content: 'Report\n我们未达成共识', expected: false },
  { name: 'tail: 没有达成共识', content: 'Report\n我们没有达成共识', expected: false },
  { name: 'tail: consensus no (keyword)', content: 'Some text\nconsensus no', expected: false },

  // Default
  { name: 'no vote at all', content: 'Just some random text with no vote', expected: false },

  // Multiple votes — last one wins
  { name: 'multiple votes, last wins', content: '[CONSENSUS: NO]\nChanged my mind\n[CONSENSUS: YES]', expected: true },
  { name: 'multiple votes, last NO', content: '[CONSENSUS: YES]\nActually\n[CONSENSUS: NO]', expected: false },
];

let passed = 0;
for (const { name, content, expected } of cases) {
  const actual = parseConsensus(content);
  assert.equal(actual, expected, `parseConsensus: "${name}" — expected ${expected}, got ${actual}`);
  passed++;
}
console.log(`parseConsensus: ${passed}/${cases.length} tests passed`);

// ─── stripConsensusTags ─────────────────────────────────────────────────────

assert.equal(
  stripConsensusTags('Report here\n[CONSENSUS: YES]\n'),
  'Report here',
  'stripConsensusTags should remove [CONSENSUS: YES]',
);
assert.equal(
  stripConsensusTags('[CONSENSUS: NO] and [CONSENSUS: YES]'),
  'and',
  'stripConsensusTags should remove all tags',
);
console.log('stripConsensusTags: 2/2 tests passed');

// ─── hasConsensusMarker ─────────────────────────────────────────────────────

assert.equal(hasConsensusMarker('[CONSENSUS: YES]'), true);
assert.equal(hasConsensusMarker('consensus: no'), true);
assert.equal(hasConsensusMarker('共识投票：YES'), true);
assert.equal(hasConsensusMarker('no vote here'), false);
console.log('hasConsensusMarker: 4/4 tests passed');

console.log('\nAll consensus tests passed!');
