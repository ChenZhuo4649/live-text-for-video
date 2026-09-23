// Live Text for Video — 扩展面板
//
// 两件事：
//   1. 选识别语言
//   2. 开关「暂停时自动识别」
// 都存进 chrome.storage.sync，content script 实时读取（改完不用刷新页面）。

// 与 content.js 的 DEFAULT_LANGS 保持一致
const DEFAULT_LANGS = ['auto'];

const radios = Array.from(document.querySelectorAll('input[name="lang"]'));
const autoBox = document.getElementById('auto');

chrome.storage.sync.get({ langs: DEFAULT_LANGS, autoRecognize: false }, (v) => {
  const cur = (Array.isArray(v.langs) && v.langs.length ? v.langs : DEFAULT_LANGS).join(',');
  for (const r of radios) r.checked = r.value === cur;
  autoBox.checked = !!v.autoRecognize;
});

for (const r of radios) {
  r.addEventListener('change', () => {
    if (r.checked) {
      chrome.storage.sync.set({ langs: r.value.split(',') });
    }
  });
}

autoBox.addEventListener('change', () => {
  chrome.storage.sync.set({ autoRecognize: autoBox.checked });
});
