// The reaction picker's emoji catalog (web/src/emoji-catalog.ts) and its search, run in Node.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUICK_REACTIONS, reactionEmoji } from '../../shared/reactions.ts';
import { CATEGORIES, searchEmoji } from '../../web/src/emoji-catalog.ts';

test('every emoji in the catalog is one the server takes as a reaction, as it stores it, and is listed once', () => {
  const seen = new Set<string>();
  for (const c of CATEGORIES) {
    assert.ok(c.emoji.length > 0, c.name);
    for (const e of c.emoji) {
      assert.equal(reactionEmoji(e.emoji), e.emoji, `${c.name}: ${e.emoji} (${e.words}) is stored as written`);
      assert.ok(e.words.trim(), `${e.emoji} has words to find it by`);
      assert.ok(!seen.has(e.emoji), `${e.emoji} is listed once`);
      seen.add(e.emoji);
    }
  }
  assert.ok(seen.size >= 300, `${seen.size} emoji`);
  for (const q of [...QUICK_REACTIONS, '👎', '😕', '❓', '✅']) assert.ok(seen.has(q), `${q} can be found in the full picker too`);
});

test('search finds by the start of any word, every word of the query, and by the emoji itself', () => {
  const found = (q: string) => searchEmoji(q).map((e) => e.emoji);
  assert.deepEqual(found(''), []);
  assert.ok(found('thumbs').includes('👍') && found('thumbs').includes('👎'));
  assert.deepEqual(found('thumbs down'), ['👎']);
  assert.ok(found('THANK').includes('🙏'), 'any case');
  assert.ok(found('party').includes('🎉'));
  assert.ok(found('done').includes('✅'));
  assert.deepEqual(found('🦀'), ['🦀']);
  assert.deepEqual(found('zzqx'), []);
});
