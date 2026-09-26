// Live Text for Video — 扩展面板
//
// 三件事：
//   1. 选识别语言
//   2. 开关「暂停时自动识别」
//   3. 开关「自动识别时也高亮文字」（只管自动那条路；手动点小标始终亮框）
// 都存进 chrome.storage.sync，content script 实时读取（改完不用刷新页面）。

// 与 content.js 的 DEFAULT_LANGS 保持一致
const DEFAULT_LANGS = ['auto'];

const radios = Array.from(document.querySelectorAll('input[name="lang"]'));
const autoBox = document.getElementById('auto');
const hintBox = document.getElementById('hint');

chrome.storage.sync.get({ langs: DEFAULT_LANGS, autoRecognize: false, showHint: false }, (v) => {
  const cur = (Array.isArray(v.langs) && v.langs.length ? v.langs : DEFAULT_LANGS).join(',');
  for (const r of radios) r.checked = r.value === cur;
  autoBox.checked = !!v.autoRecognize;
  hintBox.checked = !!v.showHint;
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

hintBox.addEventListener('change', () => {
  chrome.storage.sync.set({ showHint: hintBox.checked });
});
