/**
 * A new remote note (GitLab/GitHub), or the source of an existing one: the address with `{{var:…}}` (completed like in
 * the editor), an optional branch, and what the address comes out as.
 */
import { useId, useRef, useState } from 'react';
import { INBOX_FOLDER, parseRemoteUrl, remoteNoteMarkdown, remoteNoteOf, resolveRemoteSource, resolveVariables, setRemoteSource, splitPath, type SharedFolder, type VariableScope } from '@kladde/shared';
import { spaceOf, useVault, vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { useVariables } from '../data/variables';
import { remoteProblemText, useRemoteHosts } from '../data/remoteNotes';
import { folderDisplayName, t, useLang } from '../lib/i18n';
import { Loader2, RemoteDoc } from '../lib/icons';
import { isReadOnly } from '../lib/readOnly';
import { navigate } from '../lib/router';
import { isCoarsePointer } from '../lib/viewport';
import { Dropdown } from './Dropdown';
import { Sheet } from './Dialogs';

const SUGGESTIONS = 6;

/** A text field in which `{{` offers the variables of the folder */
function VariableInput({ value, onChange, scope, label, placeholder, autoFocus, onEnter, mono }: { value: string; onChange: (value: string) => void; scope: VariableScope; label: string; placeholder: string; autoFocus?: boolean; onEnter: () => void; mono?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  /** Where the placeholder being typed starts, and what stands behind `{{var:` */
  const [typing, setTyping] = useState<{ from: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const options = typing
    ? scope
        .list()
        .filter((e) => e.name.toLowerCase().includes(typing.query.toLowerCase()))
        .slice(0, SUGGESTIONS)
    : [];
  const open = options.length > 0;

  const look = (el: HTMLInputElement) => {
    const before = el.value.slice(0, el.selectionStart ?? 0);
    const m = /\{\{(?:v(?:a(?:r(?::([\p{L}\p{N}\p{M}_.-]*))?)?)?)?$/u.exec(before);
    setTyping(m ? { from: m.index, query: m[1] ?? '' } : null);
    setActive(0);
  };
  const pick = (name: string) => {
    const el = input.current;
    if (!el || !typing) return;
    const end = el.selectionStart ?? value.length;
    const rest = value.slice(end).replace(/^\}\}/, '');
    const text = `${value.slice(0, typing.from)}{{var:${name}}}`;
    onChange(text + rest);
    setTyping(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  };

  return (
    <div className="relative">
      <span aria-hidden className="mb-1 block text-label-l text-text">
        {label}
      </span>
      <input
        ref={input}
        className={`input ${mono ? 'font-mono text-[13px]' : ''}`}
        value={value}
        aria-label={label}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          look(e.target);
        }}
        onClick={(e) => look(e.currentTarget)}
        onBlur={() => setTyping(null)}
        onKeyDown={(e) => {
          if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
          } else if (open && (e.key === 'Enter' || e.key === 'Tab')) {
            e.preventDefault();
            e.stopPropagation();
            pick(options[active].name);
          } else if (open && e.key === 'Escape') {
            e.stopPropagation();
            setTyping(null);
          } else if (e.key === 'Enter') onEnter();
        }}
      />
      <ul id={listId} role="listbox" aria-label={t('remote.variables')} hidden={!open} className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-md border border-line2 bg-raised shadow-elevation-1">
        {options.map((e, i) => (
          <li
            key={e.name}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            className={`flex cursor-pointer items-baseline gap-3 px-3 py-2 text-body-s ${i === active ? 'bg-line' : ''}`}
            onMouseDown={(ev) => {
              ev.preventDefault();
              pick(e.name);
            }}
          >
            <span className="shrink-0 font-mono">{e.name}</span>
            <span className="min-w-0 truncate text-muted">{resolveVariables(e.value, scope)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface RemoteNoteDialogProps {
  folder?: string;
  title?: string;
  shared?: SharedFolder;
  group?: string;
  /** Change the source of this note instead of making one */
  noteId?: string;
  /** Called with the new note's title instead of opening it */
  onCreated?: (title: string) => void;
  onClose: () => void;
}

export function RemoteNoteDialog({ folder, title: givenTitle = '', shared, group, noteId, onCreated, onClose }: RemoteNoteDialogProps) {
  useVault();
  const lang = useLang();
  const note = noteId ? vault.get(noteId) : undefined;
  const existing = note && remoteNoteOf(note.content);
  const [title, setTitle] = useState(givenTitle);
  const [source, setSource] = useState(existing?.source ?? '');
  const [ref, setRef] = useState(existing?.ref ?? '');
  const [target, setTarget] = useState(shared?.folder ?? folder ?? (group ? '' : INBOX_FOLDER));
  const [busy, setBusy] = useState(false);
  const hosts = useRemoteHosts();
  const space = note ? spaceOf(note) : group ? `group:${group}` : shared ? `user:${shared.owner}` : 'own';
  const scope = useVariables({ space, folder: note ? splitPath(note.path).folder : target });
  const inGroup = group ? vault.group(group) : undefined;
  const folders = group ? vault.groupFolders(group) : vault.folders();

  const typed = { source: source.trim(), ref: ref.trim() };
  const resolved = resolveRemoteSource(typed, scope);
  const parsed = typed.source && resolved.complete ? parseRemoteUrl(resolved.url, hosts ?? [], resolved.ref) : null;
  // Without the list of hosts (offline) only the server can tell
  const problem = !typed.source ? null : !resolved.complete ? 'unknown_variable' : parsed && !parsed.ok && (hosts || parsed.problem !== 'host_not_configured') ? parsed.problem : null;
  const usable = /^https?:\/\//i.test(typed.source) || typed.source.startsWith('{{var:');

  /** The file's name, or the project's for a README */
  const ownTitle = (): string => {
    const last = parsed?.ok ? parsed.target.candidates[0].path.split('/').pop()! : '';
    const name = parsed?.ok && parsed.target.type === 'file' ? last.replace(/\.\w+$/, '') : '';
    const project = parsed?.ok ? parsed.target.project.split('/').pop()! : '';
    const found = name && !/^readme$/i.test(name) ? name : project;
    return found || t('remote.defaultTitle');
  };

  const save = async () => {
    if (busy || !usable || isReadOnly()) return;
    setBusy(true);
    try {
      if (note) {
        // With what the note is now: it may have been changed elsewhere while the dialog was open
        const current = vault.get(note.id);
        if (current) await vault.update(note.id, { content: setRemoteSource(current.content, typed) });
        onClose();
        return;
      }
      const name = title.trim() || ownTitle();
      const content = remoteNoteMarkdown(typed);
      const created: LocalNote = group ? await vault.createInGroup(group, target, name, content) : shared ? await vault.createShared(shared, name, content) : await vault.create(target, name, content);
      onClose();
      if (onCreated) onCreated(splitPath(created.path).name);
      else navigate(`/n/${created.id}`);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={note ? t('remote.editTitle') : t('remote.newTitle')} onClose={onClose}>
      <div data-remote-dialog className="space-y-3">
        {!note && <p className="text-body-m text-muted">{t('remote.intro')}</p>}
        <div>
          <VariableInput value={source} onChange={setSource} scope={scope} label={t('remote.url')} placeholder={t('remote.urlPlaceholder')} autoFocus={!isCoarsePointer()} onEnter={() => void save()} mono />
          <div className="mt-1.5 min-h-[1.25rem] text-body-s text-muted" aria-live="polite">
            {typed.source && resolved.complete && resolved.url !== typed.source && (
              <p className="break-all" data-remote-preview>
                = {resolved.url}
              </p>
            )}
            {problem ? (
              <p className="text-red" data-remote-problem={problem}>
                {remoteProblemText(problem)}
              </p>
            ) : parsed?.ok ? (
              <p className="break-words" data-remote-target>
                {parsed.target.host.kind === 'gitlab' ? 'GitLab' : 'GitHub'} · {parsed.target.project} · {parsed.target.type === 'readme' ? 'README' : parsed.target.candidates[0].path}
                {parsed.target.candidates.length > 1 && parsed.target.type === 'file' ? ` – ${t('remote.refHint')}` : ''}
              </p>
            ) : (
              !typed.source && hosts && <p>{hosts.length ? t('remote.hosts', { hosts: hosts.map((h) => h.url.replace(/^https?:\/\//, '')).join(', ') }) : t('remote.noHosts')}</p>
            )}
          </div>
        </div>
        <VariableInput value={ref} onChange={setRef} scope={scope} label={t('remote.refLabel')} placeholder="main" onEnter={() => void save()} mono />
        {!note && (
          <>
            <input
              className="input"
              aria-label={t('dialogs.newNoteTitlePlaceholder')}
              placeholder={`${t('dialogs.newNoteTitlePlaceholder')} (${ownTitle()})`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void save()}
            />
            <div className="flex flex-col gap-1.5 text-sm text-muted sm:flex-row sm:items-center sm:gap-2">
              <span className="shrink-0">{t('dialogs.newNoteFolder')}</span>
              {shared ? (
                <span className="chip min-w-0 flex-1" title={shared.folder}>
                  <span className="truncate">
                    {shared.folder} · {shared.owner}
                  </span>
                </span>
              ) : (
                <Dropdown
                  value={target}
                  onChange={setTarget}
                  aria-label={t('dialogs.newNoteFolder')}
                  className="flex-1"
                  options={[...new Set([target, ...folders, ''])].map((f) => ({ value: f, label: inGroup ? `${inGroup.name}${f ? ` / ${f}` : ''}` : folderDisplayName(f, lang) }))}
                />
              )}
            </div>
          </>
        )}
        <button type="button" className="btn-primary w-full py-2.5" disabled={busy || !usable} onClick={() => void save()}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <RemoteDoc size={16} />} {note ? t('common.save') : t('dialogs.newNoteCreate')}
        </button>
        <p className="text-xs text-muted">{t('remote.variablesHint')}</p>
      </div>
    </Sheet>
  );
}
