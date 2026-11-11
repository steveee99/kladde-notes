# Changelog

Alle nutzersichtbaren Änderungen an Kladde.

## [Unveröffentlicht]

## [0.31.1] – 2026-11-11

- Behoben: Die untere Navigationsleiste auf dem Handy endet nicht mehr mit einem großen Leerraum über dem Bildschirmrand; die Beschriftungen rücken wie bei der iOS-Tab-Leiste in den Bereich des Home-Indikators.

## [0.31.0] – 2026-11-11

- Neu: Ein Ordner lässt sich in der Ordneransicht mit „Löschen“ samt allen Notizen und Unterordnern entfernen (nach Rückfrage mit der Zahl der Notizen). Eingang, PARA-Ordner, Zettelkasten und Daily Notes sind davon ausgenommen.
- Geändert: Wird eine URL als Link eingefügt, entfernt Kladde `[`, `]` und `\` aus der Linkbeschreibung, statt sie mit `\` zu maskieren.
- Geändert: Die Aufgaben auf der Startseite lassen Notizen im Archiv aus. Die Kanban-Spalte „Fertig“ zeigt nur noch Aufgaben, die heute oder gestern erledigt wurden.
- Behoben: Die Checkboxen von Aufgaben stehen im Editor wieder auf einer Höhe – je nach Status (offen, in Arbeit, blockiert, fertig) saßen sie unterschiedlich hoch.
- Behoben: Auf der Startseite stehen Aufgaben ohne Notiz mittig in ihrer Zeile bzw. Karte, ohne Leerraum darunter.

## [0.30.0] – 2026-11-11

- Neu: Aufgaben haben einen Status: `[ ]` offen, `[O]` in Arbeit, `[H]` blockiert, `[x]` fertig. Im Editor zeigt die Checkbox den Status (halb gefüllt, Pause-Zeichen bzw. grün mit Haken); ein Klick erledigt die Aufgabe, Rechtsklick wählt einen beliebigen Status. `TASKS`-Abfragen und das MCP kennen das Feld `status` (`open`, `doing`, `blocked`, `done`).
- Neu: Die Aufgaben auf der Startseite lassen sich zwischen Liste und Kanban umschalten (pro Gerät gemerkt). Das Board hat je eine Spalte pro Status; eine Karte in eine andere Spalte ziehen ändert den Status der Aufgabe in ihrer Notiz. Auf dem Handy wählt der Knopf auf der Karte den Status. „Fertig“ zeigt die Aufgaben der letzten 7 Tage.
- Neu: Ligaturen im Editor – `->` erscheint als →, `<-` als ←, `=>` als ⇒, `<=`/`>=` als ≤/≥, `!=` als ≠, `<->`/`<=>` als ↔/⇔ und `...` als …. Nur die Anzeige ändert sich, der Text bleibt; in Code und in der Zeile mit dem Cursor bleiben die Zeichen sichtbar. Abschaltbar unter Einstellungen → „Ligaturen“.

## [0.29.0] – 2026-11-11

- Geändert: Das ⋮-Menü der Notiz bündelt jetzt „Markdown kopieren“, „Favorit“ und „Markdown-Ansicht“ (vorher eigene Knöpfe im Notizkopf) sowie bei Projekten „Projekt abschließen“ und „Zu einem Projektordner wandeln“ (vorher in der Projektleiste).
- Neu: Eigenschaften (Frontmatter) direkt bearbeiten – Werte in der Eigenschaftenzeile anklicken und ändern (Enter übernimmt, Escape verwirft), mit „+ Eigenschaft“ neue anlegen, mit × entfernen; für `status` und `typ` gibt es Vorschläge. Notizen ohne Frontmatter bekommen über ⋮ → „Eigenschaft hinzufügen“ eine. Ein Klick in die freie Fläche zeigt weiterhin das YAML.
- Neu: In einer Daily Note listet „Offene Aufgaben aus früheren Daily Notes“ alles, was an den Vortagen liegen geblieben ist; „In heutige Notiz übernehmen“ (oder „Alle übernehmen“) verschiebt die Aufgabe samt Unteraufgaben in die offene Daily Note. Die Liste zeigt nur den Namen der Aufgabe (ohne `- [ ]`) und bricht auf dem Handy um, statt abzuschneiden.
- Neu: Aufgaben in einer Daily Note ohne eigenes Datum gelten als fällig am Tag der Daily Note (Startseite, `TASKS`-Abfragen und MCP). Übernommene Aufgaben wandern damit automatisch auf den neuen Tag; ein ausdrückliches `📅` bleibt erhalten.
- Behoben: Auf dem Handy ließ sich bei offener Tastatur nicht mehr nach oben zur Leiste der Notiz scrollen. Die App passt sich jetzt an den sichtbaren Bereich über der Tastatur an.

## [0.28.0] – 2026-11-11

- Neu: Suche in der Seitenleiste per Tastatur – Pfeiltasten ↑/↓ wandern durch die Treffer, Enter öffnet den markierten.
- Neu: Favoriten (Opt-In unter Einstellungen → Funktionen): Der Stern im Notizkopf (oder `Strg/⌘+D`) fügt die offene Notiz hinzu bzw. entfernt sie. Sobald es Favoriten gibt, stehen sie als eigene Liste in der Seitenleiste und werden zwischen Geräten synchronisiert.
- Geändert: Aufgeräumte Seitenleiste – die Navigation (Start, Tagesnotiz, Notizen, Inbox, Wissensnetz, Anhänge, Rückblick …) ist eine kompakte Icon-Reihe mit Tooltips und Zählern; „Favoriten“ und „Ordner“ lassen sich einklappen (pro Gerät gemerkt), die Favoriten zeigen höchstens fünf Einträge ohne Scrollen, und auf niedrigen Bildschirmen starten sie eingeklappt. So bleibt den Ordnern deutlich mehr Platz.
- Neu: Tabellen in der Vorschau bearbeiten – Zelle anklicken und tippen (Tab/Shift+Tab/Enter springen weiter, Escape bricht ab), Spalten über das Menü ⋮ im Kopf einfügen, umbenennen und entfernen, Zeilen hinzufügen und entfernen. In der Markdown-Ansicht bleibt die Tabelle reiner Text.
- Neu: Anmelden mit GitLab (GitLab.com oder eigene Instanz) über `GITLAB_CLIENT_ID`/`GITLAB_CLIENT_SECRET`, optional beschränkt auf Gruppen (`GITLAB_ALLOWED_GROUPS`). Bestehende Konten verknüpfen GitLab in den Einstellungen; neue Konten entstehen über einen Einladungslink oder mit `GITLAB_ALLOW_SIGNUP=1`. Anleitung in der README.
- Geändert: Der Wochenrückblick ist jetzt ein Opt-In (Einstellungen → Funktionen); ohne ihn verschwinden „Rückblick“ in der Navigation und die Erinnerung auf der Startseite.
- Entfernt: Der Telegram-Admin-Bot (`TELEGRAM_*`-Variablen). Einladungen, Konten und Protokoll verwaltest du in der App unter Einstellungen → Verwaltung.

## [0.27.0] – 2026-11-11

- Neu: Im gemeinsamen Editor siehst du, wo die anderen gerade schreiben: ein farbiger Cursor mit kleinem Profilbild (beim Daraufzeigen mit Namen), markierter Text erscheint in derselben Farbe. Jede Person hat überall dieselbe Farbe; auch die eigenen anderen Geräte/Tabs werden angezeigt.

## [0.26.0] – 2026-11-11

- Neu: Gemeinsames Bearbeiten in Echtzeit – für geteilte Notizen und für mehrere Geräte/Tabs desselben Kontos. Änderungen der anderen erscheinen sofort im offenen Editor und werden mit dem gerade Getippten zusammengeführt; Cursor, Markierung und Rückgängig-Verlauf bleiben erhalten. Sobald eine Notiz an mehr als einer Stelle offen ist, zeigt der Notizkopf „Live“ mit den Profilbildern aller, die sie gerade offen haben (mit Anzahl der Geräte).
- Neu: Konflikte werden zusammengeführt statt kopiert. Ändern zwei Geräte oder Personen eine Notiz gleichzeitig – auch wenn ein Gerät länger offline war und erst später synchronisiert –, werden beide Änderungen per Drei-Wege-Merge übernommen (zeilenweise, im selben Absatz wortweise). Nur wenn beide dieselben Wörter ändern, bleibt wie bisher eine „(Konflikt …)“-Kopie.

## [0.25.0] – 2026-11-10

- Neu: Farbiges Syntax-Highlighting in der Markdown-Code-Ansicht (Überschriften, Formatierungen, Links/Bilder, Codeblöcke inkl. `query`/`mermaid`/`mindmap`/`gallery`/`carousel`, YAML-Frontmatter, `[[Wikilinks]]`, `#Tags`, Fußnoten, `##TOC##` und Aufgaben-Metadaten).

## [0.24.0] – 2026-11-10

- Neu: Code-Ansicht – ein Knopf im Notizkopf schaltet den Editor auf reines Markdown (ohne Live-Vorschau, Monospace-Schrift); die Wahl wird pro Gerät gemerkt.
- Behoben: Bilder springen beim Bearbeiten nicht mehr zwischen Bild und Markdown hin und her; sie bleiben sichtbar, und ihr Markdown erscheint nur, wenn der Cursor direkt am Bild steht (dann oberhalb des Bildes).
- Behoben: Hochkant-Bilder im Karussell werden hochkant dargestellt statt beschnitten.

## [0.23.1] – 2026-11-10

- Behoben: `/carousel` fehlte im Slash-Menü.

## [0.23.0] – 2026-11-10

- Neu: Externe Links (`[Text](https://…)`, `<https://…>` und nackte URLs) erscheinen im Editor als Material-3-Chip mit dem Favicon der Seite (Globus als Ersatz, offline oder ohne Icon) und dem Linktext bzw. einer gekürzten URL.
- Neu: Slash-Befehl `/carousel` mit Block ` ```carousel ` (gleiche Syntax wie die Galerie, ein Bild pro Zeile) als Material-3-Karussell: horizontal wischbar mit Einrasten, großes Bild mit angeschnittenem nächsten, Beschriftung aus dem Alt-Text, Vor/Zurück-Knöpfe am Desktop, Klick öffnet die Vollbildansicht.
- Neu: „+ Neue Notiz“ in der Seitenleiste ist ein Split-Button; das Menü daneben enthält „Zettel“ und „Rezept aus URL“ (statt eigener Knöpfe), sofern die Funktionen aktiviert sind.
- Geändert: Die Galerie (` ```gallery `) zeigt Bilder in zwei Spalten (bei schmalen Notizen in einer).
- Geändert: „Verwaltung“ ist aus der Seitenleiste entfernt; sie bleibt über die Einstellungen erreichbar.
- Behoben: Icons in den Einstellungen (u. a. „Funktionen & Struktur“) sind vertikal mit Titel und Beschreibung zentriert.
- Neu: Eine eingefügte URL wird zu `[Titel](url)`, wenn die Zwischenablage einen Linktext mitliefert (z. B. „Link kopieren“ auf Webseiten oder Adressleiste in Edge/Safari); mit markiertem Text wird die Markierung zum Linktext.
- Behoben: Der Slash-Befehl `/link` (Web-Link) fügte nichts ein, weil der leere Linktext der Vorlage `[](https://)` die Live-Vorschau abstürzen ließ.

## [0.22.0] – 2026-11-10

- Neu: Alle nativen `<select>`-Auswahlfelder durch Material-3-konforme Dropdown-Menüs (schwebendes Listen-Menü per Portal) ersetzt.
- Neu: Button im Menübaum (Kopfzeile „Ordner“ sowie Suchergebnis-Kopf der Seitenleiste) zum Fokussieren, automatischen Aufklappen übergeordneter Ordner und Hervorheben der aktuell geöffneten Notiz.
- Neu: Tastenkürzel `Strg+Shift+D` / `⌘+Shift+D` öffnet von überall (auch direkt aus dem Editor) die heutige Tagesnotiz; Datumsleiste `<-- | Datepicker | -->` oberhalb von Tagesnotizen mit Material-3-Kalender-Popover und eigener Tagesansicht (`/daily`, `/daily/:date`).
- Neu: Opt-in-Kalenderansicht im GitHub-Heat-Map-Stil auf der Startseite und unter `/calendar` (unter **Einstellungen → Funktionen & Struktur** aktivierbar); Klicks auf Tageskacheln öffnen oder erstellen Tagesnotizen nur bei aktivierten Daily Notes und sind sonst inaktiv.
- Behoben: Mobile Ansichten, Dialoge, Editor-Toolbar (ab `320 px` Breite), Splitview-Tabs, Eigenschaften-Chips und Navigationsleisten (inkl. angepinnter Seitenleisten-Kopfzeile und unterem Abstand über dem „Erfassen“-Button) gegen abgeschnittene Elemente überarbeitet sowie mobile Modals/Drawers/Sheets per Portal über die Kopfzeile gehoben.

## [0.21.0] – 2026-11-10

- Neu: **Tagesnotizen (Daily Notes)** mit einstellbarem Zielordner (auch oberste Ebene) und frei definierbarem Namensschema inklusive Datums-Platzhaltern und Live-Vorschau unter **Einstellungen → Funktionen & Struktur** (Standard: `0 Daily/YYYY/MM/YYYY-MM-DD.md`), sowie Direktzugriff über Startseite und Seitenleiste.
- Neu: **Projekte-Logik & Umwandlung in Projektordner**: Nicht mehr jede Notiz unter dem Projekte-Ordner zählt automatisch als Projektnotiz – nur direkte Projektdateien (`<Projekte>/<Name>.md`) oder eine `Home.md` direkt in einem Projektunterordner (`<Projekte>/<Ordner>/Home.md`). Über den neuen Knopf **„Zu einem Projektordner wandeln“** in einer einzelnen Projektnotiz wird diese inklusive Erhalt bestehender `[[Links]]` in einen eigenen Projektordner (`Home.md`) überführt.
- Neu: **Profilbilder (Avatare)** im Material-3-Design: Hochladen, Ändern und Entfernen unter Einstellungen, Anzeige beim Teilen von Notizen und Ordnern, auf öffentlichen Links sowie in der Seitenleiste bzw. mobil unten rechts (ein Klick öffnet direkt die Einstellungen).
- Behoben / Geändert: Auf Mobilgeräten zeigt die Breadcrumb-Leiste nun kompakt nur noch den letzten Ordner an (Tippen öffnet ein Menü mit allen anklickbaren Ordner-Ebenen); lange Notiztitel brechen mehrzeilig um statt abgeschnitten zu werden.

## [0.20.0] – 2026-11-10

- Neu: Notizen innerhalb von Ordnern sowie auf oberster Ebene werden nun direkt im Ordnerbaum der linken Seitenleiste angezeigt (inklusive Drag & Drop und automatischem Aufklappen); die zusätzliche mittlere Listen-Seitenleiste neben geöffneten Notizen entfällt.
- Neu: PARA-Methode (Projekte, Bereiche, Ressourcen, Archiv – „0 Inbox“ bleibt unabhängig davon aktiv), Zettelkasten und Rezeptimport sind nun optionale Opt-in-Funktionen unter **Einstellungen → Funktionen & Struktur** mit freier Zielordner-Wahl und Anlegen neuer Zielordner direkt in den Einstellungen (pro Konto verschlüsselt synchronisiert; bestehende Räume mit vorhandenen Standardordnern erhalten sie automatisch voraktiviert).
- Geändert: Die rechte Splitview-Seitenleiste in geöffneten Notizen ist nun optisch eigenständig als abgerundete Karte vom Hauptbereich getrennt – analog zum angehefteten linken Menü.

## [0.19.0] – 2026-11-10

- Neu: Eigenständiger Desktop-Modus ohne Benutzerverwaltung als einzelne ausführbare Datei via Node.js SEA und Microsoft Edge (`--app`-Fenster; lokal baubar über `npm run build:desktop` bzw. `npm run build:exe` für `dist/kladde.exe`). Notizen, Anhänge und Schlüssel werden lokal und AES-256-GCM-verschlüsselt außerhalb der Programmdatei gespeichert (`%LOCALAPPDATA%\Kladde\` bzw. optional portabel im Ordner `kladde-data` neben der `.exe`), inklusive automatischem Datenbank-Backup vor Schema-Migrationen – Updates erfolgen direkt durch Austausch der `.exe`.

## [0.18.0] – 2026-11-10

- Neu: Zweisprachigkeit (Deutsch und Englisch) in der gesamten Oberfläche inklusive Datumsformaten, Startnotizen, Widgets, Slash-Befehlen, Dialogen, Exporten und Anmeldung (umschaltbar unter Einstellungen → Erscheinungsbild sowie direkt auf der Anmeldeseite).
- Neu: Notizen erhalten eine vollständige Ordner-Breadcrumb-Navigation im Kopf, einen Schnell-Kopieren-Knopf für reines Markdown (ohne YAML-Frontmatter) sowie ein Material-3-Drei-Punkte-Menü (Teilen, Verlauf, Exportieren, Verschieben, Löschen).
- Neu: Einklappbare rechte Splitview-Seitenleiste in Notizen mit den Tabs „Inhalt“ (Inhaltsverzeichnis), „Verlinkungen“ (Backlinks & Erwähnungen) und „Graph“.
- Neu: Automatisches Inhaltsverzeichnis per `##TOC##` (oder `[[TOC]]`), über den Slash-Befehl `/toc` und die Werkzeugleiste sowie beim Word- und PDF-Export.
- Neu: Direkte Suchleiste in der Seitenleiste (und der Material-Listenleiste); der eigene Tab „Suche“ entfällt (`Strg+K` fokussiert weiterhin die Suche).
- Neu: Opt-in „Inbox Zero“ in den Einstellungen (Standardmäßig aus) – erst bei Aktivierung werden der Zähler an der Inbox und die Meldung „X Nachrichten zum einsortieren“ angezeigt.
- Neu: Tastenkürzel `Strg+S` (`Cmd+S`) speichert offene Änderungen und synchronisiert sofort mit Status-Meldung.
- Geändert: Kladde nutzt nun ausschließlich das Material-3-Designsystem (Themes „Hell“ und „System“ wurden entfernt); das Drei-Striche-Menü schaltet direkt zwischen schmaler Leiste und angehefteter Sticky-Leiste um (ohne Desktop-Overlay).
- Geändert: Widescreen nutzt nun Prozentwerte (`50 %`, `80 %` Standard, `100 %`, Benutzerspezifisch) und gilt nun auch für die Einstellungsseiten; auf Bildschirmen unter `800 px` wird automatisch die volle Breite verwendet.
- Geändert: Auf der Startseite sind Willkommensgruß, Untertitel und „+ Projekt“-Knopf größer und durch optische Trennlinien gegliedert; in der Inbox stehen pro Kachel rechts nur noch Ordnerauswahl und Löschen; Inline-Code hebt sich farblich deutlicher vom Hintergrund ab.
- Behoben: Das Kalender-/Fälligkeits-Popover bei Aufgaben wird über ein Portal gerendert, sodass es nicht mehr hinter nachfolgendem Text verschwindet und immer klickbar bleibt.

## [0.17.1] – 2026-11-10

- Behoben: Das Export-Menü in Notizen (und geteilten Ansichten) wird nun über ein Portal außerhalb der Notiz-Kopfzeile gerendert, sodass auf dem Desktop nachfolgende Ebenen (Metadaten-Leiste, Eigenschaften und Editor) das Menü nicht mehr verdecken und Klicks auf die Export-Optionen wieder zuverlässig ankommen.

## [0.17.0] – 2026-11-10

- Neu: Im Dunkel-Design (Material) lässt sich die Seitenleiste auf größeren Bildschirmen über Einstellungen → Erscheinungsbild oder direkt im Menü-Kopf zwischen „Overlay“ (schmale Leiste links + Schublade) und „Sticky“ (vollständiges Menü ersetzt die Leiste links dauerhaft) umschalten.
- Neu: Anhänge verwalten unter „Anhänge“ (Seitenleiste und Einstellungen): Galerie-Grid aller hochgeladenen Bilder und PDFs mit Filter „Nicht in Notizen verwendet“, Notiz-Verweisen, Multiselekt und Löschen mit Bestätigung. Anhänge, die noch in einer Notiz verwendet werden, sind geschützt und können nicht gelöscht werden.
- Neu (CLI): Erweiterte Server-CLI mit `import <quelle> <ziel>` (einzelne Datei oder rekursiver Ordner inkl. Bildern/PDFs und Obsidian-Links), `export <quelle> <ziel>` (ganzer Space, Ordner oder Einzelnotiz, optional `--strip-frontmatter` / `--with-files`) sowie Hilfsbefehlen (`suche`, `notizen`, `ordner`, `anhaenge`, `anhaenge-bereinigen`, `status`, `backup`, Kontenverwaltung).
- Neu: Notizen lassen sich direkt als Markdown (`.md`), Word-Dokument (`.docx`), PDF-Datei (`.pdf`) oder über die Druckansicht exportieren – jeweils ohne YAML-Frontmatter.
- Neu (MCP): Neues Werkzeug `semantic_search` für eine lokale semantische Suche über alle eigenen Notizen – berücksichtigt deutsche und englische Wortstämme, zusammengesetzte Begriffe, themenverwandte Begriffe sowie verknüpfte `[[Links]]`.

## [0.16.0] – 2026-11-09

- Neu: Automatische Erkennung von Notiznamen im Text: Wird der Titel einer existierenden Notiz im Fließtext erwähnt, wird er in der Live-Vorschau und im Lesemodus automatisch als klickbarer Hyperlink (dezent gepunktet unterstrichen) dargestellt. Ein Klick öffnet sofort die Zielnotiz. Über ein kleines Symbol beim Daraufzeigen (sowie über den neuen Slash-Befehl `/verlinken` für alle Erwähnungen) lässt sich der Treffer mit einem Klick dauerhaft in einen echten [[Wikilink]] umwandeln.

## [0.15.0] – 2026-11-09
- Neu: Widescreen-Einstellung unter Einstellungen → Erscheinungsbild: Wähle zwischen „Fluid (ganze Breite)“ und „Feste Breite“ (mit Schieberegler, Zahleneingabe und Schnellauswahl in Pixeln; Standard ist 1200 px). Notizen, Übersichten und Tabellen nutzen den zusätzlichen Platz auf breiten Bildschirmen optimal aus.

## [0.14.2] – 2026-11-09

- Behoben: Auf dem Desktop überdeckte das Ordner-Dropdown in der Inbox den Löschen-Knopf bei längeren Ordnernamen. Die Dropdown-Breite ist nun sauber begrenzt, sodass der Löschen-Knopf immer klickbar bleibt.
- Behoben: Dialoge und Eingabefenster (z. B. der Rezept-Import) passen sich auf Mobilgeräten nun dynamisch an das virtuelle Tastaturfenster an und verschwinden nicht mehr hinter der geöffneten Tastatur. Auf Touch-Geräten öffnet sich die Tastatur zudem nicht mehr automatisch beim Aufrufen des Dialogs.
- Geändert: Das Slash-Menü (`/`) im Editor bietet mehr Innenabstand und wurde im Material-Design mit abgerundeten Menüeinträgen, Tonal-Highlighting und weicherem Schatten gestaltet.

## [0.14.1] – 2026-11-09

- Behoben: Sicherheitsaktualisierungen für Abhängigkeiten (Mermaid, Vitest, Glob).

## [0.14.0] – 2026-11-09

- Geändert: Es gibt nur noch ein dunkles Design – „Material“ heißt jetzt „Dunkel“ und ersetzt die bisherigen Designs „Dunkel“ und „OLED“. Wer eines davon gewählt hatte, bekommt automatisch das neue; „System“ nutzt es im Dunkelmodus.
- Behoben: Breite Tabellen machten auf dem Handy die ganze Notiz breiter als den Bildschirm, sodass die Seite seitlich scrollte. Jetzt scrollt nur die Tabelle, und Zellen brechen nicht mehr mitten im Wort um.
- Neu: Das Design „Material“ hat jetzt einen eigenen Aufbau statt nur eigener Farben: Am Tablet und Desktop eine schmale Navigationsleiste links mit großem Knopf für neue Notizen; die Ordner und alles Weitere öffnen sich über das Menü-Symbol als Schublade. Neben einer geöffneten Notiz steht auf breiten Bildschirmen die Liste der Notizen aus ihrem Ordner (umschaltbar auf alle Notizen). Der Inhalt liegt auf einer abgerundeten Fläche. Am Handy gibt es unten eine Navigationsleiste mit Pillen-Markierung und einen „Erfassen“-Knopf. Knöpfe sind rund, Chips, Eingabefelder, Karten und Checkboxen haben Material-Formen, die Werkzeugleiste im Editor schwebt, und die Schrift ist Roboto Flex (offline verfügbar).

## [0.13.0] – 2026-11-09

- Neu: Design „Material“ unter Einstellungen → Erscheinungsbild. Angelehnt an Googles Material 3: fast schwarze, neutralgraue Flächen, die sich in Tonstufen statt mit Linien abheben, ein blauer Akzent, größere Rundungen und die Bewegungskurven von Material.

## [0.12.0] – 2026-11-09

- Neu: Git-Sync. Unter Einstellungen → Git-Sync hinterlegst du pro Konto eine Git-Adresse (https), E-Mail und Access-Token. Deine eigenen Notizen (keine geteilten) werden dann als Markdown-Dateien auf den Branch `main` übertragen – ein Commit pro Sync, rund zwei Minuten nach der letzten Änderung oder per „Jetzt synchronisieren“. Die Commit-Nachricht stellst du selbst ein; `{date}` wird zum aktuellen Datum, `{time}` zur Uhrzeit (Standard: „Kladde-Sync {date}“). Zugangsdaten liegen verschlüsselt in der Datenbank; die Dateien im Repository sind unverschlüsselt. Das Docker-Image enthält dafür jetzt `git`.
- Neu: Freie Aufgaben. Das Feld „Neue Aufgabe“ auf der Startseite legt Aufgaben ohne Notiz an (in einer versteckten Systemnotiz, verschlüsselt und synchronisiert); sie erscheinen zusammen mit den geplanten Aufgaben aus deinen Notizen.
- Neu: Jede Aufgabe auf der Startseite hat einen kleinen Kalender-Knopf für Fälligkeit und Wiederholung – mit Shortcuts für Heute, Morgen und Nächste Woche (Montag), Datumswahl und Wiederholung (täglich bis jährlich).

## [0.11.0] – 2026-11-09

- Neu: Versionsverlauf für Notizen. Der Knopf „Verlauf“ (Uhr-Symbol) oben in der Notiz listet die gespeicherten Stände (verschlüsselt auf dem Server, bis zu 100 pro Notiz; eine Schreibsitzung zählt als eine Version – erst nach 10 Minuten Pause oder nach einer Stunde beginnt eine neue). Ein Klick zeigt die Änderungen gegenüber der vorigen Version wie bei `git diff` (grün hinzugefügt, rot entfernt, mit Zeilennummern) oder umschaltbar den gerenderten Text. „Wiederherstellen“ setzt die Notiz auf den gewählten Stand zurück. Der Verlauf beginnt mit dem Update; gelöschte Notizen verlieren ihren Verlauf.
- Geändert: „Löschen“ im Eingang fragt jetzt wie in der Notiz vorher nach.

## [0.10.0] – 2026-11-08

- Neu: Notizlisten lassen sich zwischen Kacheln, Liste und Tabelle umschalten – in Ordnern, „Alle Notizen“, „Mit mir geteilt“, der Suche und „Zuletzt bearbeitet“ auf der Startseite. Die Wahl gilt überall und wird auf dem Gerät gemerkt.
- Neu: Abfragen als Kanban-Board: ```` ```query ```` mit `KANBAN BY status VALUES "offen", "läuft", "fertig"` zeigt pro Wert eine Spalte mit den passenden Notizen (ohne `VALUES` werden die vorhandenen Werte genutzt; `FROM`, `WHERE`, `SORT`, `LIMIT` funktionieren wie sonst). Karten lassen sich in eine andere Spalte ziehen und setzen dabei das Feld in der Notiz. Neuer Slash-Befehl `/kanban`.
- Neu: Aufgaben auf der Startseite gibt es in einer kompakten Ansicht (eine Zeile pro Aufgabe), umschaltbar per Knopf „Kompakt/Normal“.
- Neu: Ein Doppelklick auf eine Aufgabe (Startseite und Aufgaben-Abfragen) öffnet die Notiz, aus der sie stammt, und springt zur Zeile.
- Neu: Fußnoten. `[^1]` wird zur hochgestellten Nummer (Hover zeigt den Text, Klick springt zur Definition), Zeilen `[^1]: Text` erscheinen als nummerierte Fußnote.

## [0.9.0] – 2026-11-08

- Neu: Diagramme und Mindmaps in Notizen. Ein Codeblock ```` ```mermaid ```` wird als Mermaid-Diagramm gezeichnet (Flussdiagramm, Sequenz-, Kreis-, Gantt-, Klassendiagramm u. v. m.). Ein Codeblock ```` ```mindmap ```` macht aus einer einfachen Gliederung eine Mindmap: die erste Zeile ohne Listenzeichen ist die Mitte, eingerückte Listenpunkte (oder Überschriften) die Äste; Links und Formatierungen erscheinen als Text. Steht der Cursor im Block, siehst du den Quelltext, sonst das Bild – auch in der Lesansicht und auf öffentlichen Links. Ein Klick vergrößert das Diagramm, Fehler zeigt Kladde mit dem Quelltext an. Die Farben folgen dem gewählten Design, und alles funktioniert offline. Neue Slash-Befehle: `/mindmap`, `/diagramm`, `/sequenzdiagramm` und `/kreisdiagramm`.
- Neu: Ordner teilen. Über das Teilen-Symbol neben einem Ordner in der Seitenleiste gibst du ihn für andere Benutzer frei und stellst pro Person ein, was sie darf: Lesen ist immer erlaubt, dazu wahlweise Bearbeiten, neue Notizen Anlegen und Löschen. Die Freigabe gilt für alle Notizen darin, auch in Unterordnern und für Notizen, die später hinzukommen; verschiebst du eine Notiz heraus, ist sie nicht mehr geteilt. Benennst du den Ordner um oder verschiebst ihn, bleibt die Freigabe bestehen. Empfänger finden die geteilten Ordner unter „Mit mir geteilt“ und legen dort mit „Neue Notiz“ Notizen an, wenn sie dürfen. Diese Notizen gehören dir als Besitzer und liegen in deinem Bereich; ziehst du die Freigabe zurück, sehen die anderen nichts mehr davon.
- Behoben: Ein App-Update lässt nicht mehr den ganzen Bildschirm blinken. Das Update wartet, bis du nicht gerade tippst (oder die App im Hintergrund ist); danach erscheint die App sofort mit deinem Konto und ohne Einblend-Animationen.

## [0.8.0] – 2026-11-08

- Neu: KI-Assistenten wie Claude sprechen per MCP (Model Context Protocol) mit deinen Notizen. Die Adresse ist `https://<deine-kladde>/mcp`; beim Verbinden meldest du dich in Kladde an und bestätigst den Zugriff (OAuth), auf Wunsch nur lesend. Der Assistent sieht ausschließlich deine eigenen Notizen – keine Freigaben anderer und keine Einstellungen. Er kann Notizen auflisten, durchsuchen, lesen, Abfragen ausführen und Aufgaben auflisten; mit Schreibrecht auch Notizen anlegen, ersetzen, ergänzen und Aufgaben abhaken (nicht löschen oder umbenennen). Verbindungen verwaltest und trennst du unter Einstellungen → KI-Assistenten; dort erstellst du auch Zugriffstokens für Programme ohne Anmeldefenster. Ein Passwort-Reset durch Admins trennt alle Verbindungen des Kontos.

## [0.7.0] – 2026-11-08

- Neu: Vorlagen haben einen eigenen Bereich unter Einstellungen → Vorlagen. Dort legst du eigene Vorlagen (z. B. für Projekte oder Besprechungen) mit Name, Zielordner und Inhalt an, bearbeitest und löschst sie. Platzhalter: `{{title}}`, `{{date}}` und `{{zid}}` (Zettel-ID, kommt auch vor den Titel). Die Vorlagen werden verschlüsselt mit den Einstellungen synchronisiert.
