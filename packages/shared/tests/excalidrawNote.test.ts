import { describe, expect, it } from 'vitest';
import { excalidrawNoteMarkdown, excalidrawSceneOf, isExcalidrawNote, mergeExcalidrawElements, setExcalidrawScene } from '../src/index.js';

describe('Excalidraw notes', () => {
  it('builds an empty drawing note and reads it back', () => {
    const md = excalidrawNoteMarkdown();
    expect(md).toBe('---\ntype: excalidraw\n---\n```excalidraw\n\n```\n');
    expect(isExcalidrawNote(md)).toBe(true);
    expect(excalidrawSceneOf(md)).toBe('');
  });

  it('round-trips a scene', () => {
    const json = '{\n  "type": "excalidraw",\n  "elements": []\n}';
    const md = excalidrawNoteMarkdown(json);
    expect(excalidrawSceneOf(md)).toBe(json);
  });

  it('returns null without the type marker', () => {
    expect(excalidrawSceneOf('```excalidraw\n{}\n```\n')).toBeNull();
    expect(isExcalidrawNote('---\ntype: pdf\n---\n')).toBe(false);
  });

  it('accepts the marker case-insensitively and a missing block', () => {
    expect(excalidrawSceneOf('---\nType: Excalidraw\n---\nNur Text\n')).toBe('');
  });

  it('replaces only the drawing block and keeps the text around it', () => {
    const md = '---\ntype: excalidraw\ntags: [a]\n---\nVorher\n\n```excalidraw\n{"a":1}\n```\n\nNachher\n';
    const next = setExcalidrawScene(md, '{"a":2}');
    expect(next).toBe('---\ntype: excalidraw\ntags: [a]\n---\nVorher\n\n```excalidraw\n{"a":2}\n```\n\nNachher\n');
    expect(excalidrawSceneOf(next)).toBe('{"a":2}');
  });

  it('appends a block when there is none', () => {
    const next = setExcalidrawScene('---\ntype: excalidraw\n---\nText\n', '{}');
    expect(excalidrawSceneOf(next)).toBe('{}');
    expect(next).toContain('Text\n\n```excalidraw\n{}\n```\n');
  });

  it('uses a longer fence when the scene contains backticks', () => {
    const json = '{"text":"```code```"}';
    const md = excalidrawNoteMarkdown(json);
    expect(md).toContain('````excalidraw\n');
    expect(excalidrawSceneOf(md)).toBe(json);
    expect(excalidrawSceneOf(setExcalidrawScene(md, '{"text":"x"}'))).toBe('{"text":"x"}');
  });

  it('keeps "$" sequences in the scene literally', () => {
    const json = '{"text":"$& $1 $$"}';
    expect(excalidrawSceneOf(setExcalidrawScene(excalidrawNoteMarkdown(), json))).toBe(json);
  });
});

describe('mergeExcalidrawElements', () => {
  const el = (id: string, version: number) => ({ id, version });

  it('takes the higher version per element, ties go to remote', () => {
    const local = [el('a', 3), el('b', 1)];
    const remote = [{ ...el('a', 2) }, { ...el('b', 1), versionNonce: 9 }];
    expect(mergeExcalidrawElements(local, remote, false)).toEqual([el('a', 3), { id: 'b', version: 1, versionNonce: 9 }]);
  });

  it('keeps local-only elements only while local edits are unsaved', () => {
    const local = [el('a', 1), el('new', 1)];
    const remote = [el('a', 1)];
    expect(mergeExcalidrawElements(local, remote, true).map((e) => e.id)).toEqual(['a', 'new']);
    expect(mergeExcalidrawElements(local, remote, false).map((e) => e.id)).toEqual(['a']);
  });

  it('adds remote-only elements', () => {
    expect(mergeExcalidrawElements([], [el('r', 1)], false)).toEqual([el('r', 1)]);
  });
});
