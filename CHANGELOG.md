# Changelog

Alle nutzersichtbaren Änderungen an Kladde.

## [Unveröffentlicht]

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
