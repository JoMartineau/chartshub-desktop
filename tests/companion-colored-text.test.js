const test = require('node:test');
const assert = require('node:assert/strict');
const parser = import('../companion/dist/core/types/ColoredText.js');

test('Unity colors preserve a contiguous charter name and an unclosed final color', async () => {
  const { parseColoredText } = await parser;
  assert.deepEqual(parseColoredText('  <color=#FF0000>Jo</color><color="#00FF00">Mar</color><#0088FF80>tineau'), {
    text: 'JoMartineau', segments: [{ text: 'Jo', color: '#ff0000' }, { text: 'Mar', color: '#00ff00' }, { text: 'tineau', color: '#0088ff80' }]
  });
  assert.deepEqual(parseColoredText('<b>J</b><i>o</i><size=24>M</size><font="Example">ar</font>'), { text: 'JoMar' });
});

test('nested colors restore their parent, named colors and short hex normalize to safe hex', async () => {
  const { parseColoredText } = await parser;
  assert.deepEqual(parseColoredText('<color=RED>A<color="blue">B</color>C</color>D'), {
    text: 'ABCD', segments: [{ text: 'A', color: '#ff0000' }, { text: 'B', color: '#0000ff' }, { text: 'C', color: '#ff0000' }, { text: 'D' }]
  });
  assert.deepEqual(parseColoredText('<color=#AbC>X</color><#1234>Y</color><color=green>Z'), {
    text: 'XYZ', segments: [{ text: 'X', color: '#aabbcc' }, { text: 'Y', color: '#11223344' }, { text: 'Z', color: '#008000' }]
  });
});

test('whitespace is normalized across tags without changing segment concatenation or adding inter-letter gaps', async () => {
  const { parseColoredText } = await parser;
  const value = parseColoredText(' \t<color=red>Test</color> \n <color=green>Charter</color>  ');
  assert.deepEqual(value, { text: 'Test Charter', segments: [{ text: 'Test', color: '#ff0000' }, { text: ' ' }, { text: 'Charter', color: '#008000' }] });
  const inside = parseColoredText('  <color=red>A \t</color> \n <color=blue>B</color>  C  ');
  assert.equal(inside.text, 'A B C'); assert.equal(inside.segments.map(segment => segment.text).join(''), inside.text);
  assert.deepEqual(inside.segments, [{ text: 'A ', color: '#ff0000' }, { text: 'B', color: '#0000ff' }, { text: ' C' }]);
});

test('unsupported colors and malformed tags produce safe text without arbitrary styles or HTML', async () => {
  const { parseColoredText } = await parser;
  for (const value of ['<color=url(https://evil.test)>Text</color>', '<color="red" style="background:url(x)">Text</color>', '<#invalid>Text</color>', '<color=expression(alert(1))>Text</color>', '<color=rebeccapurple>Text</color>']) {
    assert.deepEqual(parseColoredText(value), { text: 'Text' });
  }
  assert.deepEqual(parseColoredText('<img src=x onerror=alert(1)>'), { text: '<img src=x onerror=alert(1)>' });
  assert.deepEqual(parseColoredText('<color=red'), { text: '<color=red' });
  assert.deepEqual(parseColoredText('</color>Text'), { text: 'Text' });
  for (const value of [undefined, null, 42, {}, []]) assert.deepEqual(parseColoredText(value), { text: '' });
});

test('parser limits text, input, segment count and color depth without breaking Unicode or preserving partial styles', async () => {
  const { parseColoredText } = await parser;
  const long = parseColoredText('<color=red>' + '😀'.repeat(300)); assert.equal(long.text.length, 512); assert.equal([...long.text].length, 256); assert.equal(long.segments[0].text, long.text);
  const oversized = parseColoredText('<color=red>' + 'A'.repeat(17000)); assert.equal(oversized.text.length, 512); assert.equal(oversized.segments, undefined);
  const alternating = parseColoredText(Array.from({ length: 129 }, (_, index) => `<color=${index % 2 ? 'red' : 'blue'}>A</color>`).join('')); assert.equal(alternating.text.length, 129); assert.equal(alternating.segments, undefined);
  assert.ok(parseColoredText('<color=red>'.repeat(32) + 'X').segments);
  assert.deepEqual(parseColoredText('<color=red>'.repeat(33) + 'X' + '</color>'.repeat(33)), { text: 'X' });
});

test('segment validation requires exact normalized text, bounded safe keys and hex, returning independent clones', async () => {
  const { validateColoredTextSegments } = await parser;
  const input = [{ text: 'Test', color: '#FF0000' }, { text: ' ' }, { text: 'Charter', color: '#008000' }];
  const result = validateColoredTextSegments(input, 'Test Charter'); assert.equal(result[0].color, '#ff0000'); result[0].text = 'changed'; assert.equal(input[0].text, 'Test');
  for (const candidate of [null, [], [{ text: 'Wrong', color: '#ff0000' }], [{ text: 'Test Charter', color: 'red' }], [{ text: 'Test Charter', color: '#f00' }], [{ text: 'Test Charter', color: '#ff0000', style: 'position:fixed' }], [{ text: 'Test Charter', color: 'url(x)' }], [{ text: 'Test\nCharter', color: '#ff0000' }], [{ text: 'Test Charter' }]]) {
    assert.equal(validateColoredTextSegments(candidate, 'Test Charter'), undefined);
  }
  assert.equal(validateColoredTextSegments([{ text: ' Test ', color: '#ff0000' }], ' Test '), undefined);
  assert.equal(validateColoredTextSegments(Array.from({ length: 129 }, () => ({ text: 'x', color: '#ff0000' })), 'x'.repeat(129)), undefined);
  assert.equal(validateColoredTextSegments([{ text: 'x'.repeat(513), color: '#ff0000' }], 'x'.repeat(513)), undefined);
});

test('song normalization accepts matching charter segments only after plain charter normalization', async () => {
  const { normalizeSong } = await import('../companion/dist/core/services/normalizeSong.js');
  const segments = [{ text: 'Test', color: '#FF0000' }, { text: ' ' }, { text: 'Charter', color: '#008000' }];
  const song = normalizeSong({ title: 'Track', charter: '  Test   Charter ', charterSegments: segments });
  assert.equal(song.charter, 'Test Charter'); assert.deepEqual(song.charterSegments, [{ text: 'Test', color: '#ff0000' }, { text: ' ' }, { text: 'Charter', color: '#008000' }]);
  song.charterSegments[0].text = 'changed'; assert.equal(segments[0].text, 'Test');
  assert.equal(normalizeSong({ title: 'Track', charter: 'Other', charterSegments: segments }).charterSegments, undefined);
  assert.equal(normalizeSong({ title: 'Track', charter: 'unknown', charterSegments: [{ text: 'unknown', color: '#ff0000' }] }).charterSegments, undefined);
  assert.equal(normalizeSong({ title: 'Track', charterSegments: segments }).charterSegments, undefined);
});
