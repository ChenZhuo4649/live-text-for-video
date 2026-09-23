# Live Text for Video

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | **Français** | [Deutsch](README.de.md) | [Español](README.es.md) | [Русский](README.ru.md)

**Mettez une vidéo en pause → cliquez sur l'icône en bas à droite → le texte affiché devient sélectionnable.**

La reconnaissance est assurée par le **framework Vision** d'Apple — **exactement le même moteur** que le Live Text de Safari, donc une qualité identique.

Bonus : le texte reconnu est une **vraie couche de texte DOM**, donc les extensions de dictionnaire comme Yomitan peuvent rechercher un mot en survolant — sans avoir à le copier.

> Ce document est un résumé. La version complète est dans le [README anglais](README.md).

![demo](docs/demo.png)

> Mettez la vidéo en pause et cliquez sur l'icône : le texte devient sélectionnable. Les zones bleues indiquent le texte reconnu.

---

## Quel problème cela résout-il

Safari affiche un bouton Live Text lorsque vous mettez une vidéo en pause, et le texte à l'écran peut être sélectionné et copié directement.

Chrome ne sait pas le faire — **un bac à sable de page web n'a aucun accès à l'OCR du système**. Les solutions purement front-end ne peuvent qu'embarquer un modèle OCR générique dans le navigateur, avec une qualité et une vitesse nettement inférieures.

Ce projet transpose cette expérience dans Chrome grâce à une **extension Chrome + un petit assistant local** : l'extension gère l'interface et la capture d'image, l'assistant appelle le moteur Vision d'Apple.

---

## Prérequis

| Élément | Exigence |
|---|---|
| Système | **macOS 13 ou supérieur** (les versions antérieures n'ont pas la détection automatique de langue) |
| Processeur | Apple Silicon ou Intel (le backend est un Universal Binary) |
| Navigateur | Chrome / Edge / Brave / Vivaldi / Opera (moteur Chromium) |
| Pour compiler le backend | Command Line Tools : `xcode-select --install` |

> **Windows / Linux ne fonctionneront pas** — le moteur est exclusif à macOS.
> **Safari n'est pas pris en charge** — son API d'extension est incompatible avec celle de Chrome.

---

## Installation

### Étape 1 : cloner et enregistrer

```bash
git clone https://github.com/ChenZhuo4649/live-text-for-video.git
cd live-text-for-video
./install.sh
```

Le script va :

1. Vérifier la version du système et l'architecture du processeur
2. Préparer le backend OCR — ignoré si un backend fonctionnel existe, sinon compilation d'un **Universal Binary** avec `swiftc`
3. **Enregistrer le backend auprès de tous les navigateurs Chromium** de la machine
4. Afficher les étapes d'installation de l'extension

### Étape 2 : installer l'extension

1. Ouvrez `chrome://extensions`
2. Activez le **mode développeur** (en haut à droite)
3. Cliquez sur **Charger l'extension non empaquetée** et sélectionnez le dossier `extension/` du dépôt

L'identifiant de l'extension doit être :

```
hmigekegioajglfmifdfofilgigpbcah
```

> **Cet identifiant dérive de la clé publique intégrée à l'extension, indépendamment du chemin d'installation.**
> Il reste identique d'un ordinateur, d'un dossier et d'un navigateur à l'autre.

---

## Utilisation

1. Ouvrez n'importe quelle page vidéo (YouTube, etc.)
2. **Mettez en pause**
3. Une petite icône ronde apparaît en **bas à droite de la vidéo**
4. **Cliquez dessus**
5. Attendez environ 0,5 à 1 s — le texte devient sélectionnable et **un fond bleu clair clignote brièvement** pour vous montrer où il se trouve
6. **Sélectionnez à la souris → `Cmd+C`**
7. **Cliquez à nouveau sur l'icône** pour tout masquer

---

### Option : reconnaissance automatique à la pause

![extension panel](docs/popup.png)

Cliquez sur l'icône de l'extension et cochez **« Reconnaître à la pause »** —
le texte apparaît alors dès la mise en pause, sans cliquer sur le bouton.

En contrepartie, chaque pause lance une reconnaissance (≈ 0,5–1 s), donc c'est **désactivé par défaut**.

## Qualité de reconnaissance (mesurée)

| Type de contenu | Résultat |
|---|---|
| URL, code, texte large à fort contraste | ✅ Parfait |
| Sous-titres chinois / japonais | ✅ Parfait |
| Texte de terminal dense | ✅ 72 % des 128 lignes parfaites |
| Texte gris à faible contraste | ❌ Échoue — mais la confiance tombe à 0,3, ce qui permet d'identifier les résultats douteux |

Durée : **0,5 à 1 s** pour une image classique ; environ **1,1 s** pour un écran de terminal dense.

---

## Langue

**Détection automatique par défaut** (via `automaticallyDetectsLanguage` de Vision) : chinois, anglais et japonais sont gérés nativement.

> **Pourquoi ne pas passer `ja-JP` et `zh-Hans` ensemble** : les packs de langues de Vision sont **mutuellement exclusifs**.
> Fournis ensemble, le chinois est « japonisé » en caractères traditionnels ou en variantes kanji
> (师→姉, 试→試, 给→給, 这→汶), et le traitement prend presque deux fois plus de temps.
> Mesuré sur la même capture d'examen japonais : `zh-Hans` seul → **11 lignes**, `auto` → **44**.

Si vous savez que l'image ne contient qu'une langue, la préciser manuellement est **plus rapide** : cliquez sur l'icône de l'extension → « 中文 + 英文 » ou « 日文 + 英文 ».

---

## Utilisation avec les dictionnaires japonais (Yomitan, etc.)

La couche de texte est **volontairement placée dans le DOM normal** (et non masquée dans un Shadow DOM) — les extensions de dictionnaire comme Yomitan peuvent donc la parcourir et vous pouvez **rechercher un mot en maintenant Shift et en survolant**.

Trois adaptations ont été faites pour cela :

| Adaptation | Raison |
|---|---|
| `color: #fff` + `-webkit-text-fill-color: transparent` | Certaines extensions de dictionnaire utilisent `color` pour juger si le texte est « visible » ; un `transparent` direct peut être ignoré |
| **Calibrage de largeur en deux étapes** (taille de police adaptative + letter-spacing) | Les dictionnaires associent « coordonnée souris → index de caractère ». Si la largeur rendue diffère de la largeur réelle, l'index **dérive cumulativement** |
| **Espaces demi-largeur → pleine largeur** dans le texte CJK | L'OCR renvoie souvent des espaces demi-largeur (environ 1/4 de la largeur), ce qui décale tout ce qui suit |

> ⚠️ **N'utilisez pas `transform: scaleX` pour ce calibrage** — cela perturbe le hit-testing de la souris et casse la sélection à la souris ainsi que le positionnement au survol.

---

## Limites connues

| Limite | Détail |
|---|---|
| L'interface du lecteur est aussi reconnue | Nous capturons des **pixels composites**, donc la barre de progression et les libellés des boutons apparaissent. Safari n'a pas ce problème |
| Contenu DRM inutilisable | Netflix et similaires donnent une image noire |
| Rare décalage d'un caractère | Kanji / kana / chiffres / ponctuation ont des largeurs intrinsèquement différentes |
| Avertissement du mode développeur | Chrome affiche « Désactiver les extensions du mode développeur » au démarrage — sans impact sur le fonctionnement |

---

## Confidentialité

**Vos images ne quittent jamais votre ordinateur.**

```
L'extension capture une image → tube stdio local → OCR Vision sur l'appareil → renvoi du texte
```

Aucune requête réseau, aucune API cloud, aucune télémétrie.

---

## Désinstallation

1. `chrome://extensions` → **Live Text for Video** → **Supprimer**
2. Supprimez les fichiers d'enregistrement (adaptez le dossier selon le navigateur) :

```bash
rm "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.livetext.videoocr.json"
```

3. Supprimez le dossier du dépôt

---

## License

MIT
