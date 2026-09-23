# Live Text for Video

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | **Español** | [Русский](README.ru.md)

**Pausa cualquier vídeo → haz clic en el icono de la esquina inferior derecha → el texto en pantalla se vuelve seleccionable.**

El reconocimiento lo realiza el **framework Vision** de Apple — **exactamente el mismo motor** que usa Live Text en Safari, así que la calidad es idéntica.

Extra: el texto reconocido es una **capa de texto DOM real**, por lo que extensiones de diccionario como Yomitan pueden buscar palabras al pasar el ratón — sin necesidad de copiarlas.

> Este documento es un resumen. La versión completa está en el [README en inglés](README.md).

![demo](docs/demo.png)

> Pausa el vídeo y haz clic en el icono: el texto se vuelve seleccionable. Las zonas azules marcan el texto reconocido.

---

## Qué problema resuelve

Safari muestra un botón de Live Text al pausar un vídeo, y el texto en pantalla se puede seleccionar y copiar directamente.

Chrome no puede hacerlo — **el entorno aislado de una página web no tiene acceso al OCR del sistema**. Las soluciones puramente front-end solo pueden incluir un modelo OCR genérico en el navegador, con peor calidad y velocidad.

Este proyecto lleva esa experiencia a Chrome con una **extensión de Chrome + un pequeño asistente local**: la extensión gestiona la interfaz y la captura de fotogramas, y el asistente llama al motor Vision de Apple.

---

## Requisitos

| Elemento | Requisito |
|---|---|
| Sistema | **macOS 13 o superior** (las versiones anteriores no tienen detección automática de idioma) |
| CPU | Apple Silicon o Intel (el backend es un Universal Binary) |
| Navegador | Chrome / Edge / Brave / Vivaldi / Opera (basados en Chromium) |
| Para compilar el backend | Command Line Tools: `xcode-select --install` |

> **Windows / Linux no funcionan** — el motor es exclusivo de macOS.
> **Safari no es compatible** — su API de extensiones es incompatible con la de Chrome.

---

## Instalación

### Paso 1: clonar y registrar

```bash
git clone https://github.com/ChenZhuo4649/live-text-for-video.git
cd live-text-for-video
./install.sh
```

El script:

1. Comprueba la versión del sistema y la arquitectura de la CPU
2. Prepara el backend OCR — se omite si ya existe uno funcional; si no, compila un **Universal Binary** con `swiftc`
3. **Registra el backend en todos los navegadores Chromium** del equipo
4. Muestra los pasos para instalar la extensión

### Paso 2: instalar la extensión

1. Abre `chrome://extensions`
2. Activa el **modo de desarrollador** (arriba a la derecha)
3. Haz clic en **Cargar descomprimida** y selecciona la carpeta `extension/` del repositorio

El ID de la extensión debe ser:

```
hmigekegioajglfmifdfofilgigpbcah
```

> **Este ID se deriva de la clave pública incluida en la extensión, independientemente de la ruta de instalación.**
> Se mantiene igual entre equipos, carpetas y navegadores.

---

## Uso

1. Abre cualquier página con vídeo
2. **Pausa**
3. Aparece un **pequeño icono redondo abajo a la derecha del vídeo**
4. **Haz clic en él**
5. Espera de 0,5 a 1 s — el texto se vuelve seleccionable y **parpadea brevemente con fondo azul claro** para indicar dónde hay texto
6. **Selecciona arrastrando → `Cmd+C`**
7. **Haz clic otra vez en el icono** para ocultarlo

---

## Calidad de reconocimiento (medida)

| Tipo de contenido | Resultado |
|---|---|
| URL, código, texto grande de alto contraste | ✅ Perfecto |
| Subtítulos en chino / japonés | ✅ Perfecto |
| Texto denso de terminal | ✅ 72 % de 128 líneas perfectas |
| Texto gris de bajo contraste | ❌ Falla — pero la confianza baja a 0,3, lo que permite detectar resultados dudosos |

Tiempo: **0,5–1 s** en imágenes típicas; ~**1,1 s** en pantallas de terminal densas.

---

## Idioma

**Detección automática por defecto** (mediante `automaticallyDetectsLanguage` de Vision): chino, inglés y japonés funcionan sin configuración.

> **Por qué no pasar `ja-JP` y `zh-Hans` juntos**: los paquetes de idioma de Vision son **mutuamente excluyentes**.
> Si se pasan ambos, el chino se «japoniza» a variantes tradicionales o kanji
> (师→姉, 试→試, 给→給, 这→汶), y tarda casi el doble.
> Medido en la misma captura de examen japonés: solo `zh-Hans` → **11 líneas**, `auto` → **44**.

Si sabes que la imagen contiene un solo idioma, especificarlo manualmente es **más rápido**: haz clic en el icono de la extensión → « 中文 + 英文 » o « 日文 + 英文 ».

---

## Uso con diccionarios japoneses (Yomitan, etc.)

La capa de texto está **deliberadamente en el DOM normal** (no oculta en un Shadow DOM) — así extensiones de diccionario como Yomitan pueden escanearla y puedes **buscar palabras manteniendo Shift y pasando el ratón**.

Se hicieron tres adaptaciones:

| Adaptación | Motivo |
|---|---|
| `color: #fff` + `-webkit-text-fill-color: transparent` | Algunas extensiones de diccionario usan `color` para decidir si el texto es «visible»; un `transparent` directo puede ignorarse |
| **Calibración de ancho en dos pasos** (tamaño de fuente adaptativo + letter-spacing) | Los diccionarios asocian «coordenada del ratón → índice de carácter». Si el ancho renderizado no coincide con el real, el índice **se desvía de forma acumulativa** |
| **Espacios de medio ancho → ancho completo** en texto CJK | El OCR suele devolver espacios de medio ancho (≈1/4 del ancho), desplazando todo lo que va después |

> ⚠️ **No uses `transform: scaleX` para esta calibración** — interfiere con el hit-testing del ratón y rompe tanto la selección como el posicionamiento al pasar el cursor.

---

## Limitaciones conocidas

| Limitación | Detalle |
|---|---|
| También se reconoce la interfaz del reproductor | Capturamos **píxeles compuestos**, así que la barra de progreso y los textos de los botones salen en la captura. Safari no tiene este problema |
| El contenido con DRM no funciona | Netflix y similares generan fotogramas negros |
| Raro desfase de un carácter | Kanji / kana / dígitos / puntuación tienen anchos intrínsecamente distintos |
| Aviso del modo desarrollador | Chrome muestra «Desactivar extensiones del modo desarrollador» al arrancar — sin impacto en el funcionamiento |

---

## Privacidad

**Tus imágenes nunca salen del ordenador.**

```
la extensión captura un fotograma → tubería stdio local → OCR Vision en el dispositivo → devuelve el texto
```

Sin peticiones de red, sin API en la nube, sin telemetría.

---

## Desinstalación

1. `chrome://extensions` → **Live Text for Video** → **Eliminar**
2. Borra los archivos de registro (ajusta la carpeta del navegador según corresponda):

```bash
rm "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.livetext.videoocr.json"
```

3. Borra la carpeta del repositorio

---

## License

MIT
