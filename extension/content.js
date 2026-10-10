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

  // 「暂停即自动识别」开关，同样存在 chrome.storage.sync（扩展面板里切换）
  let AUTO_ON_PAUSE = false;

  // 「自动识别时也高亮文字」开关（默认关）。
  // ⚠️ 它**只管「暂停自动识别」那条路**。手动点右下角小标永远会亮框 ——
  //    那是用户明确的「我要看」动作，不该被这个开关连坐（见 onBtnClick）。
  let SHOW_HINT = false;

  try {
    chrome.storage.sync.get(
      { langs: DEFAULT_LANGS, autoRecognize: false, showHint: false },
      (v) => {
        if (v && Array.isArray(v.langs) && v.langs.length) LANGS = v.langs;
        if (v) AUTO_ON_PAUSE = !!v.autoRecognize;
        if (v) SHOW_HINT = !!v.showHint;
      }
    );
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.langs && Array.isArray(changes.langs.newValue)) {
        LANGS = changes.langs.newValue;
      }
      if (changes.autoRecognize) {
        AUTO_ON_PAUSE = !!changes.autoRecognize.newValue;
      }
      if (changes.showHint) {
        SHOW_HINT = !!changes.showHint.newValue;
      }
    });
  } catch (e) {
    // 扩展上下文失效时静默忽略
  }

  // 图标：**用 <img> 内嵌 data-URI 的 SVG**，而不是内联 <svg>。
  //
  // 为什么（实测，2026-10-01 NicoNico）：一开始是内联 <svg> + stroke="currentColor"，
  // 在 NicoNico 上无论怎么加 !important，图标都画不出来（诊断显示
  // display=block / color=#fff / 尺寸正常，但**视觉上是空的**）—— 站点那条规则压得太深。
  //
  // <img> 内部的 SVG 是**独立的文档**，站点的 CSS **进不去**，
  // 颜色/描边全部在 data-URI 里写死 ⇒ 从根上免疫，不用再跟站点斗优先级。
  const ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" ' +
    'fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/>' +
    '<path d="M8 9h8M8 12h6M8 15h4"/></svg>';
  const ICON =
    '<img alt="" width="17" height="17" draggable="false" src="data:image/svg+xml,' +
    encodeURIComponent(ICON_SVG) +
    '">';

  let btn = null;
  let layer = null;
  let layerVideo = null; // 这层文字是为哪个视频生成的（见 dropStaleLayer）
  let state = 'idle'; // idle | busy | active
  let activeVideo = null;
  let lastCropStats = null; // 最近一次裁剪图的「体检结果」（亮度等），出错时一起打出来
  let resizeObserver = null; // 观察视频元素尺寸变化（全屏 / 播放器缩放）
  let wantBtn = false; // 小标「应不应该显示」（与「当前能不能挂上去」区分开，见 syncBtnMount）

  // 识别任务是**异步**的，中途主视频可能换人、同一个视频也可能「播放→再暂停」重启一轮。
  // 所以给它一套令牌：
  //   taskToken  —— 「当前有效」的世代号。任何会让进行中任务作废的事件都 +1，
  //                 于是该事件**之前**出发的任务手里的号码就过期了。
  //   busyToken  —— 正占着 state='busy' 的那趟任务的号码；-1 表示没人占。
  //                 有了它，过期任务才敢交接 busy —— 不会把后来者刚拿到的锁误抹掉。
  //   hiddenCount—— 有几趟任务正在把小标藏起来（防止互相抢着恢复显示）。
  let taskToken = 0;
  let busyToken = -1;
  let hiddenCount = 0;

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

  // 小标 / 文字层该往哪儿挂。
  //
  // 平时挂 document.body —— 两者都是 position:fixed + 视口坐标，挂在哪儿视觉位置都一样。
  //
  // 全屏时必须挂 document.fullscreenElement：浏览器把全屏元素提到 top layer，
  // 挂在它**外面**的节点会被 ::backdrop 压在下面，根本看不见。
  // （播放器容器全屏时挂容器是正常的，容器自己的子节点照常渲染。）
  //
  // 唯一的死局：**全屏元素就是 <video> 自己**。
  //   ① video 的子节点是「兜底内容」，只要有视频源就不渲染（这是 HTML 规范行为）；
  //   ② 全屏时 video 已经进了 top layer，它的兄弟节点被 backdrop 盖住。
  //   ⇒ 这种情况下**没有任何能显示覆盖层的地方**，返回 null 让调用方明确处理，
  //     而不是像以前那样「挂进 video 里，然后用户发现小标莫名其妙不见了」。
  function mountRoot() {
    const fs = document.fullscreenElement || document.webkitFullscreenElement || null;
    if (fs) {
      const tag = fs.tagName;
      if (tag === 'VIDEO' || tag === 'AUDIO') return null;
      return fs;
    }
    return document.body || document.documentElement;
  }

  function isUsable(v) {
    return !!v && v.isConnected && v.videoWidth > 0 && v.videoHeight > 0;
  }

  // 页面上不止一个 <video>：B 站把鼠标移到推荐视频上会自动预览播放，
  // 那个小窗也是 video，鼠标移开时它同样会触发 pause。
  // 所以只对「够大、且在视口内真的可见」的视频出小标，把预览小窗排除掉。
  const MIN_MAIN_VIDEO_AREA = 400 * 225;

  function isMainVideo(v) {
    if (!isUsable(v)) return false;
    const r = v.getBoundingClientRect();
    if (r.width * r.height < MIN_MAIN_VIDEO_AREA) return false;
    const visW = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    const visH = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    return visW > 40 && visH > 40;
  }

  // 元素的**内容盒**（扣掉 border + padding）。object-fit 参考的就是这个盒子，
  // 而不是 getBoundingClientRect() 给的边框盒。
  function contentBoxRect(el, borderRect) {
    const cs = getComputedStyle(el);
    const num = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
    const bl = num('border-left-width');
    const br = num('border-right-width');
    const bt = num('border-top-width');
    const bb = num('border-bottom-width');
    const pl = num('padding-left');
    const pr = num('padding-right');
    const pt = num('padding-top');
    const pb = num('padding-bottom');
    return {
      x: borderRect.left + bl + pl,
      y: borderRect.top + bt + pt,
      w: Math.max(0, borderRect.width - bl - br - pl - pr),
      h: Math.max(0, borderRect.height - bt - bb - pt - pb),
    };
  }

  // object-position 某一轴的取值 → 像素偏移。
  // free = 盒子在这根轴上剩下的空间；内容比盒子小则为正，溢出则为负。
  function positionOffset(token, free) {
    switch (token) {
      case 'left':
      case 'top':
        return 0;
      case 'center':
        return free / 2;
      case 'right':
      case 'bottom':
        return free;
    }
    if (token.endsWith('%')) {
      const pct = parseFloat(token);
      if (!Number.isNaN(pct)) return (pct / 100) * free;
    }
    // 绝对长度（px 等）：getComputedStyle 返回的是带单位的计算值，直接当像素用
    const abs = parseFloat(token);
    if (!Number.isNaN(abs)) return abs;
    // 认不出来（calc(...) 之类）就退回居中 —— 宁可近似也别把坐标算崩
    return free / 2;
  }

  /**
   * 视频**实际可见画面**的矩形（视口坐标）。
   *
   * ⚠️ 旧实现只按「object-fit: contain + 居中」这一个假设算。真实播放器未必如此 ——
   *    实测 YouTube 的主 <video> 就是 `object-fit: cover`（这不是特例，是大站常态）。
   *    元素宽高比和视频本身不一致时：
   *      contain → 画面缩放后居中，四周留黑边
   *      cover   → 画面**铺满元素，并把多余部分裁掉**
   *    两者可见区域完全不同。按旧公式算会同时犯两个错：
   *      ① 截图裁的区域不对（可能裁到黑边、也可能少裁一块）
   *      ② 文字层跟着错位，所有可选文字整体偏移
   *
   * 这里按 CSS Images Level 3 的规矩完整算一遍：
   *   ① 由 object-fit 定「内容渲染尺寸」
   *   ② 由 object-position 定它落在元素内容盒的哪个位置
   *   ③ 超出元素盒的部分会被裁掉 ⇒ 可见区 = 内容框 ∩ 元素内容盒
   */
  function frameRect(v) {
    const rx = v.getBoundingClientRect();
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const box = contentBoxRect(v, rx);
    if (!vw || !vh || box.w <= 0 || box.h <= 0) {
      return { x: rx.left, y: rx.top, w: rx.width, h: rx.height };
    }

    const cs = getComputedStyle(v);
    const fit = (cs.objectFit || 'contain').trim();

    // ① 内容渲染尺寸（尚未裁切）
    let cw;
    let ch;
    const sContain = Math.min(box.w / vw, box.h / vh);
    if (fit === 'fill') {
      cw = box.w; // 撑满盒子，比例失真它也认
      ch = box.h;
    } else if (fit === 'cover') {
      const s = Math.max(box.w / vw, box.h / vh); // 铺满，多出来的被裁
      cw = vw * s;
      ch = vh * s;
    } else if (fit === 'none') {
      cw = vw; // 原始像素尺寸，不缩放
      ch = vh;
    } else if (fit === 'scale-down') {
      const s = Math.min(sContain, 1); // contain 与 none 里取更小的那个
      cw = vw * s;
      ch = vh * s;
    } else {
      cw = vw * sContain; // contain，也是初始值
      ch = vh * sContain;
    }

    // ② 落点：object-position 是 "<x> <y>"，只给一个值时另一个轴按 center
    const op = (cs.objectPosition || '50% 50%').trim().split(/\s+/);
    const posX = op[0] || '50%';
    const posY = op.length > 1 ? op[1] : '50%';
    const x = box.x + positionOffset(posX, box.w - cw);
    const y = box.y + positionOffset(posY, box.h - ch);

    // ③ 超出部分会被裁掉 ⇒ 真正看得见的是两者相交
    const l = Math.max(x, box.x);
    const t = Math.max(y, box.y);
    const r = Math.min(x + cw, box.x + box.w);
    const b = Math.min(y + ch, box.y + box.h);
    return {
      x: l,
      y: t,
      w: Math.max(0, r - l),
      h: Math.max(0, b - t),
    };
  }

  // ---------- 小标 ----------

  function ensureBtn() {
    // ⚠️ 只判 btn 存不存在，**不再要求 isConnected**。
    //    挂载现在是 syncBtnMount 的事，而 video 自身全屏时 btn 暂时无处可挂 ——
    //    若这里要求 isConnected，那种情况下每次 showBtn 都会新建一个按钮，
    //    旧的那个（还挂着 click 监听）就白丢了。
    //    站点把按钮从 DOM 里删掉也不用担心：syncBtnMount 每次都会比对 parentNode 并重新挂。
    if (btn) return btn;
    btn = document.createElement('button');
    btn.id = 'livetext-btn';
    btn.type = 'button';
    btn.title = '提取画面文字（实况文本）';
    btn.innerHTML = ICON;
    btn.addEventListener('click', onBtnClick, true);
    // 不在这里 appendChild —— 挂载点可能随时变（进/出全屏），由 syncBtnMount 统一负责
    return btn;
  }

  function placeBtn() {
    if (!btn || !isUsable(activeVideo)) return;
    const f = frameRect(activeVideo);
    btn.style.left = f.x + f.w - BTN_SIZE - GAP_RIGHT + 'px';
    btn.style.top = f.y + f.h - BTN_SIZE - GAP_BOTTOM + 'px';
  }

  // 把小标挂到当前有效的挂载点并定位。
  //
  // 「想不想显示（wantBtn）」和「能不能挂上去（mountRoot()）」是两件事，必须分开记：
  // video 自身全屏时挂不上去，只能暂时藏起来；等用户退出全屏，
  // scheduleRelocate 会再调一次，把它原样放回来。
  // 以前没有这个区分 —— 藏起来之后 scheduleRelocate 开头的
  // 「if (!btn.classList.contains('lt-show')) return」会让它**再也回不来**。
  function syncBtnMount() {
    if (!btn) return;
    const root = mountRoot();
    if (!root) {
      btn.classList.remove('lt-show');
      return;
    }
    if (btn.parentNode !== root) root.appendChild(btn);
    placeBtn();
    btn.classList.add('lt-show');
  }

  function showBtn(v) {
    activeVideo = v;
    wantBtn = true;
    // 主视频确定 / 换人 ⇒ 先前那趟识别（不管跑到哪一步）立刻作废
    taskToken++;
    // 主视频换人了 ⇒ 旧视频留下的文字层立刻撤掉。
    // 必须放在 activeVideo 赋值**之后**：判据就是「层的主人 ≠ 当前主视频」。
    dropStaleLayer();

    // 观察视频元素自身的尺寸变化 —— 全屏切换、网站自己的 CSS 全屏、播放器缩放
    // 都会让它改变尺寸，从而触发重定位。比只监听 window resize 可靠得多。
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(scheduleRelocate);
      resizeObserver.observe(v);
    }

    const b = ensureBtn();
    b.classList.remove('lt-busy', 'lt-active');
    syncBtnMount();
    state = 'idle';
  }

  function hideBtn() {
    wantBtn = false;
    if (btn) btn.classList.remove('lt-show', 'lt-busy', 'lt-active');
    if (state !== 'busy') state = 'idle';
  }

  // 保留归一化 OCR 坐标，窗口/播放器布局变化时只重排 DOM，不重复识别。
  //
  // ⚠️ 缓存能复用的**前提**是「可见区 → 源画面」的映射没变。
  //    OCR 给的是**相对于可见区**的归一化坐标，只有可见区框住的是源画面的同一块内容时，
  //    把同一组归一化坐标套到新的可见区上才等价于"原样缩放"。
  //    一旦可见区的宽高比变了，映射就变了 —— 最典型的是 object-fit: cover：
  //      元素比 1.0 时看到源画面中间的 1:1 一块，元素比 2.33 时看到的是整幅，
  //      同一个词的归一化 x 从 0.23 变成 0.36 —— 直接套用会整体偏移（实测偏 90px）。
  //    contain 不受影响：它的可见区恒等于整帧，比例永远等于视频本身。
  //    所以用「可见区宽高比」当这组缓存还作不作数的判据。
  let layerLines = null;
  let layerAspect = 0;

  const aspectOf = (r) => (r && r.h > 0 ? r.w / r.h : 0);

  function clearLayer() {
    if (layer && layer.isConnected) layer.remove();
    layer = null;
    layerVideo = null;
    layerLines = null;
    layerAspect = 0;
    if (btn) btn.classList.remove('lt-active', 'lt-busy');
    if (state !== 'busy') state = 'idle';
  }

  // 撤掉「孤儿文字层」。
  //
  // 文字层是跟**某一个视频的某一帧**绑定的：它的位置、行高、字号全是按那帧
  // 的 rect 算出来的。所以一旦主视频换人（页面上第二个够大的视频暂停了），
  // 旧层就失去了它的主人，变成孤儿。
  //
  // 光是孤儿还不算最糟 —— 糟在它**没人清理**：
  //   所有清层分支的判据是 `state === 'active'` 或 `activeVideo === v`，
  //   而换主视频时 showBtn() 已经把 state 打回 idle、activeVideo 也指向新视频，
  //   两个条件孤儿层一个都不满足 ⇒ 连「滚动 / 重定位自动清层」这条兜底都救不了它，
  //   它会一直挂在旧画面上（文字还能被选中复制），直到下次识别 renderLayer 把它顶掉。
  //
  // 表现就是撕裂状态：小标已经跑到画面 B，画面 A 上却还浮着一层 A 的文字。
  function dropStaleLayer() {
    if (!layer) return;
    if (layerVideo && layerVideo !== activeVideo) clearLayer();
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
    // 顺手给裁剪结果做个体检：**全黑 / 几乎全黑 / 有内容但没字** 是完全不同的病。
    // 实测光看「画面里没有识别到文字」这一句，永远分不出是「裁到黑边」还是「那帧真没字」。
    try {
      const data = ctx.getImageData(0, 0, w, h).data;
      let sum = 0, dark = 0, n = 0, maxL = 0;
      for (let i = 0; i < data.length; i += 16) { // 每 4 个像素采一个，够用且快
        const l = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
        sum += l;
        n++;
        if (l < 16) dark++;
        if (l > maxL) maxL = l;
      }
      lastCropStats = {
        裁剪尺寸: w + 'x' + h,
        平均亮度: Math.round(sum / n),
        近黑占比: Math.round((dark / n) * 100) + '%',
        最亮: Math.round(maxL),
      };
    } catch (e) {
      lastCropStats = { 体检失败: String(e) };
    }
    return c.toDataURL('image/png').split(',')[1];
  }

  // ---------- 文本层 ----------

  // 「识别完亮一下再淡出」的提示。抽成函数是因为 onBtnClick 也要用它 ——
  // 自动识别出的层「没亮过」时，第一次手动点击要给它补亮。
  // hintTimer 放在模块级：补亮时得重置计时，否则会被上一次的 timer 提前掐掉。
  //
  // instant 专给「补亮」用：那时层里的 span 早就存在了，直接加 class 会走 CSS 过渡，
  // 而实测在 B 站这种重负载页面上 background 过渡被主线程挤得**两秒才刚起色**
  // （rgba(...,0.016)，目标 0.30），3 秒后又要淡出 —— 等于白亮。
  // 临时关掉过渡即可立刻变蓝，下一帧恢复，之后淡出仍有过渡。
  // 正常识别（renderLayer）用不到这个：span 是新建的，首帧就是蓝色，本来就没有过渡。
  let hintTimer = null;
  function applyHint(el, { instant = false } = {}) {
    const spans = instant ? el.querySelectorAll('.lt-t') : [];
    for (const s of spans) s.style.transition = 'none';
    el.classList.add('lt-hint');
    if (spans.length) {
      requestAnimationFrame(() => {
        for (const s of spans) s.style.transition = '';
      });
    }
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      if (layer === el) el.classList.remove('lt-hint');
    }, 3000);
  }

  // 文本层刻意留在普通 DOM 里（不放进 Shadow DOM）：
  // 这样 Yomitan 这类日语词典扩展能扫描到这些文本节点，从而支持悬停查词。
  // video：这层文字是为哪个视频生成的。显式传进来而不是读 activeVideo ——
  //        识别是异步的，中途主视频可能已经换了人，按 activeVideo 记会把主人记错。
  function renderLayer(lines, f, { showHint = true, video = null } = {}) {
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

    // video 元素自身全屏时无处可挂（见 mountRoot 注释）。
    // 与其「OCR 明明成功了，界面却什么都不出现」，不如明确报错让用户知道原因。
    const root = mountRoot();
    if (!root) {
      throw new Error('视频元素自身全屏时无法叠加文字层，退出全屏（Esc）后再试');
    }
    root.appendChild(el);
    layer = el;
    layerVideo = video || activeVideo;
    layerLines = lines;
    layerAspect = aspectOf(f);

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
    //
    // 亮不亮由调用方决定（见 runRecognize 的 showHint）：
    //   手动点小标     → 亮（用户就是要看位置）
    //   暂停自动识别   → 按面板开关，默认**不亮**（免得一暂停就闪一片蓝）
    // 同时把「这层亮过没有」记在元素上，onBtnClick 靠它判断第一次点击是补亮还是收起。
    el.dataset.ltHinted = showHint ? '1' : '0';
    if (showHint) applyHint(el);
  }

  // ---------- 主流程 ----------

  // 真正干活的识别流程。「手动点小标」和「暂停即自动识别」都走这里，
  // 避免两套逻辑各写一遍、以后改一处忘一处。
  // 两者**唯一的差异**是 showHint：手动恒为 true；自动按面板开关（默认 false）。
  async function runRecognize({ showHint = true } = {}) {
    if (state === 'busy') return;
    if (!isUsable(activeVideo)) return;

    state = 'busy';
    btn.classList.add('lt-busy');
    btn.classList.remove('lt-active');

    const v = activeVideo;
    // 领票：此刻的 taskToken 代表「当前有效」。之后一旦有人 +1，这张票就作废。
    const token = taskToken;

    // 这趟任务是不是已经被后来的事件顶掉了
    const stale = () => token !== taskToken || state !== 'busy';
    // 交接 busy。只有**还握着令牌**的任务才有权解锁 ——
    // 否则过期任务一句 state='idle' 会把后来者刚起的那趟任务直接打死。
    const releaseBusy = () => {
      if (busyToken !== token) return;
      busyToken = -1;
      if (state === 'busy') state = 'idle';
    };

    state = 'busy';
    busyToken = token;
    btn.classList.add('lt-busy');
    btn.classList.remove('lt-active');

    let f = frameRect(v);

    // 出错的现场数据，catch 里一起打出来。
    // 为什么要它：content script 的 console **会显示在扩展的「错误」页上**，
    // 所以用户截一张图，就能看到坐标 / dpr / 截图大小 / OCR 原始行数 / 小标样式 —— 不用来回猜。
    // （实测过：光看「画面里没有识别到文字」这一句，完全分不出是"裁错位置"还是"那帧真没字"）
    let capBytes = 0;
    let ocrRawLines = -1;

    try {
      let cap;
      try {
        // 抓帧前把小标藏起来，免得它自己被拍进画面里
        btn.style.visibility = 'hidden';
        hiddenCount++;
        await nextFrame();
        // 等待隐藏小标的两帧期间，用户可能切了全屏或播放器刚完成布局。
        // 在发起截图前重新取坐标，避免用旧窗口尺寸裁剪新布局的截图。
        if (stale()) { releaseBusy(); return; }
        if (!isUsable(v)) throw new Error('视频已离开页面或不可用，请重新尝试');
        f = frameRect(v);
        if (f.w <= 0 || f.h <= 0) throw new Error('无法获取当前视频画面区域');
        cap = await sendMsg({ type: 'capture' });
      } finally {
        // 用「有几趟任务正在藏小标」的计数决定什么时候恢复显示，而不是直接置空：
        // 两趟任务重叠时，先结束的那趟会把还没抓完的另一趟的小标提前放出来 ——
        // 那颗小标就会被拍进画面里，而且事后完全看不出它为什么会露出来。
        hiddenCount--;
        if (hiddenCount <= 0) {
          hiddenCount = 0;
          btn.style.visibility = '';
        }
      }

      // ⚠️ 验票必须放在 !cap.ok 的判断**之前**。
      //    抓帧结果本身就可能带着失败（cap.ok === false）——那一瞬间还没验过票就 throw，
      //    于是「旧任务的失败」会一路写到「新视频的小标」上（实测复现过）。
      if (stale()) { releaseBusy(); return; }
      if (!cap.ok) throw new Error(cap.error);
      capBytes = (cap.dataUrl || "").length;

      const png = await cropToBase64(cap.dataUrl, f);
      if (stale()) { releaseBusy(); return; }

      const res = await sendMsg({ type: 'ocr', png: png, langs: LANGS });
      if (stale()) { releaseBusy(); return; }
      if (!res.ok) throw new Error(res.error);
      ocrRawLines = (res.lines || []).length;

      const lines = (res.lines || []).filter((l) => l.conf >= MIN_CONF);
      if (!lines.length) throw new Error('画面里没有识别到文字');

      // 截图/OCR 是异步的；期间播放器可能切入全屏或改变布局。
      // OCR 框坐标是相对**截图那一刻的可见区**的归一化坐标，所以落图时要重新取当前画面矩形。
      //
      // ⚠️ 但只有「可见区宽高比没变」时，新矩形才框住源画面的同一块内容，
      //    归一化坐标才等价于原样缩放。比例一变（object-fit: cover 下切全屏就是这种情况），
      //    映射跟着变，套上去会让整层文字错位 —— 与其画错，不如让用户重新识别一次。
      const currentFrame = frameRect(v);
      if (!isUsable(v) || currentFrame.w <= 0 || currentFrame.h <= 0) {
        throw new Error('视频画面已变化，请重新识别');
      }
      if (Math.abs(aspectOf(currentFrame) - aspectOf(f)) > 0.01) {
        throw new Error('识别期间画面比例发生了变化，请重新识别');
      }
      renderLayer(lines, currentFrame, { showHint, video: v });
      state = 'active';
      releaseBusy();
      btn.classList.remove('lt-busy');
      btn.classList.add('lt-active');
      btn.title = '已识别 ' + lines.length + ' 处文字，鼠标移到画面上拖选即可复制';
      console.log('[Live Text] 识别到 ' + lines.length + ' 行，耗时 ' + res.elapsed_ms + 'ms');
    } catch (err) {
      console.error('[Live Text]', err);

      // ── 现场快照（截图式诊断）──
      const diag = (() => {
        try {
          const br = v ? v.getBoundingClientRect() : null;
          const iconEl = btn ? btn.querySelector('svg, img') : null; // 图标现在是 <img>
          const ss = iconEl ? getComputedStyle(iconEl) : null;
          const bs = btn ? getComputedStyle(btn) : null;
          const r2 = (x) => Math.round(x);
          return {
            视频矩形: br ? r2(br.x) + ',' + r2(br.y) + ' ' + r2(br.width) + 'x' + r2(br.height) : null,
            画面区: v ? r2(f.x) + ',' + r2(f.y) + ' ' + r2(f.w) + 'x' + r2(f.h) : null,
            dpr: window.devicePixelRatio,
            视口: window.innerWidth + 'x' + window.innerHeight,
            全屏元素: document.fullscreenElement ? document.fullscreenElement.tagName : null,
            截图字节: capBytes,
            OCR原始行数: ocrRawLines,
            裁剪体检: lastCropStats,
            小标: btn ? btn.className : null,
            小标色: bs ? bs.color + ' / ' + bs.backgroundColor : null,
            图标: iconEl && ss ? iconEl.tagName + ' ' + r2(iconEl.getBoundingClientRect().width) + 'x' + r2(iconEl.getBoundingClientRect().height) + ' display=' + ss.display + ' color=' + ss.color : null,
          };
        } catch (e) {
          return { 诊断失败: String(e) };
        }
      })();
      // ⚠️ 必须 JSON.stringify 拼进**消息字符串**里：
      //    扩展的「错误」页只把第一个参数字符串化，对象参数会显示成 [object Object]（实测踩过）。
      console.error('[Live Text] 诊断 ' + JSON.stringify(diag));

      // ⚠️ 过期任务的失败**一个字都不许写到界面上**。
      //    它是为「出发那一刻的那个视频」跑的，现在小标已经属于别人 ——
      //    把 A 的报错连同 A 的坐标盖到 B 的画面上，比什么都不显示更糟：
      //    用户会照着 A 的坐标去查 B 的毛病（实测复现：B 画面上弹着 A 的抓帧失败）。
      //    日志照打，排障照样用得上；UI 保持新主人自己的样子。
      if (stale()) {
        releaseBusy();
        console.error('[Live Text] 识别任务已过期，只记录不更新界面: token=' + token + ' 当前=' + taskToken);
        return;
      }

      const msg = err && err.message ? err.message : String(err);
      btn.classList.remove('lt-busy');
      btn.classList.add('lt-error');
      // 把错误写到 title 上：content script 的 console 在隔离世界里，
      // 外部工具读不到，写进 DOM 才能被读到
      btn.title = '出错：' + msg + '｜' + JSON.stringify(diag);
      state = 'idle';
      releaseBusy();
      setTimeout(() => {
        if (btn) btn.classList.remove('lt-error');
      }, 2500);
    }
  }

  async function onBtnClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();

    // 已经出过结果了
    if (state === 'active') {
      // 自动识别出的层可能「没亮过」（开关默认关着）。用户点小标就是想看位置 ——
      // 第一次点击先把它补亮，不重跑 OCR、瞬时生效；再点才是收起。
      if (layer && layer.dataset.ltHinted !== '1') {
        layer.dataset.ltHinted = '1';
        // instant：层里的 span 已存在，不让它走那 0.6s（实测被主线程挤到 2s+）的过渡
        applyHint(layer, { instant: true });
        return;
      }
      clearLayer();
      return;
    }

    // ⚠️ 手动触发恒为 showHint = true，**故意不读 SHOW_HINT**。
    // 那个开关只管「暂停自动识别」；手动点击是用户明确的「我要看」动作。
    await runRecognize();
  }

  // 「暂停即自动识别」的入口。
  // 延后 600ms 再动手：拖动进度条会连续产生 pause/play，等状态稳定下来，
  // 期间若用户又播放了、或已经识别过，就放弃这次。
  let autoTimer = null;
  function scheduleAutoRecognize(v) {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      autoTimer = null;
      if (!AUTO_ON_PAUSE) return;
      // 标签页不可见时不自动识别。
      // 抓帧用的是 captureVisibleTab，它只能截当前可见的标签页；后台标签页必然失败。
      // 而后台标签是用户主动切走的，不该给他弹一条"抓帧失败"的错误 —— 那不是他的操作。
      // （同理，面板里那颗小标也没人点得到。）
      if (document.hidden) return;
      if (!v.paused || !isUsable(v)) return;
      if (activeVideo !== v) return;
      if (state !== 'idle') return;
      if (!btn || !btn.classList.contains('lt-show')) return;
      // 自动这条路按面板开关决定要不要亮框（默认不亮：暂停一下就闪一片蓝很烦）
      runRecognize({ showHint: SHOW_HINT });
    }, 600);
  }

  function cancelAutoRecognize() {
    clearTimeout(autoTimer);
    autoTimer = null;
  }

  // ---------- 事件绑定 ----------

  function bindVideo(v) {
    if (!v || v.__ltBound) return;
    v.__ltBound = true;

    v.addEventListener(
      'pause',
      () => {
        // 只认主视频 —— 推荐视频的悬停预览窗也会 pause，
        // 不过滤的话那个小窗上也会冒出小标
        if (!isMainVideo(v)) return;
        showBtn(v);
        // 开了「暂停即识别」就顺手跑一次，不用再点小标。
        // 这里**故意不先判 AUTO_ON_PAUSE**：开关值从 chrome.storage 异步读来，
        // 但 600ms 后定时器真正执行时才读一次 —— 那时值一定已经到位，更稳。
        scheduleAutoRecognize(v);
      },
      true
    );

    // 页面加载时视频本来就可能是暂停的（或在脚本注入前就被暂停了），
    // 这种情况下 pause 事件永远不会再来一次，所以要主动补一次检查。
    //
    // ⚠️ 以前这里只调 showBtn，不调 scheduleAutoRecognize ——
    //    于是「打开页面就是暂停状态」（比如关了自动播放）时，小标出来了但不会自动识别，
    //    必须再手动播放→暂停一次才触发，看着像坏了。
    //
    // 两个收口条件，缺一不可：
    //   bootChecked —— 只补一次，否则后面 durationchange（切清晰度/直播）会反复重跑 OCR
    //   hasPlayed   —— 真播过之后的暂停有 pause 事件走正常流程，不该在这里重复触发
    let bootChecked = false;
    let hasPlayed = false;
    const checkAlreadyPaused = () => {
      if (bootChecked || hasPlayed) return;
      if (!v.paused || !isMainVideo(v)) return;
      bootChecked = true;
      showBtn(v);
      scheduleAutoRecognize(v);
    };
    v.addEventListener('loadedmetadata', checkAlreadyPaused, true);
    v.addEventListener('durationchange', checkAlreadyPaused, true);
    if (v.readyState >= 1) {
      setTimeout(checkAlreadyPaused, 400);
    }

    v.addEventListener(
      'play',
      () => {
        hasPlayed = true;
        // 只有当前主视频播放才会让当前识别任务作废；其他视频的预览播放不能影响它。
        if (activeVideo === v) {
          taskToken++;
          cancelAutoRecognize();
          clearLayer();
          hideBtn();
        }
      },
      true
    );

    v.addEventListener(
      'emptied',
      () => {
        // 只有当前主视频源被清空，才作废当前识别任务。
        if (activeVideo === v) {
          taskToken++;
          clearLayer();
          hideBtn();
          activeVideo = null;
        }
      },
      true
    );
  }

  // ---------- 扫描并绑定页面上的 video ----------
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

  // 全屏切换 / 窗口缩放 / 视频尺寸变化，这三类场景下浏览器要等一帧才会把布局算好。
  // 若事件一到就调 getBoundingClientRect()，拿到的是旧坐标 ——
  // 表现就是「全屏后小标跑到画面外」或「干脆看不见」。
  // 所以统一走这个「等两帧再重定位」的调度器。
  let relocatePending = false;
  function scheduleRelocate() {
    if (relocatePending) return;
    relocatePending = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        relocatePending = false;

        // 主视频切换时仍清理孤儿层；同一视频仅发生布局变化时，
        // 用缓存的归一化 OCR 坐标重排文字框，不重复抓帧或识别。
        if (layer && layerVideo && layerVideo !== activeVideo) {
          clearLayer();
        } else if (state === 'active' && layer && layerLines && layerVideo === activeVideo) {
          const lines = layerLines;
          const video = layerVideo;
          const wasHinted = layer.dataset.ltHinted === '1';
          const hintVisible = layer.classList.contains('lt-hint');
          const f = frameRect(video);
          if (!isUsable(video) || f.w <= 0 || f.h <= 0) {
            clearLayer();
          } else if (Math.abs(aspectOf(f) - layerAspect) > 0.01) {
            // 可见区的宽高比变了 ⇒ 「可见区 → 源画面」的映射也变了，
            // 缓存里的归一化坐标不再对应同一块画面内容，套上去只会整体错位。
            // 画一层位置错的文字比不显示更糟：它照样能被选中、被复制走，等于给出错的数据。
            // 所以这里撤掉，让用户重新识别一次。
            console.warn(
              '[Live Text] 画面比例已变化（' + layerAspect.toFixed(3) + ' → ' + aspectOf(f).toFixed(3) +
              '），缓存的文字坐标不再适用，已撤除文字层；请重新识别'
            );
            clearLayer();
          } else {
            // video 元素自身全屏时没有可用挂载点；保留缓存，退出全屏后再重排。
            const root = mountRoot();
            if (root) {
              const oldW = parseFloat(layer.style.width) || 0;
              const oldH = parseFloat(layer.style.height) || 0;
              // 纯滚动/位移时只移动容器，不重建文字节点，避免破坏当前选区。
              // 若尺寸或全屏挂载根变化，才重排文字框。
              if (layer.parentNode === root && Math.abs(oldW - f.w) < 0.5 && Math.abs(oldH - f.h) < 0.5) {
                layer.style.left = f.x + 'px';
                layer.style.top = f.y + 'px';
              } else {
                renderLayer(lines, f, { showHint: hintVisible, video });
                if (layer) layer.dataset.ltHinted = wasHinted ? '1' : '0';
              }
            }
          }
        } else {
          dropStaleLayer();
        }

        if (!isUsable(activeVideo)) return;
        // ⚠️ 判据是「想不想显示」而不是「当前有没有 lt-show」：
        //    后者在 video 自身全屏期间会被摘掉，用它判断就会导致退出全屏后小标再也回不来。
        if (!wantBtn || !btn) return;

        // 全屏进出时挂载点会变（body ⇄ fullscreenElement）；video 自身全屏则无处可挂，
        // syncBtnMount 会先把它藏起来，等退出全屏再放出来。
        syncBtnMount();
      });
    });
  }

  window.addEventListener('resize', scheduleRelocate, true);
  document.addEventListener('fullscreenchange', scheduleRelocate);

  // 页面滚动不应直接清除识别结果：Safari 风格的文字层应继续跟随视频。
  // scheduleRelocate 会更新位置；仅位置变化时保留原文字节点和当前选区。
  window.addEventListener('scroll', scheduleRelocate, { passive: true, capture: true });

  // ---------- 两段式：第一下只取消选中，第二下才恢复播放 ----------
  //
  // 要的效果（对齐 Safari 实况文本）：
  //   选中画面文字后，**第一下**点旁边空白 → 只取消选中、**不播放**；
  //   **第二下**再点 → 才开始播放。
  //
  // 改之前的行为是「一下就被网站接走、立刻播起来」，根因有两层 ——
  //   · B站 / YouTube 这类播放器**点画面本身就会切换播放** ⇒ 第一下会被网站接走。
  //   · 我们的浮层挂在 document.body 上（不在播放器内部）⇒ 点**被文字块盖住**的区域时，
  //     点击根本传不到网站，那一块就成了死区。
  // 所以两个方向都得补：第一下**由我们吞掉**，第二下**由我们兜底**。

  /** 底部留出多少像素给网站自己的控制栏（进度条 / 音量 / 全屏…）。
   *  这一条带里的点击**完全不接管** —— 点进度条应当按网站原本的行为走。 */
  const CONTROL_STRIP_PX = 60;

  /**
   * 点击目标是不是「播放器自己那一支」的元素。
   *
   * ⚠️ 这条是**必须的保险**，实测踩过坑：
   *   陪读蛙 / Yomitan 这类词典翻译工具的浮条是**普通 `<div>`**（不是 `<button>`），
   *   光靠排除 button/a/[role=...] **拦不住** ✗ —— 用户选完词去点「翻译」，
   *   那一下被我们当成「取消选中」吞掉了 ⇒ **点了没反应** ✗
   *
   * 判据：从点击目标往上游走，**只要撞到 video 本身、或撞到「包含 video 的祖先」**，
   * 就算播放器自己那一支 ✓。
   *   · B站 的播放器浮层（绝对定位）在 `<div class="bpx-player-video-wrap">` 里，
   *     那个容器**也包着 video** ⇒ 判为真 ⇒ 正常接管 ✓
   *   · 陪读蛙 / Yomitan 的浮条挂在 `document.body` 下，是**另一支** ⇒ 判为假 ⇒ 绝不接管 ✓
   *
   * 这是**结构性**判据，不猜 class 名、不看 z-index、也不依赖 position ⇒ 稳。
   */
  function belongsToPlayerSubtree(t) {
    if (!t) return false;
    for (let el = t; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (el === activeVideo) return true;
      if (el.contains && el.contains(activeVideo)) return true;
    }
    return false;
  }

  /** 这次点击是否落在「我们要接管的那片区域」里。 */
  function inOverlayZone(ev) {
    if (!isUsable(activeVideo)) return false;
    // ① 必须属于播放器自己那一支（第三方词典/翻译工具的浮条绝不能被接管）
    if (!belongsToPlayerSubtree(ev.target)) return false;

    const f = frameRect(activeVideo);
    if (ev.clientX < f.x || ev.clientX > f.x + f.w) return false;
    if (ev.clientY < f.y || ev.clientY > f.y + f.h) return false;
    // ② 底部控制栏那一条让给网站（点进度条应当按网站原本的行为走）
    if (ev.clientY > f.y + f.h - CONTROL_STRIP_PX) return false;
    return true;
  }

  /** 点击是不是落在「我们自己的东西」上（小标 / 文字块）。
   *
   *  ⚠️ 小标必须在这里排掉：它本来挂在 body 下（安全），但**全屏时 `mountRoot()` 返回全屏元素**，
   *     小标就被挂进了**播放器子树**里 ⇒ `belongsToPlayerSubtree(btn)` 判为真；
   *     而它的位置（底边内缩 46px）又刚好落在 60px 控制栏**之外** ⇒ `inOverlayZone` 也成立。
   *     于是连踩两坑（实测，只有全屏才复现，非全屏看不出来）：
   *       ① 有选区时点小标 → 那一下被当成"取消选中"吞掉 ⇒ **点了没反应** ✗
   *       ② 「补亮」那一支（state 仍是 'active'，见 onBtnClick）→ 冒泡里的兜底播放被触发
   *          ⇒ **点一下图标，视频自己就播起来了** ✗
   */
  function isOwnUi(t) {
    if (!t || !t.closest) return false;
    return !!(t.closest('.lt-t') || t.closest('#livetext-btn'));
  }

  function hasRealSelection() {
    const sel = window.getSelection();
    return !!sel && !sel.isCollapsed && String(sel).length > 0;
  }

  // ── 手势记录：mousedown 记起点，click 时判断「这一下到底是什么」 ──
  //
  // 三种手势必须分开（都在 state==='active'、都点在画面空白处）：
  //   ① 【点一下】    → 第一下：**取消选中，且不播放**
  //   ② 【拖选收尾】  → **保住刚拖出来的选区**，但别让网站接走这一下（否则它会 toggle 播放）
  //   ③ 【第二下点】  → 交给下面冒泡的兜底播放
  //
  // ⚠️ 判据**不能只看"此刻有没有选区"**：
  //    拖选收尾时浏览器也会补一个 click，那时选区是**新的、非空的** ——
  //    误当成 ① 就会把用户刚拖出来的选区当场抹掉 ✗（实测踩过）
  //    真正的判据是「**mousedown → click 之间鼠标有没有位移**」。
  const DRAG_THRESHOLD_PX = 5;
  let gesture = null; // 本次点击的起点 + 起手时有没有选区

  document.addEventListener(
    'mousedown',
    (ev) => {
      gesture = null;
      // 只认左键。中键/右键（B站 有自己的右键菜单）一律不碰 ——
      // 否则我们那次 stopPropagation 可能把网站的右键菜单一起挡掉。
      if (ev.button !== 0) return;
      if (state !== 'active') return;
      if (!inOverlayZone(ev)) return;
      if (isOwnUi(ev.target)) return; // 文字块上 = 拖选中；小标上 = 点按钮

      gesture = { x: ev.clientX, y: ev.clientY, hadSelection: hasRealSelection() };

      if (gesture.hadSelection) {
        // ⚠️ 这里**只 stopPropagation，绝不 preventDefault**：
        //    preventDefault 会连带禁掉浏览器「拖选」的默认行为 ✗
        //    ⇒ 用户从空白处起手重新拖选时选不中（这个 bug 实测存在过，已修）
        ev.stopPropagation();
      }
    },
    true
  );

  document.addEventListener(
    'click',
    (ev) => {
      const g = gesture;
      gesture = null; // 一次性消费

      if (state !== 'active') return;
      if (!inOverlayZone(ev)) return;
      if (isOwnUi(ev.target)) return;
      if (!g) return; // 没有对应的 mousedown（键盘触发 / 脚本合成）→ 不插手

      const moved =
        Math.abs(ev.clientX - g.x) > DRAG_THRESHOLD_PX ||
        Math.abs(ev.clientY - g.y) > DRAG_THRESHOLD_PX;

      // ① 拖选收尾：**保住新选区**，但把这一下吞掉（网站收不到 ⇒ 不会自己播起来）
      if (moved && hasRealSelection()) {
        ev.stopPropagation();
        return;
      }

      // ② 「第一下」：起手时确实有选区 ⇒ 这一下是「取消选中」
      if (g.hadSelection) {
        ev.preventDefault();
        ev.stopPropagation(); // 吞掉 ⇒ 网站收不到 ⇒ 不会自己播起来
        const sel = window.getSelection();
        if (sel) sel.removeAllRanges(); // 兜一道：确保选区真的清掉
      }
      // ③ 其余情况（起手时本来就没选区）→ 什么都不做，交给下面冒泡的兜底播放
    },
    true
  );

  // ── 第二下：兜底播放。⚠️ 必须走**冒泡**，而且必须**延后一点** ──
  //
  // 为什么要冒泡：capture 阶段我们先跑 → play() → 网站的处理器再跑 → 它 toggle 一下 → 变回暂停 ✗
  //
  // 为什么还要延后 300ms（实测抓到的）：
  //   B站 这类**自研播放器**的点击处理**晚于** document 的冒泡（挂在 window 或自己的状态机上）。
  //   我们一 play()，它随后也按自己的状态 toggle 一次 ⇒ **双重动作** ⇒
  //   实测事件序列 `play@892 → playing@895 → pause@1095`：播起来 200ms 后又被按回去 ✗
  //   所以改成「先等 300ms，看网站有没有自己接走；它没接走我们才补」✓
  //   —— 会响应的网站（B站/YouTube）秒播，用户根本感受不到这 300ms；
  //      只有真不响应的（普通 <video controls>）才会等这 300ms ✓
  const FALLBACK_PLAY_DELAY_MS = 300;

  document.addEventListener(
    'click',
    (ev) => {
      if (state !== 'active') return;
      if (!inOverlayZone(ev)) return;
      if (isOwnUi(ev.target)) return; // 小标 / 文字块上不插手（含"点小标补亮"那一支）
      if (hasRealSelection()) return; // 还有选区 ⇒ 是拖选，不是"第二下"
      if (!activeVideo.paused) return; // 网站已经处理了 → 不插嘴

      const v = activeVideo;
      setTimeout(() => {
        // 再确认一次：这 300ms 里网站可能已经自己播起来了
        if (state === 'active' && v === activeVideo && v.isConnected && v.paused) {
          v.play().catch(() => {});
        }
      }, FALLBACK_PLAY_DELAY_MS);
    },
    false
  );
})();
