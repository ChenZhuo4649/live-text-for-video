# Live Text for Video

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | **Deutsch** | [Español](README.es.md) | [Русский](README.ru.md)

**Video pausieren → auf das Symbol unten rechts klicken → der Text im Bild wird auswählbar.**

Die Erkennung übernimmt Apples **Vision-Framework** — **genau dieselbe Engine** wie Safaris „Live Text", also identische Qualität.

Bonus: Der erkannte Text liegt als **echte DOM-Textebene** vor, daher können Wörterbuch-Erweiterungen wie Yomitan Wörter per Hover nachschlagen — ohne sie vorher kopieren zu müssen.

> Dieses Dokument ist eine Kurzfassung. Die vollständige Version steht im [englischen README](README.md).

![demo](docs/demo.png)

> Video pausieren und auf das Symbol klicken — der Text wird auswählbar. Blaue Flächen zeigen erkannten Text.

---

## Welches Problem wird gelöst

Safari zeigt beim Pausieren eines Videos einen Live-Text-Button, und der Text im Bild lässt sich direkt auswählen und kopieren.

Chrome kann das nicht — **eine Web-Sandbox hat keinen Zugriff auf die systemeigene OCR**. Reine Frontend-Lösungen können nur ein Allzweck-OCR-Modell in den Browser packen, mit deutlich schlechterer Qualität und Geschwindigkeit.

Dieses Projekt bringt das Safari-Erlebnis per **Chrome-Erweiterung + kleinem lokalen Helfer** nach Chrome: Die Erweiterung übernimmt Oberfläche und Frame-Aufnahme, der Helfer ruft Apples Vision-Engine auf.

---

## Voraussetzungen

| Punkt | Anforderung |
|---|---|
| System | **macOS 13 oder neuer** (ältere Versionen haben keine automatische Spracherkennung) |
| CPU | Apple Silicon oder Intel (das Backend ist ein Universal Binary) |
| Browser | Chrome / Edge / Brave / Vivaldi / Opera (Chromium-Basis) |
| Zum Kompilieren des Backends | Command Line Tools: `xcode-select --install` |

> **Windows / Linux funktionieren nicht** — die Engine ist macOS-exklusiv.
> **Safari wird nicht unterstützt** — dessen Erweiterungs-API ist mit Chrome inkompatibel.

---

## Installation

### Schritt 1: Klonen und registrieren

```bash
git clone https://github.com/ChenZhuo4649/live-text-for-video.git
cd live-text-for-video
./install.sh
```

Das Skript:

1. Prüft Systemversion und CPU-Architektur
2. Bereitet das OCR-Backend vor — vorhandenes wird genutzt, sonst wird mit `swiftc` ein **Universal Binary** kompiliert
3. **Registriert das Backend bei allen Chromium-Browsern** auf diesem Mac
4. Gibt die Schritte zur Installation der Erweiterung aus

### Schritt 2: Erweiterung installieren

1. `chrome://extensions` öffnen
2. **Entwicklermodus** oben rechts einschalten
3. **„Entpackte Erweiterung laden"** anklicken und den Ordner `extension/` auswählen

Die Erweiterungs-ID sollte lauten:

```
hmigekegioajglfmifdfofilgigpbcah
```

> **Diese ID leitet sich aus dem eingebetteten öffentlichen Schlüssel ab und ist unabhängig vom Installationspfad.**
> Sie bleibt über Computer, Ordner und Browser hinweg gleich.

---

## Verwendung

1. Eine beliebige Videoseite öffnen
2. **Pausieren**
3. Unten rechts im Video erscheint ein **kleines rundes Symbol**
4. **Darauf klicken**
5. Nach etwa 0,5–1 s wird der Text auswählbar und **blinkt kurz hellblau auf**, damit Sie sehen, wo Text liegt
6. **Mit der Maus markieren → `Cmd+C`**
7. **Erneut auf das Symbol klicken**, um alles auszublenden

---

## Erkennungsqualität (gemessen)

| Inhaltstyp | Ergebnis |
|---|---|
| URLs, Code, großer kontrastreicher Text | ✅ Perfekt |
| Chinesische / japanische Untertitel | ✅ Perfekt |
| Dichter Terminal-Text | ✅ 72 % von 128 Zeilen perfekt |
| Kontrastarmer grauer Text | ❌ Scheitert — die Konfidenz fällt jedoch auf 0,3, sodass unzuverlässige Ergebnisse erkennbar sind |

Dauer: **0,5–1 s** bei typischen Bildern; ca. **1,1 s** bei dichten Terminal-Screens.

---

## Sprache

**Standardmäßig automatische Spracherkennung** (über `automaticallyDetectsLanguage` von Vision) — Chinesisch, Englisch und Japanisch funktionieren direkt.

> **Warum nicht `ja-JP` und `zh-Hans` zusammen übergeben**: Die Sprachpakete von Vision sind **gegenseitig ausschließend**.
> Werden beide übergeben, wird Chinesisch zu traditionellen oder japanischen Kanji-Varianten „japanisiert"
> (师→姉, 试→試, 给→給, 这→汶), und es dauert fast doppelt so lange.
> Gemessen am selben japanischen Prüfungsbild: nur `zh-Hans` → **11 Zeilen**, `auto` → **44**.

Wenn nur eine Sprache vorkommt, ist manuelle Angabe **schneller**: Erweiterungssymbol anklicken → „中文 + 英文" oder „日文 + 英文".

---

## Zusammen mit japanischen Wörterbüchern (Yomitan usw.)

Die Textebene liegt **bewusst im normalen DOM** (nicht in einem Shadow DOM versteckt) — so können Wörterbuch-Erweiterungen wie Yomitan sie erfassen, und Sie können **mit gedrückter Shift-Taste per Hover nachschlagen**.

Dafür wurden drei Anpassungen vorgenommen:

| Anpassung | Grund |
|---|---|
| `color: #fff` + `-webkit-text-fill-color: transparent` | Manche Wörterbuch-Erweiterungen prüfen `color`, um zu entscheiden, ob Text „sichtbar" ist; ein direktes `transparent` kann übersprungen werden |
| **Zweistufige Breitenkalibrierung** (adaptive Schriftgröße + letter-spacing) | Wörterbücher bilden „Mauskoordinate → Zeichenindex" ab. Stimmt die gerenderte Breite nicht mit der tatsächlichen überein, **driftet der Index kumulativ** |
| **Halbbreite Leerzeichen → Vollbreite** in CJK-Text | OCR liefert oft halbbreite Leerzeichen (ca. 1/4 der Breite), wodurch alles danach verrutscht |

> ⚠️ **Verwenden Sie dafür kein `transform: scaleX`** — es stört das Maus-Hit-Testing und zerstört sowohl Textauswahl als auch Hover-Positionierung.

---

## Bekannte Einschränkungen

| Einschränkung | Details |
|---|---|
| Player-Oberfläche wird mit erkannt | Wir erfassen **komponierte Bildschirmpixel**, daher erscheinen Fortschrittsbalken und Button-Beschriftungen. Safari hat dieses Problem nicht |
| DRM-Inhalte funktionieren nicht | Netflix und Ähnliches liefern schwarze Bilder |
| Seltene Verschiebung um ein Zeichen | Kanji / Kana / Ziffern / Satzzeichen haben naturgemäß unterschiedliche Breiten |
| Entwicklermodus-Hinweis | Chrome zeigt beim Start „Entwicklermodus-Erweiterungen deaktivieren" — ohne Auswirkung auf die Funktion |

---

## Datenschutz

**Ihre Bilder verlassen den Computer nicht.**

```
Erweiterung nimmt einen Frame auf → lokale stdio-Pipe → Vision-OCR auf dem Gerät → Text zurück
```

Keine Netzwerkanfragen, keine Cloud-APIs, keine Telemetrie.

---

## Deinstallation

1. `chrome://extensions` → **Live Text for Video** → **Entfernen**
2. Registrierungsdateien löschen (Ordner ggf. an den Browser anpassen):

```bash
rm "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.livetext.videoocr.json"
```

3. Den Repository-Ordner löschen

---

## License

MIT
