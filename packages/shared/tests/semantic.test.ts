import { describe, expect, it } from 'vitest';
import { normalizeText, semanticSearch, stemToken } from '../src/semantic';

const note = (id: string, path: string, content: string, updatedAt = 1_000) => ({
  id,
  path,
  content,
  updatedAt,
  createdAt: updatedAt,
});

describe('semanticSearch', () => {
  const sampleNotes = [
    note(
      'n1',
      '1 Projekte/Wohnungssuche Berlin.md',
      '---\nstatus: aktiv\n---\n# Wohnungssuche\n\nBesichtigungstermine und Mietvertrag prüfen.\nSiehe auch [[Umzugskosten]]. #wohnung',
      5000
    ),
    note(
      'n2',
      '1 Projekte/Umzugskosten.md',
      '# Kostenplanung\n\nTransporter mieten, Kaution hinterlegen und Kartons bestellen.',
      4000
    ),
    note(
      'n3',
      '3 Ressourcen/Sommerurlaub Italien.md',
      '# Sommerurlaub\n\nFlug nach Rom, Unterkunft am Strand und Mietwagen buchen. #reise',
      3000
    ),
    note(
      'n4',
      '2 Bereiche/Kochbuch/Pasta Carbonara.md',
      '# Pasta Carbonara\n\nZutaten: Eier, Pecorino, Guanciale, schwarzer Pfeffer. #rezept',
      2000
    ),
    note(
      'n5',
      '3 Ressourcen/Server Deployment.md',
      '# Deployment\n\nDocker Image bauen, Backup anlegen und Linux Dienst neu starten.',
      1000
    ),
  ];

  it('normalizes umlauts and stems German and English words', () => {
    expect(normalizeText('Ärger mit Öfen und Bäumen in der Straße')).toBe('aerger mit oefen und baeumen in der strasse');
    expect(stemToken('Wohnungen')).toBe(stemToken('Wohnung'));
    expect(stemToken('Besichtigungen')).toBe(stemToken('Besichtigung'));
    expect(stemToken('running')).toBe(stemToken('runs'));
  });

  it('ranks direct title and inflection matches highest', () => {
    const hits = semanticSearch('Wohnung besichtigen', sampleNotes);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].note.id).toBe('n1');
    expect(hits[0].reasons).toContain('Titel');
    expect(hits[0].score).toBeGreaterThan(0.3);
  });

  it('matches German compounds in both query and document directions', () => {
    // Compound query -> component words in notes ("Mietvertrag" -> Miete/Vertrag, "Reisekosten" -> Reise + Kosten)
    const compoundQuery = semanticSearch('Urlaubsreise Italien', sampleNotes);
    expect(compoundQuery[0].note.id).toBe('n3');

    // Simple word query -> compound in note title/body ("Kartons" / "Kosten" / "Wohnung")
    const subwordHits = semanticSearch('Wohnung', sampleNotes);
    expect(subwordHits[0].note.id).toBe('n1');

    const compoundInQuery = semanticSearch('Umzugskosten', sampleNotes);
    expect(compoundInQuery[0].note.id).toBe('n2');
  });

  it('finds conceptually related notes via bilingual concept clusters', () => {
    const hits = semanticSearch('vacation hotel flight', sampleNotes);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].note.id).toBe('n3');
    expect(hits[0].reasons).toContain('Themenverwandt');
  });

  it('propagates relevance to directly linked neighbor notes', () => {
    const hits = semanticSearch('Mietvertrag Besichtigung', sampleNotes);
    const ids = hits.map((h) => h.note.id);
    expect(ids).toContain('n1');
    // n2 is linked from n1 via [[Umzugskosten]] and gets a graph boost
    const n2Hit = hits.find((h) => h.note.id === 'n2');
    expect(n2Hit).toBeDefined();
    expect(n2Hit!.reasons).toContain('Verknüpfte Notizen');
    expect(n2Hit!.backlinks).toContain('Wohnungssuche Berlin');
  });

  it('respects folder filter, limit and minScore', () => {
    const folderHits = semanticSearch('Wohnung Kosten Rezept', sampleNotes, { folder: '2 Bereiche' });
    expect(folderHits.every((h) => h.note.path.startsWith('2 Bereiche/'))).toBe(true);

    const limited = semanticSearch('Planung Wohnung Kosten', sampleNotes, { limit: 1 });
    expect(limited.length).toBeLessThanOrEqual(1);

    const strict = semanticSearch('komplettunbekannteswortxyz', sampleNotes, { minScore: 0.4 });
    expect(strict).toEqual([]);
  });

  it('selects the most relevant passage as snippet', () => {
    const longNote = note(
      'long',
      '0 Inbox/Notiz.md',
      [
        'Einleitung ohne Besonderheiten über den allgemeinen Tagesablauf.',
        ...Array.from({ length: 12 }, (_, i) => `Absatz ${i + 1}: Fülltext über alltägliche Dinge und Wetter.`),
        'Wichtig: Das Docker Backup sollte vor jedem Update automatisiert laufen.',
        'Ende der Notiz.',
      ].join('\n\n')
    );
    const hits = semanticSearch('Docker Backup automatisiert', [longNote]);
    expect(hits[0].snippet).toContain('Docker Backup');
  });
});
