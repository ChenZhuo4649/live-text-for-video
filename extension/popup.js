// Live Text for Video — 扩展面板
// 只干一件事：选识别语言，存进 chrome.storage.sync，content script 会实时读到。

// 与 content.js 的 DEFAULT_LANGS 保持一致
const DEFAULT_LANGS = ['auto'];

const radios = Array.from(document.querySelectorAll('input[name="lang"]'));

chrome.storage.sync.get({ langs: DEFAULT_LANGS }, (v) => {
  const cur = (Array.isArray(v.langs) && v.langs.length ? v.langs : DEFAULT_LANGS).join(',');
  for (const r of radios) r.checked = r.value === cur;
});

for (const r of radios) {
  r.addEventListener('change', () => {
    if (r.checked) {
      chrome.storage.sync.set({ langs: r.value.split(',') });
    }
  });
}
