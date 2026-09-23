// Live Text for Video — service worker
//
// 只做两件事：
//   1. capture  截取当前可见标签页（拿到的是合成后的干净像素，绕开跨域 canvas 污染）
//   2. ocr      把 PNG 交给本机 OCR 后端（Native Messaging）
//
// 它没有 DOM、不持有大数据、随时可能被 Chrome 回收，所以逻辑尽量薄。

const HOST_NAME = 'com.zhuo.livetext';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'capture') {
    const tab = sender.tab;
    const windowId = tab ? tab.windowId : undefined;

    const doCapture = () => {
      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true, dataUrl });
      });
    };

    // captureVisibleTab 抓的是「窗口里当前可见的那个标签」。
    // 如果发起请求的标签不在前台，就会抓到别的页面，所以先把它激活。
    if (tab && tab.id != null && !tab.active) {
      chrome.tabs.update(tab.id, { active: true }, () => setTimeout(doCapture, 180));
    } else {
      doCapture();
    }
    return true; // 保持消息通道，等异步回调
  }

  if (msg && msg.type === 'ocr') {
    chrome.runtime.sendNativeMessage(
      HOST_NAME,
      { png: msg.png, langs: msg.langs || ['zh-Hans', 'en-US'] },
      (resp) => {
        if (chrome.runtime.lastError) {
          sendResponse({
            ok: false,
            error: '本机 OCR 后端未连接：' + chrome.runtime.lastError.message,
          });
          return;
        }
        sendResponse(resp || { ok: false, error: '后端返回为空' });
      }
    );
    return true;
  }

  return false;
});
