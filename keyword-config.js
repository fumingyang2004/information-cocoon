(function (root) {
  'use strict';
  const DEFAULT_KEYWORDS = Object.freeze(['OpenAI', 'GPT', 'Codex', 'Claude', 'Anthropic', 'DeepSeek']);
  const STORAGE_KEY = 'juyaKeywordSettings';
  const defaults = () => ({ version: 1, selectedId: 'default', groups: [
    { id: 'default', name: '默认', keywords: [...DEFAULT_KEYWORDS] }
  ] });
  function keywordsFromText(text) {
    const words = String(text).split(/[\r\n,，]+/).map(word => word.trim()).filter(Boolean);
    if (!words.length || words.length > 30 || words.some(word => word.length > 80)) {
      throw new Error('每组需要 1–30 个关键词，每个不超过 80 个字符');
    }
    const seen = new Set();
    return words.filter(word => {
      const key = word.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function validateName(settings, id, name) {
    const clean = String(name).trim();
    if (!clean || clean.length > 40) throw new Error('集合名称需为 1–40 个字符');
    if (settings.groups.some(group => group.id !== id && group.name.toLowerCase() === clean.toLowerCase())) {
      throw new Error('集合名称已存在');
    }
    return clean;
  }
  function restore(raw) {
    try {
      if (raw?.version !== 1 || !Array.isArray(raw.groups) || !raw.groups.length || raw.groups.length > 50) return defaults();
      const settings = { version: 1, selectedId: String(raw.selectedId), groups: [] };
      for (const group of raw.groups) {
        if (typeof group.id !== 'string' || !group.id || settings.groups.some(item => item.id === group.id)
          || !Array.isArray(group.keywords)) return defaults();
        settings.groups.push({ id: group.id, name: group.id === 'default' ? '默认' : validateName(settings, group.id, group.name),
          keywords: keywordsFromText(group.keywords.join('\n')) });
      }
      if (!settings.groups.some(group => group.id === 'default')) return defaults();
      if (!settings.groups.some(group => group.id === settings.selectedId)) settings.selectedId = 'default';
      return settings;
    } catch { return defaults(); }
  }
  const selected = settings => settings.groups.find(group => group.id === settings.selectedId);
  function select(settings, id) {
    if (!settings.groups.some(group => group.id === id)) throw new Error('关键词集合不存在');
    return { ...settings, selectedId: id };
  }
  function update(settings, id, name, text) {
    const clean = id === 'default' ? '默认' : validateName(settings, id, name);
    const keywords = keywordsFromText(text);
    if (!settings.groups.some(group => group.id === id)) throw new Error('关键词集合不存在');
    return { ...settings, groups: settings.groups.map(group => group.id === id
      ? { ...group, name: clean, keywords } : group) };
  }
  function add(settings, id) {
    if (settings.groups.length >= 50) throw new Error('最多保存 50 个集合');
    if (settings.groups.some(group => group.id === id)) throw new Error('集合 ID 已存在');
    const source = selected(settings);
    let index = 1;
    while (settings.groups.some(group => group.name === `新集合 ${index}`)) index++;
    return { ...settings, selectedId: id, groups: [...settings.groups,
      { id, name: `新集合 ${index}`, keywords: [...source.keywords] }] };
  }
  function remove(settings, id) {
    if (id === 'default') throw new Error('默认集合不能删除');
    if (!settings.groups.some(group => group.id === id)) throw new Error('关键词集合不存在');
    return { ...settings, selectedId: settings.selectedId === id ? 'default' : settings.selectedId,
      groups: settings.groups.filter(group => group.id !== id) };
  }
  const api = { STORAGE_KEY, DEFAULT_KEYWORDS, defaults, restore, keywordsFromText, selected, select, update, add, remove };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JuyaKeywordConfig = api;
})(globalThis);
