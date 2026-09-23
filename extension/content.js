// Live Text for Video — content script
//
// 流程：video 暂停 → 右下角浮出小标 → 点击 → 抓帧 → 本机 Vision OCR
//       → 在画面原位叠一层「文字透明但可选中」的文本层 → 直接拖选复制

(() => {
  if (window.__livetextInjected) return;
  window.__livetextInjected = true;

  const BTN_SIZE = 34;
  // 避让网站自己的底部控制栏：B 站 / YouTube 的控制条都压在画面底部，
  // 只内缩十几像素会让小标混进它们的图标里，所以底部留更多空间。
  const GAP_RIGHT = 20;
  const GAP_BOTTOM = 46;
  const MIN_CONF = 0; // 置信度过滤阈值，0 表示不过滤
  // 默认交给 Vision 自动检测语言 —— 最接近 Safari 实况文本的行为。
  // 实测同一张日文画面：['zh-Hans','en-US'] 只出 11 行，['auto'] 出 44 行。
  // （中日语言包互斥，手动指定时一次只能用一种，所以默认自动判断更稳）
  const DEFAULT_LANGS = ['auto'];
  // 语言从扩展面板里选，存在 chrome.storage.sync。
  // 为什么必须手动切：中日语言包互斥 —— 同时给出会让中文被日化成繁体/日文汉字
  // （师→姉、试→試、这→汶），而且耗时翻近一倍。
  let LANGS = DEFAULT_LANGS.slice();

  try {
    chrome.storage.sync.get({ langs: DEFAULT_LANGS }, (v) => {
      if (v && Array.isArray(v.langs) && v.langs.length) LANGS = v.langs;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.langs && Array.isArray(changes.langs.newValue)) {
        LANGS = changes.langs.newValue;
      }
    });
  } catch (e) {
    // 扩展上下文失效时静默忽略
  }

  const ICON =
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/>' +
    '<path d="M8 9h8M8 12h6M8 15h4"/></svg>';

  let btn = null;
  let layer = null;
  let state = 'idle'; // idle | busy | active
  let activeVideo = null;

  // ---------- 基础工具 ----------

  function sendMsg(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { ok: false, error: '无响应' });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('截图解码失败'));
      img.src = src;
    });
  }

  const nextFrame = () =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  function mountRoot() {
    return document.fullscreenElement || document.body || document.documentElement;
  }

  function isUsable(v) {
    return !!v && v.isConnected && v.videoWidth > 0 && v.videoHeight > 0;
  }

  /** 视频实际画面的矩形（视口坐标，已扣掉 letterbox 黑边） */
  function frameRect(v) {
    const r = v.getBoundingClientRect();
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh || !r.width || !r.height) {
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    const s = Math.min(r.width / vw, r.height / vh);
    const w = vw * s;
    const h = vh * s;
    return {
      x: r.left + (r.width - w) / 2,
      y: r.top + (r.height - h) / 2,
      w: w,
      h: h,
    };
  }

  // ---------- 小标 ----------

  function ensureBtn() {
    if (btn && btn.isConnected) return btn;
    btn = document.createElement('button');
    btn.id = 'livetext-btn';
    btn.type = 'button';
    btn.title = '提取画面文字（实况文本）';
    btn.innerHTML = ICON;
    btn.addEventListener('click', onBtnClick, true);
    mountRoot().appendChild(btn);
    return btn;
  }

  function placeBtn() {
    if (!btn || !isUsable(activeVideo)) return;
    const f = frameRect(activeVideo);
    btn.style.left = f.x + f.w - BTN_SIZE - GAP_RIGHT + 'px';
    btn.style.top = f.y + f.h - BTN_SIZE - GAP_BOTTOM + 'px';
  }

  function showBtn(v) {
    activeVideo = v;
    const b = ensureBtn();
    placeBtn();
    b.classList.remove('lt-busy', 'lt-active');
    b.classList.add('lt-show');
    state = 'idle';
  }

  function hideBtn() {
    if (btn) btn.classList.remove('lt-show', 'lt-busy', 'lt-active');
    if (state !== 'busy') state = 'idle';
  }

  function clearLayer() {
    if (layer && layer.isConnected) layer.remove();
    layer = null;
    if (btn) btn.classList.remove('lt-active', 'lt-busy');
    if (state !== 'busy') state = 'idle';
  }

  // ---------- 抓帧 ----------

  async function cropToBase64(dataUrl, f) {
    const img = await loadImage(dataUrl);
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(f.w * dpr));
    const h = Math.max(1, Math.round(f.h * dpr));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(
      img,
      Math.round(f.x * dpr),
      Math.round(f.y * dpr),
      w,
      h,
      0,
      0,
      w,
      h
    );
    return c.toDataURL('image/png').split(',')[1];
  }

  // ---------- 文本层 ----------

  // 文本层刻意留在普通 DOM 里（不放进 Shadow DOM）：
  // 这样 Yomitan 这类日语词典扩展能扫描到这些文本节点，从而支持悬停查词。
  function renderLayer(lines, f) {
    if (layer && layer.isConnected) layer.remove();

    const el = document.createElement('div');
    el.id = 'livetext-layer';
    el.style.left = f.x + 'px';
    el.style.top = f.y + 'px';
    el.style.width = f.w + 'px';
    el.style.height = f.h + 'px';

    const pending = [];

    for (const l of lines) {
      const s = document.createElement('span');
      s.className = 'lt-t';

      // 日语/中文排版里画面上多是全角空格，而 OCR 常给半角空格（宽度只有约 1/4），
      // 会让空格后面的字符整体前移，表现为「某些字莫名错位」。含 CJK 的文本统一换成全角。
      let text = l.text;
      if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(text)) {
        text = text.replace(/ /g, '\u3000');
      }
      s.textContent = text;
      s.dataset.ltTargetW = (l.w * f.w).toFixed(1);

      const hPx = l.h * f.h;
      s.style.left = l.x * f.w + 'px';
      // Vision 原点在左下，CSS 原点在左上 —— 这里做一次上下翻转
      s.style.top = (1 - l.y - l.h) * f.h + 'px';
      s.style.height = hPx + 'px';
      s.style.lineHeight = hPx + 'px';
      s.style.fontSize = hPx * 0.94 + 'px';

      el.appendChild(s);
      pending.push({ node: s, targetW: l.w * f.w });
    }

    mountRoot().appendChild(el);
    layer = el;

    // 把每块文字的实际渲染宽度校准到 OCR 给的 bbox 宽度。
    // 这一步对词典扩展很关键：Yomitan 靠「鼠标坐标 → 字符序号」查词，
    // 若渲染宽度与画面上的实际文字宽度不符，字符序号会随位置累积偏移，
    // 表现为「行首的词准，越靠行尾偏得越多」。
    // 用 letter-spacing 而不是 transform:scaleX —— 后者会干扰命中判定。
    requestAnimationFrame(() => {
      if (layer !== el) return;
      for (const item of pending) {
        const node = item.node;
        const n = node.textContent.length;
        if (n < 2 || item.targetW <= 0) continue;

        // 第一步：按实际渲染宽度反推合适的字号，让文字宽度自然逼近 OCR 给的宽度。
        // 只靠 letter-spacing 的话，字号偏大时字符会被压得互相重叠 —— 既显得挤，
        // 也会让词典扩展的「坐标→字符」定位变钝。
        node.style.letterSpacing = '';
        const curSize = parseFloat(node.style.fontSize);
        const natural0 = node.getBoundingClientRect().width;
        if (natural0 > 0 && curSize > 0) {
          const want = curSize * (item.targetW / natural0);
          // 限制调整幅度，避免个别 OCR 误差把字号拉飞
          const clamped = Math.max(curSize * 0.6, Math.min(curSize * 1.7, want));
          node.style.fontSize = clamped.toFixed(2) + 'px';
        }

        // 第二步：剩余误差用 letter-spacing 收尾
        const natural1 = node.getBoundingClientRect().width;
        if (natural1 > 0) {
          const ls = (item.targetW - natural1) / (n - 1);
          if (Math.abs(ls) <= 10) node.style.letterSpacing = ls.toFixed(2) + 'px';
        }
      }
    });

    // 文字完全透明，用户不知道哪里有字，所以先整体亮一下再淡出。
    // 注：早先用过 transform:scaleX 把文字拉伸到 OCR 给的 bbox 宽度以求高亮精确对齐，
    // 但那会干扰拖选的命中判定（实测会漏掉目标、甚至扫到整页文字），得不偿失，已去掉。
    el.classList.add('lt-hint');
    setTimeout(() => {
      if (layer === el) el.classList.remove('lt-hint');
    }, 3000);
  }

  // ---------- 主流程 ----------

  async function onBtnClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();

    if (state === 'active') {
      clearLayer();
      return;
    }
    if (state === 'busy') return;
    if (!isUsable(activeVideo)) return;

    state = 'busy';
    btn.classList.add('lt-busy');
    btn.classList.remove('lt-active');

    const v = activeVideo;
    const f = frameRect(v);

    try {
      // 抓帧前把小标藏起来，免得它自己被拍进画面里
      btn.style.visibility = 'hidden';
      await nextFrame();

      const cap = await sendMsg({ type: 'capture' });
      btn.style.visibility = '';
      if (!cap.ok) throw new Error(cap.error);

      const png = await cropToBase64(cap.dataUrl, f);
      if (state !== 'busy' || activeVideo !== v) return;

      const res = await sendMsg({ type: 'ocr', png: png, langs: LANGS });
      if (state !== 'busy' || activeVideo !== v) return;
      if (!res.ok) throw new Error(res.error);

      const lines = (res.lines || []).filter((l) => l.conf >= MIN_CONF);
      if (!lines.length) throw new Error('画面里没有识别到文字');

      renderLayer(lines, f);
      state = 'active';
      btn.classList.remove('lt-busy');
      btn.classList.add('lt-active');
      btn.title = '已识别 ' + lines.length + ' 处文字，鼠标移到画面上拖选即可复制';
      console.log('[Live Text] 识别到 ' + lines.length + ' 行，耗时 ' + res.elapsed_ms + 'ms');
    } catch (err) {
      console.error('[Live Text]', err);
      const msg = err && err.message ? err.message : String(err);
      btn.style.visibility = '';
      btn.classList.remove('lt-busy');
      btn.classList.add('lt-error');
      // 把错误写到 title 上：content script 的 console 在隔离世界里，
      // 外部工具读不到，写进 DOM 才能被读到
      btn.title = '出错：' + msg;
      state = 'idle';
      setTimeout(() => {
        if (btn) btn.classList.remove('lt-error');
      }, 2500);
    }
  }

  // ---------- 事件绑定 ----------

  function bindVideo(v) {
    if (!v || v.__ltBound) return;
    v.__ltBound = true;

    v.addEventListener(
      'pause',
      () => {
        if (isUsable(v)) showBtn(v);
      },
      true
    );

    // 页面加载时视频本来就可能是暂停的（或在脚本注入前就被暂停了），
    // 这种情况下 pause 事件永远不会再来一次，所以要主动补一次检查。
    const checkAlreadyPaused = () => {
      if (v.paused && isUsable(v)) showBtn(v);
    };
    v.addEventListener('loadedmetadata', checkAlreadyPaused, true);
    v.addEventListener('durationchange', checkAlreadyPaused, true);
    if (v.readyState >= 1) {
      setTimeout(checkAlreadyPaused, 400);
    }

    v.addEventListener(
      'play',
      () => {
        if (activeVideo === v) {
          clearLayer();
          hideBtn();
        }
      },
      true
    );

    v.addEventListener(
      'emptied',
      () => {
        if (activeVideo === v) {
          clearLayer();
          hideBtn();
          activeVideo = null;
        }
      },
      true
    );
  }

  function scan() {
    const list = document.querySelectorAll('video');
    for (let i = 0; i < list.length; i++) bindVideo(list[i]);
  }

  scan();

  // 站点 DOM 变化极频繁，这里做节流，避免扫描本身拖慢页面
  let scanTimer = null;
  const mo = new MutationObserver(() => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 800);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener(
    'resize',
    () => {
      if (state === 'active') clearLayer();
      if (btn && btn.classList.contains('lt-show')) placeBtn();
    },
    true
  );

  let rafPending = false;
  window.addEventListener(
    'scroll',
    () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (state === 'active') clearLayer();
        if (btn && btn.classList.contains('lt-show')) placeBtn();
      });
    },
    { passive: true, capture: true }
  );

  document.addEventListener('fullscreenchange', () => {
    clearLayer();
    if (!isUsable(activeVideo)) return;
    if (activeVideo.paused) {
      ensureBtn();
      mountRoot().appendChild(btn);
      placeBtn();
      btn.classList.add('lt-show');
    } else {
      hideBtn();
    }
  });
})();
