# Import mit der CLI (Obsidian, Markdown, Bilder, PDF)

Mit der Import-CLI bringst du einen lokalen Ordner – zum Beispiel einen Obsidian-Vault – in deinen Kladde-Space, ohne Zugriff auf den Server zu brauchen. Die CLI läuft auf deinem Rechner und spricht über eine eigene, eng begrenzte Import-API mit deiner Kladde. Sie zeigt vor dem Import eine Vorschau und fragt nach.

## 1. Import-Token erstellen

1. In Kladde **Einstellungen → Import** öffnen.
2. Einen Namen eingeben (z. B. „Laptop“) und **Token erstellen** wählen.
3. Das Token (beginnt mit `kli_`) sofort kopieren – es wird **nur dieses eine Mal** angezeigt. Kladde speichert nur einen Hash davon.

Ein Import-Token darf nur drei Dinge: die Pfade deiner eigenen Notizen auflisten, Anhänge hochladen und neue Notizen anlegen. Es kann keine Notizen lesen, ändern oder löschen und funktioniert an keiner anderen Stelle der API (auch nicht für MCP).

## 2. Projekt bauen

Die CLI ist Teil des Kladde-Repositorys und braucht Node.js 22 oder neuer:

```bash
git clone <Kladde-Repository>
cd kladde
npm ci
npm run build
```

## 3. CLI aufrufen

```bash
export KLADDE_IMPORT_TOKEN=kli_…
npm run import -- <ordner> [<zielordner>] --url <Kladde-URL> [--dry-run] [--yes]
```

- `<ordner>`: der lokale Ordner, der rekursiv gelesen wird.
- `<zielordner>`: der Ordner im Space, unter dem die Notizen landen (Standard: oberste Ebene). `.kladde` ist reserviert.
- `--url`: die Adresse deiner Kladde, z. B. `https://kladde.example.org` (http oder https).
- `--dry-run`: zeigt nur die Vorschau und schreibt nichts.
- `--yes`: importiert ohne Rückfrage (nötig, wenn die CLI nicht in einem Terminal läuft, z. B. in einem Skript).
- `--help`: zeigt die Hilfe.

Ist `KLADDE_IMPORT_TOKEN` nicht gesetzt, fragt die CLI im Terminal verdeckt nach dem Token. Das Token wird nie auf die Festplatte geschrieben und nie ausgegeben.

Beispiel:

```bash
KLADDE_IMPORT_TOKEN=kli_… npm run import -- ~/Obsidian/Vault Import --url https://kladde.example.org --dry-run
```

Die Vorschau ist wie `git status` aufgebaut: Gruppen für neue Notizen, neue Anhänge, übersprungene Notizen (Pfad vorhanden) und ignorierte Dateien, darunter die Zahlen. Ohne `--dry-run` folgt die Frage `Importieren? [j/N]`; nur `j`, `ja`, `y` oder `yes` startet den Import. Am Ende fasst die CLI zusammen, wie viele Notizen angelegt und übersprungen, wie viele Anhänge hochgeladen und wie viele Dateien ignoriert wurden, und listet Fehler einzeln auf. Gab es Fehler, endet sie mit Exit-Code 1.

## Was importiert wird

- **Notizen**: Dateien mit `.md`, `.markdown` oder `.txt`. Unterordner bleiben erhalten; jede Notiz wird als `.md` gespeichert, z. B. `Vault/Reisen/Rom.markdown` → `<zielordner>/Reisen/Rom.md`. Das Änderungsdatum der Datei wird zum Datum der Notiz.
- **Anhänge**: Bilder (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.avif`) und PDFs – aber **nur, wenn eine neu angelegte Notiz sie verlinkt**, per Markdown-Link oder -Bild (`![alt](bilder/foto.png)`) oder Obsidian-Einbettung (`![[foto.png]]`, `![[foto.png|Beschreibung]]`). Die Links in der Notiz zeigen danach auf den hochgeladenen Anhang. Ist der Pfad nicht eindeutig, sucht die CLI eine eindeutige Datei mit demselben Namen im Ordner.
- **Ignoriert**: versteckte Dateien und Ordner (z. B. `.obsidian`, `.git`), symbolische Links, `node_modules`, alle anderen Dateitypen (z. B. `.docx`) und Bilder oder PDFs, die keine neue Notiz verlinkt.
- **Grenzen**: Notizen über 2 MB und Anhänge über 25 MB werden als Fehler gemeldet und nicht gesendet.

## Vorhandene Pfade werden nie überschrieben

Gibt es im Space schon eine Notiz mit demselben Pfad (Groß-/Kleinschreibung egal), wird die Datei übersprungen. Der Server prüft das beim Schreiben noch einmal: Eine Notiz, die zwischen Vorschau und Import entstanden ist, wird ebenfalls übersprungen. Die CLI ändert, verschiebt oder löscht nie eine bestehende Notiz. Ein zweiter Lauf über denselben Ordner meldet daher alles als übersprungen und lädt keine Anhänge erneut hoch.

Die importierten Notizen synchronisieren wie jede andere Änderung und erscheinen in geöffneten Kladde-Fenstern ohne Neuladen.

## Token widerrufen

Unter **Einstellungen → Import** steht jedes Token mit Erstell- und letztem Nutzungsdatum. Über das Papierkorb-Symbol (mit Rückfrage) widerrufst du es; die CLI bekommt danach `Import-Token ungültig oder widerrufen`. Ein gesperrtes Konto kann seine Tokens ebenfalls nicht mehr benutzen.

## Fehlermeldungen

| Meldung | Bedeutung |
| --- | --- |
| `Import-Token ungültig oder widerrufen` | Token falsch abgeschrieben, widerrufen oder Konto gesperrt |
| `Kladde unter … nicht erreichbar` | Adresse falsch, Server aus oder unter der Adresse antwortet keine Kladde |
| `Bitte die Adresse … mit --url angeben` / `Ungültige --url …` | `--url` fehlt oder ist keine http-/https-Adresse |
| `Ordner nicht gefunden` / `Kein Ordner` | Der Quellpfad existiert nicht oder ist eine Datei |
