/**
 * Clarify block parser tests — total parsing of the ```ask fenced block the
 * chat renders as a clickable clarification card.
 *
 *   node src/lib/ai/__tests__/clarify.test.mjs
 */
import assert from 'node:assert/strict';
import { parseAskBlock, stripPartialAsk } from '../clarify.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e}`); _fail++; }
}

console.log('── Clarify block parser ──');

t('parses a well-formed ask block with prose before and after', () => {
    const text = 'A few quick questions:\n\n```ask\n{"questions":[{"q":"Fan OD?","options":["50 mm","70 mm","90 mm"],"default":"70 mm"}]}\n```\n\nThanks!';
    const r = parseAskBlock(text);
    assert.ok(r, 'should parse');
    assert.equal(r.before, 'A few quick questions:');
    assert.equal(r.after, 'Thanks!');
    assert.equal(r.questions.length, 1);
    assert.equal(r.questions[0].q, 'Fan OD?');
    assert.deepEqual(r.questions[0].options, ['50 mm', '70 mm', '90 mm']);
    assert.equal(r.questions[0].default, '70 mm');
    assert.equal(r.questions[0].multi, false);
});

t('drops a default that is not among the options', () => {
    const r = parseAskBlock('```ask\n{"questions":[{"q":"X?","options":["a","b"],"default":"z"}]}\n```');
    assert.equal(r.questions[0].default, null);
});

t('coerces multi flag and trims option strings', () => {
    const r = parseAskBlock('```ask\n{"questions":[{"q":"Pick","options":["  a  ","b"],"multi":true}]}\n```');
    assert.equal(r.questions[0].multi, true);
    assert.deepEqual(r.questions[0].options, ['a', 'b']);
});

t('plain prose (no block) returns null', () => {
    assert.equal(parseAskBlock('What size do you want?'), null);
});

t('malformed JSON returns null (graceful fallback to prose)', () => {
    assert.equal(parseAskBlock('```ask\n{not json}\n```'), null);
});

t('empty / no-question block returns null', () => {
    assert.equal(parseAskBlock('```ask\n{"questions":[]}\n```'), null);
    assert.equal(parseAskBlock('```ask\n{"questions":[{"options":["a"]}]}\n```'), null);
});

t('non-string input never throws', () => {
    assert.equal(parseAskBlock(null), null);
    assert.equal(parseAskBlock(42), null);
});

t('stripPartialAsk hides an unterminated fence mid-stream', () => {
    assert.equal(stripPartialAsk('Some lead-in\n\n```ask\n{"questions":[{"q":"'), 'Some lead-in');
    // a closed fence is left intact
    const closed = 'lead\n```ask\n{}\n```';
    assert.equal(stripPartialAsk(closed), closed);
    // no fence → passthrough
    assert.equal(stripPartialAsk('just text'), 'just text');
});

console.log(`\nClarify parser: ${_pass} passed, ${_fail} failed`);
if (_fail) process.exit(1);
