# Live Text for Video

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Русский](README.ru.md)

**Pause any video → click the badge in the bottom-right corner → the on-screen text becomes selectable.**

OCR is done by Apple's **Vision framework** — the exact same engine Safari's Live Text uses, so the quality is identical, not "close".

Bonus: the recognized text is a **real DOM text layer**, so dictionary extensions like Yomitan can look up words by hovering over it — not just copy.

![demo](docs/demo.png)

> Pause the video, click the badge, and the on-screen text becomes selectable — the blue blocks mark where text was recognized.

---

## What problem does this solve

Safari shows a Live Text button when you pause a video, and the text on screen can be selected and copied directly.

Chrome can't do this — **a web page sandbox has no access to system OCR**. Pure front-end solutions can only bundle a general-purpose OCR model into the browser, with noticeably worse quality and speed.

This project brings the Safari experience to Chrome with a **Chrome extension + a tiny local helper**: the extension handles the UI and frame grabbing, the helper calls Apple's Vision engine.

---

## Requirements

| Item | Requirement |
|---|---|
| OS | **macOS 13 or later** (earlier versions lack the "auto language detection" capability) |
| CPU | Apple Silicon or Intel (the backend is a Universal Binary) |
| Browser | Chrome / Edge / Brave / Vivaldi / Opera (Chromium-based) |
| To compile the backend | Command Line Tools: `xcode-select --install` |

> **Windows / Linux won't work** — the engine is macOS-exclusive.
> **Safari is not supported** — its extension API is incompatible with Chrome's.
> **Different macOS users** on the same Mac each need to run the installer once (registration is per-user).

---

## Install

### Step 1: clone and register

```bash
git clone https://github.com/ChenZhuo4649/live-text-for-video.git
cd live-text-for-video
./install.sh
```

The script will:

1. Check the OS version and CPU architecture
2. Prepare the OCR backend — skip if a working one exists, otherwise compile a **Universal Binary** with your local `swiftc`
3. **Register the backend with every Chromium-based browser** on this machine
4. Print the steps to install the extension

### Step 2: install the extension

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder in this repo

The extension ID should read:

```
hmigekegioajglfmifdfofilgigpbcah
```

> **This ID is derived from the public key embedded in the extension, independent of the install path.**
> It stays the same across computers, folders, and browsers — which is why the installer never asks you to copy an ID.

If the shown ID differs, **remove the extension and load it again**.

---

## Usage

1. Open any video page (YouTube, Bilibili, anywhere)
2. **Pause**
3. A small round badge appears in the **bottom-right corner of the video**
4. **Click it**
5. Wait ~0.5–1s — the on-screen text becomes selectable, and briefly **flashes a light blue background** to show you where the text is
6. **Drag to select → `Cmd+C`**
7. **Click the badge again** to dismiss; the video goes back to being clean

Hovering over a text block re-highlights it, so you can find it again.

---

### Optional: recognize automatically on pause

![extension panel](docs/popup.png)

Click the extension icon and tick **"Pause to recognize"** — after that the text appears as
soon as you pause, with no need to click the badge.

The trade-off: every pause runs one recognition pass (~0.5–1s), so it is **off by default**.

## Recognition quality (measured)

| Content type | Result |
|---|---|
| URLs, code, large high-contrast text | ✅ Perfect, character for character |
| Chinese / Japanese subtitles | ✅ Perfect |
| Dense terminal text | ✅ 72% of 128 lines scored perfect |
| Low-contrast grey text | ❌ Fails — but confidence drops to 0.3, so you can tell which results to distrust |

Timing: **0.5–1s** for typical frames; ~**1.1s** for a dense terminal screen.

---

## Language

**Automatically detects the language by default** (via Vision's `automaticallyDetectsLanguage`), handling Chinese, English and Japanese out of the box.

> **Why you can't just pass both `ja-JP` and `zh-Hans`**: Vision's language packs are **mutually exclusive**.
> When both are supplied, Chinese gets "Japanified" into traditional or Japanese kanji variants
> (师→姉, 试→試, 给→給, 这→汶), and it takes nearly twice as long.
> Measured on the same Japanese exam screenshot: `zh-Hans` alone produced **11 lines**, `auto` produced **44**.

If you know the frame contains only one language, specifying it manually is **faster**: click the extension icon → pick "中文 + 英文" or "日文 + 英文". It takes effect immediately.

---

## Using with Japanese dictionary extensions (Yomitan, etc.)

The text layer is **deliberately left in the normal DOM** (not hidden inside a Shadow DOM) — so dictionary extensions like Yomitan can scan it and you can **look up words by holding Shift and hovering**, instead of copying text out first.

Three specific adaptations were made for this:

| Adaptation | Why |
|---|---|
| `color: #fff` + `-webkit-text-fill-color: transparent` | Dictionary extensions may use `color` to decide whether text is "visible body text"; a direct `transparent` can get skipped. This way the color is white and only the fill is transparent — visually identical (invisible), but friendlier to that check |
| **Two-step width calibration** (adaptive font size + letter-spacing) | Dictionaries map "mouse coordinate → character index". If the rendered width doesn't match the on-screen width, the character index **drifts cumulatively** — the symptom is "words near the start of a line are accurate, and it gets worse toward the end" |
| **Half-width spaces → full-width** in CJK text | OCR often returns half-width spaces (about 1/4 the width of full-width), which shifts everything after the space |

**How the two-step calibration works**:

```js
// Step 1: derive a suitable font size from the actual rendered width
// (adjusting letter-spacing alone makes characters overlap when the font is too large —
//  it looks cramped and positioning gets blunt)
newSize = curSize * (targetWidth / naturalWidth)   // clamped to 0.6–1.7x against OCR noise

// Step 2: mop up the remainder with letter-spacing
letterSpacing = (targetWidth - naturalWidth) / (charCount - 1)
```

After calibration the measured **width error is 0 and letter-spacing is ~0**.

> ⚠️ **Do not use `transform: scaleX` for this** — it interferes with mouse hit-testing and breaks both drag-selection and hover positioning.

---

## How it works

```
video paused
   └→ content.js draws a badge at the video's bottom-right (its own DOM, never touches the player)
        └→ you click it
             ├→ sw.js calls chrome.tabs.captureVisibleTab
             │       (captures composited pixels, sidestepping cross-origin canvas taint)
             ├→ content.js crops the video area out with a canvas (dropping letterboxing)
             ├→ sends it over a Native Messaging pipe to the local backend (no network)
             ├→ the backend runs Vision, returning text + normalized coordinates + confidence
             └→ content.js overlays a "transparent but selectable" text layer in place
```

Two details worth knowing:

- **Coordinate flip**: Vision returns normalized coordinates with the origin at the **bottom-left**, CSS uses top-left, so a vertical flip happens at render time.
- **Capture timing**: the badge hides itself before the screenshot, otherwise it gets captured and OCR'd as part of the frame.

---

## Known limitations

| Limitation | Notes |
|---|---|
| Player UI gets recognized too | We capture **composited screen pixels**, so progress bars and button labels get picked up. Safari doesn't have this problem (it uses the video frame itself) |
| DRM content won't work | Netflix and similar yield black frames |
| Rare one-character lookup drift | Kanji / kana / digits / punctuation have inherently different widths and can't be perfectly aligned |
| Developer mode prompt | Chrome shows "Disable developer mode extensions" on cold start — a routine notice that doesn't affect functionality |

---

## Troubleshooting

Logs go to the **page's own console** (not the extension page): press `F12` on the video page → Console → look for `[Live Text]`.

| Symptom | Cause | Fix |
|---|---|---|
| No badge appears | Page not fully loaded, or the site doesn't use `<video>` | Reload the page |
| `本机 OCR 后端未连接：...forbidden` | Your extension ID isn't in the registration file | Re-run `./install.sh`; if it persists, restart the browser |
| `Error when communicating with the native messaging host` | Backend failed to start | Run `./host/livetext-ocr --help` manually to see if it executes |
| `画面里没有识别到文字` | That frame genuinely has no text, or it's too small | Try a frame with text |
| Garbled recognition | Language was misdetected | Click the extension icon and pick the language manually |

---

## Uninstall

1. `chrome://extensions` → find **Live Text for Video** → **Remove**
2. Delete the registration files (adjust the browser folder as needed — also check Chromium / BraveSoftware/Brave-Browser / Microsoft Edge / Vivaldi):

```bash
rm "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.livetext.videoocr.json"
```

3. Delete the repository folder

**Zero impact on other extensions**, no leftovers.

---

## Privacy

**Your images never leave your computer.** The whole pipeline is:

```
extension captures a frame → local stdio pipe → on-device Vision OCR → text back
```

No network requests, no cloud APIs, no telemetry.

---

## Development

### Layout

```
live-text-for-video/
├── install.sh                    one-shot setup: prepare backend + register
├── host/
│   ├── livetext-ocr.swift        backend source (OCR / draw / langs / stdio modes)
│   ├── build.sh                  builds a Universal Binary (arm64 + x86_64)
│   └── livetext-ocr              build output (excluded by .gitignore)
├── extension/
│   ├── manifest.json             includes `key` (public key) to pin the extension ID
│   ├── content.js                main injected logic
│   ├── content.css               badge & text layer styles
│   ├── sw.js                     service worker (screenshot + forwarding)
│   ├── popup.html / popup.js     language switcher
│   └── icons/
├── poc/                          protocol self-test tool and sample images
└── PoC-结果报告.md                full measured data behind the quality numbers
```

### How changes take effect

| Changed | To apply |
|---|---|
| js / css / html under `extension/` | Click **reload** for the extension on `chrome://extensions`, then reload the video page |
| Swift source under `host/` | Re-run `./build.sh` — **no browser restart needed** (the backend process is spawned fresh on every call) |
| The registration manifest itself | Re-run `./install.sh`; if it still doesn't take, restart the browser (the manifest is cached) |

### Using the backend standalone (without a browser)

```bash
cd host
./livetext-ocr ../poc/real_easy.jpg                    # recognize, JSON to stdout
./livetext-ocr ../poc/real_easy.jpg --min-conf=0.5     # filter low-confidence lines
./livetext-ocr ../poc/real_easy.jpg --langs=auto       # auto-detect language (default)
./livetext-ocr langs                                   # list languages available on this Mac
./livetext-ocr draw img.png result.json -o boxes.png   # draw the boxes back onto the image to eyeball accuracy
```

### Testing the messaging protocol independently

You can validate the "4-byte length prefix + JSON" protocol without a browser:

```bash
python3 poc/test_stdio.py host/livetext-ocr poc/real_easy.jpg
```

---

## License

MIT
