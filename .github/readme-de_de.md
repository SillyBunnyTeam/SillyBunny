<div>
<img src="screenshots/banner.jpg" width="100%">
</div>

<div align="center">

[English](readme.md) | Deutsch | [中文](readme-zh_cn.md) | [繁體中文](readme-zh_tw.md) | [日本語](readme-ja_jp.md) | [Русский](readme-ru_ru.md) | [한국어](readme-ko_kr.md)

</div>

<div align="center">

**Aktuelles Release: v1.7.0.** [Die Änderungsprotokolle findest du in unseren Releases.](https://github.com/SillyBunnyTeam/SillyBunny/releases)

</div>

---

## Inhaltsverzeichnis
* [Projektinfo](#projektinfo)
    * [Vorschau](#vorschau)
        * [Desktop](#desktop)
        * [Mobilgeräte](#mobilgeräte)
* [Installation](#installation)
    * [Staging-Branch](#staging-branch)
    * [Hinweise zu macOS](#hinweise-zu-macos)
    * [Hinweise zu Termux (Android)](#hinweise-zu-termux-android)
    * [Aktualisierung](#aktualisierung)
* [Projektziele (oder: Warum wir diesen Fork erstellt haben)](#projektziele-oder-warum-wir-diesen-fork-erstellt-haben)
* [Funktionen und Neuerungen](#funktionen-und-neuerungen)
* [Upstream-Informationen](#upstream-informationen)
* [Mitwirkende](#mitwirkende)
***

## Projektinfo

SillyBunny ist ein eleganter Fork von [SillyTavern](https://github.com/SillyTavern/SillyTavern) mit einer übersichtlichen grafischen Shell-Oberfläche für Desktop- und Mobilgeräte, die vom [GNOME-Projekt](https://www.gnome.org/) und von [KDE Plasma](https://kde.org/plasma-desktop/) inspiriert ist. SillyBunny bietet eine Bun-basierte Laufzeitumgebung für bessere Leistung, eine schnell zugängliche Home-Seite mit integrierten Tutorials, Anleitungen und empfohlenen Erweiterungen, ein schlankes agentenbasiertes System im Chat für moderne Agentenfunktionen, zusätzliche Chat-Modi für mehr Möglichkeiten mit deinen Charakterkarten sowie zahlreiche Fehlerbehebungen und allgemeine Verbesserungen!

> [!WARNING]
> Wir sind ein kleines Team aus drei Personen und arbeiten mit Leidenschaft an einem einfachen, effektiven Frontend, das all die Funktionen bietet, die wir uns schon immer für SillyTavern gewünscht haben, und zugleich auf dessen hervorragender Backend-Arbeit aufbaut.
>
> Daher ist dieser Fork noch in Entwicklung und wird derzeit als Beta-Software eingestuft. [Bitte melde Probleme, die speziell SillyBunny betreffen, im Issue-Tracker dieses Projekts.](https://github.com/SillyBunnyTeam/SillyBunny/issues) Wenn sich ein Problem auch im ursprünglichen SillyTavern reproduzieren lässt, melde es bitte stattdessen dort.
>
> Offener Hinweis: Wir setzen LLMs intensiv ein, um die Entwicklung dieses Forks zu ermöglichen, ohne die dieses Projekt nicht realisierbar wäre. Das übergreifende Programm- und Softwaredesign, das Prompting, die Tests und die Dokumentation werden jedoch vollständig von Menschen übernommen. Für die Upstream-Kompatibilität und den Projektumfang gelten bei uns strenge Maßstäbe.

<details>
<summary><h2>Vorschau</h2></summary>

Diese Screenshots zeigen die grafische Shell-Oberfläche mit Workspace, Customize, Agents, Characters, der Suche, dem Conversation-Modus und einer Chat-Ansicht mit Bunny Guide auf Desktop- und Mobilgeräten.

#### Desktop

| Workspace-Menü auf dem Desktop | Customize-Menü auf dem Desktop |
| :---: | :---: |
| <img src="screenshots/sillybunny-ui-desktop-navigate-v1.7.0.png" alt="Workspace-Menü auf dem Desktop" width="100%"> | <img src="screenshots/sillybunny-ui-desktop-customize-v1.7.0.png" alt="Customize-Menü auf dem Desktop" width="100%"> |

| Agents-Menü auf dem Desktop | Characters-Menü auf dem Desktop |
| :---: | :---: |
| <img src="screenshots/sillybunny-ui-desktop-agents-v1.7.0.png" alt="Agents-Menü auf dem Desktop" width="100%"> | <img src="screenshots/sillybunny-ui-desktop-characters-v1.7.0.png" alt="Characters-Menü auf dem Desktop" width="100%"> |

| Suche auf dem Desktop | Chat auf dem Desktop |
| :---: | :---: |
| <img src="screenshots/sillybunny-ui-desktop-search-v1.7.0.png" alt="Suche auf dem Desktop" width="100%"> | <img src="screenshots/sillybunny-ui-desktop-in-chat-v1.7.0.png" alt="Chat mit Bunny Guide auf dem Desktop" width="100%"> |

| Conversation-Modus auf dem Desktop |
| :---: |
| <img src="screenshots/sillybunny-ui-desktop-conversation-v1.7.0.png" alt="Conversation-Modus auf dem Desktop" width="100%"> |

#### Mobilgeräte

| Workspace-Menü auf Mobilgeräten | Customize-Menü auf Mobilgeräten | Agents-Menü auf Mobilgeräten |
| :---: | :---: | :---: |
| <img src="screenshots/sillybunny-ui-mobile-navigate-v1.7.0.png" alt="Workspace-Menü auf Mobilgeräten" width="100%"> | <img src="screenshots/sillybunny-ui-mobile-customize-v1.7.0.png" alt="Customize-Menü auf Mobilgeräten" width="100%"> | <img src="screenshots/sillybunny-ui-mobile-agents-v1.7.0.png" alt="Agents-Menü auf Mobilgeräten" width="100%"> |

| Characters-Menü auf Mobilgeräten | Suche auf Mobilgeräten | Chat auf Mobilgeräten |
| :---: | :---: | :---: |
| <img src="screenshots/sillybunny-ui-mobile-characters-v1.7.0.png" alt="Characters-Menü auf Mobilgeräten" width="100%"> | <img src="screenshots/sillybunny-ui-mobile-search-v1.7.0.png" alt="Suche auf Mobilgeräten" width="100%"> | <img src="screenshots/sillybunny-ui-mobile-in-chat-v1.7.0.png" alt="Chat mit Bunny Guide auf Mobilgeräten" width="100%"> |

| Conversation-Modus auf Mobilgeräten |
| :---: |
| <img src="screenshots/sillybunny-ui-mobile-conversation-v1.7.0.png" alt="Conversation-Modus auf Mobilgeräten" width="100%"> |

</details>

---

## Installation

[Hier kannst du die neueste Version herunterladen.](https://github.com/SillyBunnyTeam/SillyBunny/releases/latest)

Alternativ kannst du Folgendes ausführen:

```bash
git clone https://github.com/SillyBunnyTeam/SillyBunny.git
cd SillyBunny
```

Starte anschließend das passende Startskript für dein Betriebssystem. Es installiert automatisch alle Abhängigkeiten, sucht nach Aktualisierungen und startet eine Serverinstanz. Du kannst `http://127.0.0.1:4444` auch manuell in deinem Browser öffnen. Die Standard-Startskripte wählen automatisch die empfohlene Laufzeitumgebung aus. Verwende ein laufzeitspezifisches Startskript, wenn du Node.js oder Bun erzwingen möchtest.

| Plattform | Standard / automatisch | Node.js erzwingen | Bun erzwingen |
|----------|----------------|---------------|-----------|
| Windows | `.\Start.bat` | `.\Start-Node.bat` | `.\Start-Bun.bat` |
| macOS (Terminal) | `./Start.command` | `./Start-Node.command` | `./Start-Bun.command` |
| macOS (Finder) | Doppelklick auf `Start.command` | Doppelklick auf `Start-Node.command` | Doppelklick auf `Start-Bun.command` |
| Linux / WSL | `./start.sh` | `./start-node.sh` | `./start-bun.sh` |
| Android (Termux) | `bash start.sh` | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |
| Docker | `docker compose --project-directory . -f docker/docker-compose.yml up --build` | Nicht verfügbar | Nicht verfügbar |

Wenn du deine Bun-Installation selbst verwaltest, starte SillyBunny mit `bun run start`. Weitere Startvarianten:

```bash
bun run start:mobile   # geringerer Speicherbedarf (--smol)
bun run start:global   # von SillyBunny verwaltete Datenpfade
bun run start:no-csrf  # CSRF deaktivieren (lokale Entwicklung)
```

Wenn du SillyBunny über ein Skript statt mit `bun run` startest, beispielsweise über pm2, systemd, Docker oder Termux, setze `SILLYBUNNY_BUN_SMOL=1`, um denselben speichersparenden Modus wie bei `start:mobile` zu verwenden:

```bash
SILLYBUNNY_BUN_SMOL=1 ./start.sh
```

Lege die Variable bei Docker unter `environment:` in `docker/docker-compose.yml` fest.

`--smol` ist ein Bun-Flag und hat daher im Node.js-Modus keine Wirkung.

Termux, macOS und ARM-Hosts verwenden aufgrund von Kompatibilitätsproblemen mit Bun standardmäßig Node.js. Verwende `./start-bun.sh` (unter Termux: `bash start-termux-bun.sh`), um Bun zusammen mit `--smol` zu nutzen. Das Startskript gibt eine Warnung aus, wenn das Flag gesetzt ist, während Node.js ausgewählt wurde.

### Staging-Branch

Der `staging`-Branch wird häufiger aktualisiert als der `main`-Branch und enthält Arbeiten, die möglicherweise noch nicht produktionsreif sind. Er kann weniger stabil sein und inkompatible Änderungen enthalten. Die Nutzung erfolgt daher auf eigene Gefahr.

Führe in einem bestehenden Git-Checkout Folgendes aus:

```bash
git fetch origin staging
git switch --track origin/staging
```

Wenn du bereits einen lokalen `staging`-Branch hast, führe stattdessen `git switch staging` aus. Das Startskript kann den Staging-Branch automatisch aktualisieren, sobald ein Upstream dafür konfiguriert wurde. Dafür ist weiterhin ein sauberer Arbeitsbaum erforderlich.

### Hinweise zu macOS

- Wenn sich das Fenster des Startskripts zu schnell schließt, führe `./Start.command` im Terminal aus, damit die Ausgabe sichtbar bleibt
- Start über Finder: Doppelklicke auf eine `Start*.command`-Datei (Rechtsklick > Öffnen, falls Gatekeeper eine Warnung anzeigt)
- Wenn Git fehlt, startet das Startskript automatisch `xcode-select --install`
- Quarantäne-Metadaten aus ZIP-Downloads entfernen: `xattr -dr com.apple.quarantine /path/to/SillyBunny`
- Nach dem Entpacken entfernte Ausführungsrechte wiederherstellen: `chmod +x Start*.command start*.sh scripts/*.sh`

### Hinweise zu Termux (Android)

```bash
pkg update && pkg upgrade -y
pkg install -y git curl unzip
git clone https://github.com/SillyBunnyTeam/SillyBunny.git
cd SillyBunny
bash start-termux-node.sh
```

- `bash start.sh` verwendet unter nativem Termux und auf ARM-Geräten standardmäßig Node.js und npm, sofern Node.js verfügbar ist
- Node.js ausdrücklich erzwingen: `bash start-termux-node.sh`
- Bun ausdrücklich erzwingen: `bash start-termux-bun.sh` (installiert beim ersten Start automatisch glibc und richtet `bun-termux` ein)
- Bewahre das Repository im Home-Verzeichnis von Termux auf, beispielsweise unter `~/SillyBunny`, und nicht unter `~/storage/shared` oder `/storage/emulated/0`. Der gemeinsam genutzte Android-Speicher blockiert die von Bun und npm benötigten Verknüpfungen in `node_modules`
- Führe `termux-setup-storage` nur einmal aus, um SillyBunny Zugriff auf freigegebene Dateien zu gewähren. Klone das Repository nicht in den gemeinsam genutzten Speicher

Bun wird unter Termux über glibc ausgeführt, die das Startskript über `glibc-repo` und `glibc-runner` installiert. Wenn `start-termux-bun.sh` meldet, dass diese Pakete nicht verfügbar sind, führe `pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner` aus, um den zugrunde liegenden Fehler anzuzeigen. Setze `GLIBC_ROOT`, wenn sich deine glibc-Installation nicht unter `$PREFIX/glibc` befindet. Node.js benötigt nichts davon, sodass `bash start-termux-node.sh` immer als Ausweichlösung funktioniert.

### Aktualisierung

Git-Checkouts können über ein Startskript oder direkt über SillyBunny aktualisiert werden. ZIP- und Release-Ordner verwenden keine automatischen Aktualisierungen durch das Startskript, können aber über den integrierten Release-ZIP-Updater unter Customize > Server aktualisiert werden.

| Gewünschte Aktion | Befehl |
|---------------|---------|
| Aus der laufenden Anwendung aktualisieren (Git- oder ZIP-Installation) | Customize > Server öffnen und den integrierten Updater verwenden |
| Normal starten (sucht automatisch nach Aktualisierungen) | `./start.sh` |
| Aktualisierung erzwingen und anschließend starten | `./start.sh --self-update` |
| Nur aktualisieren, nicht starten | `./start.sh --self-update-only` |
| Aktualisierungsprüfung einmalig überspringen | `./start.sh --skip-self-update` |
| Automatische Aktualisierungen dauerhaft deaktivieren | `SILLYBUNNY_AUTO_UPDATE=0 ./start.sh` |

---

## Projektziele (oder: Warum wir diesen Fork erstellt haben)

Bei der Entwicklung von SillyBunny verfolgen wir einige grundlegende Ziele:

1. **Standardmäßig einfach, bei Bedarf leistungsfähig.** SillyBunny soll standardmäßig leicht verständlich und intuitiv bedienbar sein. Die meisten komplexen Einstellungen sind im normalen Workspace ausgeblendet. Wir setzen sinnvolle Voreinstellungen auf Grundlage ausgewählter Human Interface Guidelines (HIG) ein, damit du dich auf das Haupt-Chatfenster konzentrieren kannst. Zusätzliche Komplexität und Konfigurationsmöglichkeiten bleiben in der Standardansicht verborgen. Unsere grafische Shell verkörpert diese Philosophie, indem sie sich im Hintergrund hält, bis du etwas benötigst.
2. **Fokus auf Roleplay und Storytelling.** SillyBunny verfolgt einen klarer definierten Zweck als das ursprüngliche SillyTavern. Unsere Ziele orientieren sich eng an der kreativen Arbeit mit Modellen, und die allgemeine Ausrichtung des Forks ist auf diesen Anwendungsfall zugeschnitten. Dafür bieten wir vorinstallierte Tutorials, Presets, Erweiterungen und Charakterkarten, die dir einen unterhaltsamen Einstieg in das kreative Schreiben mit LLMs ermöglichen.
3. **Modernisierte Funktionen.** Wir möchten kontinuierlich neue und interessante Funktionen umsetzen, die moderne Modelle und ihre ausgeprägten Agentenfähigkeiten nutzen. Dazu gehört die vollständige Unterstützung für Pre-, Sidecar- und Post-Agenten im Chat, die die Hauptgenerierung mit kleineren Aufgaben ergänzen. Außerdem bieten wir zusätzliche Chat-Modi für die Interaktion mit deiner Charakterkarte. Hinzu kommen Fehlerbehebungen für Prompts und die Unterstützung neuer Modelle.
4. **Bessere Leistung.** SillyBunny nutzt Bun als Laufzeitumgebung. Bun bietet im Allgemeinen eine bessere Leistung und kürzere Startzeiten und ist für moderne Geräte stärker optimiert und energieeffizienter als Node.js. Node.js wird aus Gründen der Ausfallsicherheit und Kompatibilität weiterhin unterstützt.
5. **Upstream-Kompatibilität.** Wir bemühen uns um größtmögliche Abwärtskompatibilität mit dem ursprünglichen SillyTavern und bauen auf dessen solider Backend-Arbeit auf. Dadurch werden Wechsel und Migrationen vom Upstream erleichtert. Darüber hinaus sollen alle unsere neuen Funktionen mit Modellen jeder Größe kompatibel sein, nicht nur mit führenden Modellen auf dem neuesten Stand der Technik.

## Funktionen und Neuerungen

### Grafische Shell

Die Benutzeroberfläche verfügt über eine eigene, leicht zu navigierende grafische Shell für Desktop- und Mobilgeräte:

- **Obere Leiste**: Eine dauerhafte obere Leiste, über die die Programmfunktionen jederzeit schnell erreichbar sind. Sie ist in die Menüoptionen Workspace, Customize, Home und Characters sowie Schnellzugriffe unterteilt.
    - **Workspace**: Ermöglicht schnellen Zugriff auf alle Einstellungen, die du zur Konfiguration deines Modells benötigst, an einem zentralen Ort.
    - **Customize**: Dient zur Anpassung der Benutzeroberfläche und des SillyBunny-Backends.
    - **Agents**: Ein anpassbarer Schnellzugriff auf Agenten.
    - **Globale Suche**: Eine anpassbare, schnell zugängliche globale Suchleiste, die gleichzeitig Presets, Lore, Erweiterungen, Personas und Einstellungen durchsucht.
    - **Home**: Eine Startseite, über die verschiedene Bereiche, die SillyBunny-Dokumentation und empfohlene Erweiterungen schnell erreichbar sind.
    - **Characters**: Dient zur Interaktion mit Charakterkarten sowie zum Importieren, Erstellen und Bearbeiten dieser Karten.

- **Untere Leiste**: Eine dauerhafte untere Leiste, die als allgemeines Eingabefeld dient und schnellen Zugriff auf Chat-Steuerelemente bietet, darunter Persona- und Chat-Wechsel, Suche, Guided Generations und vieles mehr!

- **Mehrstufige Navigation**: Alle Einstellungen sind über die obere Leiste leicht erreichbar und auf verschiedene Unterregisterkarten verteilt. Die übersichtliche Gliederung in Ebenen reduziert Klicks und Berührungen und verkürzt die Suche in Menüs.
- **Plattformgerecht**: Für Desktop- und Mobilgeräte gestaltet, mit einer eigenen Navigationsebene für Smartphones und Tablets.
- **Anpassbarkeit**: Die Shell und das Eingabefeld lassen sich mit CSS, durch den Austausch von Farbpaletten und auf weitere Arten einfach verändern. Themes und Erweiterungen werden vollständig unterstützt.

### Mitgelieferte Extras und Tutorials

SillyBunny enthält standardmäßig einige Extras, damit du sofort mit dem kreativen Schreiben beginnen kannst:

- Ein ausführliches Tutorial zu SillyBunny und eine allgemeine Einführung in das Roleplay mit LLMs.
- Eine Anleitung zur Benutzeroberfläche.
- Integrierte Unterstützung für die Erweiterungen Guided Generations, Input History, Quick Image Gen, Prompt Inspector und Pathfinder.
- Ein zusätzliches, kuratiertes Repository mit häufig verwendeten Erweiterungen, die sich bequem in der Anwendung installieren lassen. Beispiele sind Dialogue Colors, Summary Sharder und erweiterte Makros.
- Zwei Chat-Completion-Presets für Roleplay und das Schreiben von Geschichten von purachina und Geechan, mehrere Text-Completion-Presets von Geechan, ein Chatroom-Preset von Geechan und ein Preset zur Kartenkonvertierung von TheLonelyDevil.
- Zwei Assistentenkarten, die dir bei weiteren Fragen helfen können: Bunny Guide und Assistant Nahida.
- Und mehr!

### Leistungsverbesserungen

SillyBunny startet auf den meisten unterstützten Clients mit Bun statt Node.js. Dies kann Startzeiten, allgemeine Leistung und Akkulaufzeit deutlich verbessern. Für Clients, die Bun nicht ordnungsgemäß unterstützen, bieten wir weiterhin Node.js an; die allgemeinen Verbesserungen gelten auch dort.

### Agenten im Chat

SillyBunny unterstützt vollständig einen agentenbasierten Workflow, der auf die ausgeprägten Agentenfähigkeiten moderner Modelle ausgelegt ist. Dieses System ist direkt in deine Charakterkarte eingebunden und lässt sich vollständig an deine Anforderungen und Vorlieben anpassen. Agenten kannst du dir als zusätzliche Aufgaben vorstellen, die an andere Modelle ausgelagert werden und parallel zur Hauptgenerierung laufen. Dadurch können sie die endgültige Ausgabe auf verschiedene Weise ergänzen oder verändern.

Standardmäßig liefern wir zahlreiche Agentenvorlagen für verschiedene Zwecke mit. Dazu gehören Tracker, Auswahlmarkierungen, Zufallsgeneratoren, Inhaltsbearbeiter und Stiloptimierer. Das System ist außerdem für selbst erstellte Agenten ausgelegt, wozu wir ausdrücklich ermutigen!

Agenten können an verschiedenen Stellen in den Generierungsprozess eingebunden werden:

**Pipeline:**

1. **Agenten vor der Generierung:** Diese erzeugen Inhalte, bevor das Hauptmodell den Prompt liest. Sie eignen sich dazu, bestimmte Regeln, Bedingungen oder Tracker festzulegen, ohne dein Haupt-Preset oder deinen System-Prompt ändern zu müssen.
2. **Hauptgenerierung:** Das Modell erzeugt die Hauptantwort und nutzt dabei den Inhalt seines System-Prompts als Referenz.
3. **Sidecar-Agenten:** Diese werden nach der Hauptgenerierung als Ergänzung angefügt und ermöglichen zusätzliche Kommentare oder Randbemerkungen, die von der Hauptgenerierung unabhängig sind.
4. **Agenten nach der Generierung:** Diese bearbeiten die Hauptausgabe, nachdem sie vollständig generiert wurde. So kannst du generierte Inhalte in einem zweiten Durchlauf bearbeiten, was besonders zur Fehlerkorrektur, stilistischen Überarbeitung oder Neuausrichtung der Ausgabe nützlich ist.

### Chat-Modi

**Roleplay**

Das Standarderlebnis, bei dem du direkt mit Charakterkarten und deinem Modell interagierst. Wenn du bereits ein anderes LLM-Frontend verwendet hast, sollte sich dieser Modus vertraut und zugänglich anfühlen. Über die untere Leiste erreichst du bequem Steuerelemente, mit denen du den zuletzt ausgewählten Chat bearbeiten oder darin navigieren kannst.

**Conversation**

Der Conversation-Modus verändert die Benutzeroberfläche und bildet beim Gespräch mit deinen Charakteren einen Internet-Messenger nach. Dazu gehören ein passender System-Prompt und eine entsprechende Benutzeroberfläche mit zeitgesteuerter Planung, Statusangaben, Follow-up-Nachrichten, Speicherverwaltung, Unterstützung für Bildgenerierung und mehr! Im Vergleich zum standardmäßigen Roleplay-Modus ist dies als lockereres Erlebnis gedacht.

---

## Upstream-Informationen

SillyBunny ist ein Fork von SillyTavern. Der überwiegende Teil des Verhaltens, der Datenformate und des Ökosystemwissens von SillyTavern gilt weiterhin. Die Upstream-Kompatibilität wird so weit wie möglich aufrechterhalten. Bitte melde Probleme, die speziell SillyBunny betreffen, hier und Probleme mit Bezug zu SillyTavern im Upstream-Projekt.

| Ressource | Link |
|----------|------|
| Upstream-Repository | [SillyTavern/SillyTavern](https://github.com/SillyTavern/SillyTavern) |
| Upstream-Dokumentation | [docs.sillytavern.app](https://docs.sillytavern.app/) |
| Upstream-Discord | [discord.gg/sillytavern](https://discord.gg/sillytavern) |
| Upstream-Subreddit | [r/SillyTavernAI](https://reddit.com/r/SillyTavernAI) |

Wenn dir etwas ungewöhnlich vorkommt, vergleiche es zuerst mit dem Upstream-Branch `release`.

## Mitwirkende

- [Platberlitz](https://github.com/platberlitz)
- [Geechan](https://github.com/Geechan)
- [TheLonelyDevil9](https://github.com/TheLonelyDevil9)

[Als freie Software unter der AGPL-3.0 lizenziert.](https://www.gnu.org/licenses/agpl-3.0.en.html)
