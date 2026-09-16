const { test } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../keyword-config.js');

test('default group starts with the six existing terms and survives storage round-trip', () => {
  const settings = config.defaults();
  assert.equal(settings.selectedId, 'default');
  assert.deepEqual(config.selected(settings).keywords, ['OpenAI', 'GPT', 'Codex', 'Claude', 'Anthropic', 'DeepSeek']);
  assert.deepEqual(config.restore(JSON.parse(JSON.stringify(settings))), settings);
});

test('multiple named groups, editing words, selection and deletion persist', () => {
  let settings = config.add(config.defaults(), 'group-1');
  settings = config.update(settings, 'group-1', '国内资讯', '通义\n DeepSeek,deepseek\n 豆包');
  assert.deepEqual(config.selected(settings).keywords, ['通义', 'DeepSeek', '豆包']);
  settings = config.add(settings, 'group-2');
  settings = config.update(settings, 'group-2', '编程', 'Codex\nClaude Code');
  assert.equal(settings.groups.length, 3);
  assert.equal(config.restore(JSON.parse(JSON.stringify(settings))).selectedId, 'group-2');
  settings = config.select(settings, 'group-1');
  assert.equal(config.selected(settings).name, '国内资讯');
  settings = config.remove(settings, 'group-1');
  assert.equal(settings.selectedId, 'default');
  assert.equal(settings.groups.length, 2);
});

test('default words are editable and can be restored; default identity cannot be deleted or renamed', () => {
  const changed = config.update(config.defaults(), 'default', 'renamed', 'Tibo');
  assert.equal(config.selected(changed).name, '默认');
  assert.deepEqual(config.selected(changed).keywords, ['Tibo']);
  assert.deepEqual(config.selected(config.update(changed, 'default', '默认', config.DEFAULT_KEYWORDS.join('\n'))).keywords,
    config.DEFAULT_KEYWORDS);
  assert.throws(() => config.remove(changed, 'default'), /不能删除/);
});

test('invalid empty/oversized/duplicate names and corrupted storage never reach runtime', () => {
  const settings = config.add(config.defaults(), 'custom');
  assert.throws(() => config.update(settings, 'custom', '默认', 'GPT'), /名称已存在/);
  assert.throws(() => config.update(settings, 'custom', ' ', 'GPT'), /名称/);
  assert.throws(() => config.update(settings, 'custom', 'A', ' , \n'), /关键词/);
  assert.throws(() => config.update(settings, 'custom', 'A', 'a'.repeat(81)), /80/);
  assert.throws(() => config.select(settings, 'missing'), /不存在/);
  assert.deepEqual(config.restore({ version: 1, groups: [{ id: 'default', name: '默认', keywords: [] }] }), config.defaults());
});
