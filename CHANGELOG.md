# Changelog

Alle nutzersichtbaren Änderungen an Kladde.

## [Unveröffentlicht]

- Neu: Versionsverlauf für Notizen. Der Knopf „Verlauf“ (Uhr-Symbol) oben in der Notiz listet die gespeicherten Stände (verschlüsselt auf dem Server, bis zu 100 pro Notiz; Änderungen kurz hintereinander zählen als eine Version). Ein Klick zeigt die Änderungen gegenüber der vorigen Version wie bei `git diff` (grün hinzugefügt, rot entfernt, mit Zeilennummern) oder umschaltbar den gerenderten Text. „Wiederherstellen“ setzt die Notiz auf den gewählten Stand zurück. Der Verlauf beginnt mit dem Update; gelöschte Notizen verlieren ihren Verlauf.
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
- Geändert: Es gibt keine eingebauten Vorlagen mehr, und Notizen im Ordner „Vorlagen“ gelten nicht mehr als Vorlagen. Die Notizen selbst bleiben erhalten; ihren Inhalt kannst du in eine neue Vorlage übernehmen.

## [0.6.0] – 2026-11-08

- Neu: Slash-Befehle im Editor: `/` am Zeilenanfang oder nach einem Leerzeichen öffnet ein Menü mit Überschriften, Liste, nummerierter Liste, Aufgabe, Tabelle, Zitat, Codeblock, Trennlinie, Abfragen, Galerie, Links, dem heutigen Datum und Datei-Upload. Weitertippen filtert (auch englische Namen wie `/table` oder `/todo`).

## [0.5.0] – 2026-11-08

- Neu: Verwaltung für Admins (Seitenleiste bzw. Einstellungen → „Verwaltung“): alle Konten mit Passkeys, Notizen und letzter Aktivität; Passwort zurücksetzen (neues Zufallspasswort, das Konto wird überall abgemeldet), Gerätecode für einen neuen Passkey erzeugen, Admin-Rolle vergeben oder nehmen, Konten sperren und entsperren. Dazu Einladungen erstellen, Links kopieren und löschen sowie das Protokoll der Anmeldungen und Admin-Aktionen. Das älteste Konto ist automatisch Admin.
- Neu: Anmeldung mit Benutzername und Passwort als Alternative zum Passkey, z. B. wenn Kladde im lokalen Netz ohne HTTPS läuft (dort gehen Passkeys nicht). Ohne HTTPS zeigt die Anmeldung direkt das Passwort-Formular; Einladungen lassen sich auch mit Passwort annehmen. Das Passwort legst du in den Einstellungen fest, änderst oder entfernst es dort.
- Neu: Telegram-Befehle `/passwort BENUTZER` (neues Zufallspasswort) und `/admin BENUTZER [an|aus]`.
- Geändert: In einem Ordner stehen die Unterordner jetzt als Liste (mit Anzahl der Notizen) statt als Pills.
- Behoben: Auf dem iPad (Home-Bildschirm-App) ist der obere Rand nicht mehr verschwommen, wie zuvor schon auf dem iPhone.
- Behoben: Lange Titel oder Links in „Zuletzt bearbeitet“ machen die Startseite auf dem Handy nicht mehr breiter als den Bildschirm.
- Behoben: Fehler wie „Der letzte Passkey kann nicht gelöscht werden“ erscheinen wieder als Meldung statt als „Serverfehler“.

## [0.4.3] – 2026-11-08

- Behoben: Die Kopfzeile in der iOS-Home-Bildschirm-App (iOS 26/27) ist jetzt wirklich scharf. Die Unschärfe kam von iOS selbst, das sie nur über einer undurchsichtigen, fixierten Kopfzeile weglässt.

## [0.4.2] – 2026-11-08

- Behoben: In der iOS-Home-Bildschirm-App ist die Kopfzeile (Menü, „Kladde“, Symbole) nicht mehr verschwommen.

## [0.4.1] – 2026-11-08

- Diagnose: misst die Abstände oben und unten jetzt getrennt, zeigt die Lage von Kopfzeile und unterer Leiste und hat einen Test-Knopf „volle Höhe“.

## [0.4.0] – 2026-11-08

- Einstellungen: neuer Bereich „Diagnose“ zeigt Messwerte zur Bildschirmdarstellung (z. B. für Probleme in der iOS-Home-Bildschirm-App) und kopiert sie.
- Behoben: Der Rezept-Import funktioniert jetzt auch auf Servern in reinen IPv6-Netzen mit NAT64 (z. B. „Diese Adresse ist nicht erlaubt (picnic.app → 64:ff9b::…)“). Geprüft wird die darin enthaltene IPv4-Adresse; interne Adressen bleiben gesperrt.

## [0.3.3] – 2026-11-08

- Behoben: In der iOS-Home-Bildschirm-App (iOS 26) liegt die Kopfzeile nicht mehr unter dem dunklen Verlauf der Statusleiste, und die untere Leiste reicht wieder bis zum Bildschirmrand. Die App bekommt jetzt von iOS die volle Bildschirmhöhe, auch bei älteren Installationen.
- Updates kommen jetzt sofort an: Beim Start, beim Zurückkehren in die App und wenn die Verbindung wiederkommt, fragt die App die Server-Version ab und lädt eine neue Version zwangsweise (notfalls mit geleertem App-Cache). Notizen bleiben dabei erhalten.

## [0.3.2] – 2026-11-08

- Behoben: In älteren iOS-Home-Bildschirm-Installationen (ab iOS 26.1) bleibt unter der unteren Leiste kein andersfarbiger Streifen mehr; die Leiste reicht optisch bis zum Rand.
- Rezept-Import: Wird eine Adresse gesperrt, nennt die Meldung jetzt die aufgelöste IP-Adresse.

## [0.3.1] – 2026-11-08

- Rezept-Import: erkennt jetzt auch Rezepte, die die Seite erst beim Laden im Browser einbaut (z. B. Picnic und andere Next.js-Seiten); Mengen wie „0.5“ werden als „0,5“ geschrieben.
- Behoben: In der iOS-Home-Bildschirm-App (ab iOS 26.1) liegt die Kopfzeile nicht mehr halb unter der Statusleiste, und unter der unteren Leiste bleibt kein leerer Streifen mehr. Die Statusleiste ist jetzt undurchsichtig. **Wichtig:** Die App einmal vom Home-Bildschirm löschen und über Safari neu hinzufügen, sonst behält iOS die alte Einstellung.

## [0.3.0] – 2026-11-08

- Neu: Rezepte per Link importieren (Seitenleiste „Rezept importieren“ oder „Rezept“ im Schnell-Erfassen). Kladde liest das Rezept von gängigen Seiten (schema.org-Rezeptdaten, z. B. Chefkoch, EatSmarter, BBC Good Food, viele Food-Blogs) und legt es einheitlich in „3 Ressourcen/Rezepte“ ab: Zutaten als Tabelle (Menge, Einheit, Zutat), Zubereitung als nummerierte Schritte, Originallink als Quelle ganz unten.
- Behoben: In der iOS-Home-Bildschirm-App rutschen Kopfzeile und untere Leiste nicht mehr nach oben (z. B. nach dem Schließen der Tastatur); die Kopfzeile liegt nicht mehr halb unter der Statusleiste.

## [0.1.0] – 2026-11-08

- Erster Proof of Concept: Anmeldung per Einladung und Passkey, Markdown-Notizen mit Live-Vorschau, Tabellen mit Sortieren/Filtern, Abfrageblöcke, Aufgaben mit Fälligkeit und Wiederholung, Offline-Synchronisierung, Freigaben, Themes (Hell, Dunkel, OLED), installierbar als App.
- Neuer Name: Kladde.
- Notizen und Ordner per Drag & Drop in andere Ordner verschieben; Ordner ziehen ihre Unterordner und Notizen mit.
- PARA: Inbox als Arbeitsliste zum Einsortieren, Projektstatus mit „Abschließen“ und Archivieren/Wiederherstellen (auch ganze Ordner), aktive Projekte auf dem Startbildschirm.
- Zettelkasten: Zettel-Dialog mit Typ (flüchtig, Literatur, dauerhaft) und fester ID; Links über die ID bleiben beim Umbenennen gültig; Hinweis auf unverbundene Zettel.
- Beim Umbenennen einer Notiz werden alle Links darauf angepasst; unverlinkte Erwähnungen lassen sich mit einem Klick verlinken.
- Wissensnetz als Graph (gesamt und lokal unter jeder Notiz), Wochenrückblick und Vorlagen (auch eigene aus einem Ordner „Vorlagen“).
- Frontmatter wird als kompakte Eigenschaften-Leiste angezeigt; leere Checkboxen zählen nicht mehr als Aufgabe.
- Unterordner direkt im Ordnerbaum oder in der Ordneransicht anlegen; Ordner umbenennen (Stift oder Doppelklick) und leere Ordner löschen.
- Lesemodus: Ein Schloss-Schalter oben in der Seitenleiste (mobil in der Kopfzeile) sperrt auf diesem Gerät alle Seiten gegen Änderungen – Notizen, Titel, Aufgaben-Häkchen, Ordner sowie Anlegen, Verschieben und Löschen.
- Der Textcursor im Editor ist im dunklen Theme wieder sichtbar.
- Tastenkürzel im Editor: Strg/⌘+B fett, Strg/⌘+I kursiv, Strg/⌘+Shift+M Code (eine Zeile inline, mehrere Zeilen als Codeblock), Strg/⌘+Shift+X durchgestrichen, Strg/⌘+Shift+L Verknüpfung; erneutes Drücken nimmt die Formatierung zurück. Strg/⌘+K öffnet überall die Suche.
- iPhone: Kopf- und Fußleiste halten jetzt Abstand zu Notch/Dynamic Island und Home-Indikator; Dialoge und die Editor-Leiste behalten ihren Innenabstand.
- Auswahl-Chips (Projektstatus, Zettel-Typ, Ordner in der Inbox) zeigen den Pfeil im Chip statt daneben.
