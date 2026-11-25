import { EditorView, WidgetType } from '@codemirror/view';
import { safeUrl, type GitlabCard, type GitlabCardKind, type GitlabPerson } from '@kladde/shared';
import { locale, tl, type I18nKey, type Lang } from '../lib/i18n';
import { EDITOR_ICON_PATHS } from './calloutIcons';
import { editorHost, type GitlabCardState } from './host';
import { editButton } from './widgets';

/*
 * GitLab preview cards (shared/gitlabCard.ts): a GitLab address alone on its line shows as a card. Everything in it
 * comes from GitLab and only ever becomes text nodes; the card links to the address as written in the note.
 */


const SVG_NS = 'http://www.w3.org/2000/svg';

function icon(name: keyof typeof EDITOR_ICON_PATHS, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 -960 960 960');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', EDITOR_ICON_PATHS[name]);
  svg.append(path);
  return svg;
}

const KIND_ICON: Record<GitlabCardKind, keyof typeof EDITOR_ICON_PATHS> = {
  merge_request: 'glMergeRequest',
  issue: 'glIssue',
  pipeline: 'glPipeline',
  commit: 'glCommit',
  milestone: 'glMilestone',
  release: 'glRelease',
  project: 'glProject',
  group: 'glGroup',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** "3 days ago" in the reader's language */
export function relativeTime(ms: number, lang: Lang, now = Date.now()): string {
  const diff = (ms - now) / 1000;
  const fmt = new Intl.RelativeTimeFormat(locale(lang), { numeric: 'auto' });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, secs] of steps) if (Math.abs(diff) >= secs) return fmt.format(Math.round(diff / secs), unit);
  return fmt.format(0, 'minute');
}

const duration = (s: number): string => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`);
const personText = (p: GitlabPerson) => (p.username ? `@${p.username}` : p.name);

/** The words of a GitLab state in the reader's language (unknown ones as GitLab writes them) */
function stateLabel(card: GitlabCard, lang: Lang): string | null {
  if (card.draft && card.state === 'opened') return tl(lang, 'gitlab.state.draft');
  if (!card.state) return null;
  const key = `gitlab.state.${card.state.toLowerCase()}` as I18nKey;
  const label = tl(lang, key);
  return label === key ? card.state : label;
}

function chip(cls: string, text: string, iconName?: keyof typeof EDITOR_ICON_PATHS, title?: string): HTMLElement {
  const c = el('span', `gl-chip ${cls}`);
  if (iconName) c.append(icon(iconName, 13));
  c.append(document.createTextNode(text));
  if (title) c.title = title;
  return c;
}

/** The card's content (also used by tests and the public view): head, title, description and facts */
export function gitlabCardBody(card: GitlabCard, lang: Lang): HTMLElement {
  const body = el('div', 'gl-card-body');

  const head = el('div', 'gl-card-head');
  const kind = el('span', 'gl-kind');
  kind.append(icon(KIND_ICON[card.kind], 15), document.createTextNode(tl(lang, `gitlab.kind.${card.kind}` as I18nKey)));
  head.append(kind, el('span', 'gl-ref', card.reference));
  const state = stateLabel(card, lang);
  if (state) {
    const pill = el('span', `gl-state gl-tone-${card.tone ?? 'neutral'}`, state);
    head.append(pill);
  }
  body.append(head);

  body.append(el('div', 'gl-title', card.title));
  if (card.description) body.append(el('div', 'gl-desc', card.description));

  const facts = el('div', 'gl-facts');
  if (card.sourceBranch && card.targetBranch) facts.append(chip('gl-branch', `${card.sourceBranch} → ${card.targetBranch}`, 'glBranch'));
  else if (card.ref) facts.append(chip('gl-branch', card.ref, card.kind === 'release' ? 'glRelease' : 'glBranch'));
  if (card.pipeline) facts.append(chip(`gl-tone-${card.pipeline === 'success' ? 'success' : card.pipeline === 'failed' ? 'failed' : 'running'}`, tl(lang, 'gitlab.pipeline', { state: stateLabel({ ...card, draft: false, state: card.pipeline }, lang) ?? card.pipeline }), 'glPipeline'));
  if (card.conflicts) facts.append(chip('gl-tone-failed', tl(lang, 'gitlab.conflicts')));
  if (card.changes) facts.append(chip('', tl(lang, 'gitlab.changes', { n: card.changes })));
  if (card.additions !== undefined || card.deletions !== undefined) {
    const c = el('span', 'gl-chip gl-diff');
    c.append(el('span', 'gl-add', `+${card.additions ?? 0}`), document.createTextNode(' '), el('span', 'gl-del', `−${card.deletions ?? 0}`));
    facts.append(c);
  }
  if (card.tasksTotal) {
    const done = card.tasksDone ?? 0;
    const c = chip('gl-progress', `${done}/${card.tasksTotal}`, undefined, tl(lang, card.kind === 'milestone' ? 'gitlab.issuesDone' : 'gitlab.tasksDone', { done, total: card.tasksTotal }));
    const bar = el('span', 'gl-bar');
    const fill = el('span', 'gl-bar-fill');
    fill.style.width = `${Math.round((100 * done) / card.tasksTotal)}%`;
    bar.append(fill);
    c.prepend(bar);
    facts.append(c);
  }
  if (card.duration) facts.append(chip('', duration(card.duration), 'glTime'));
  if (card.start || card.due) facts.append(chip('', [card.start, card.due].filter(Boolean).join(' – '), 'glTime', card.due ? tl(lang, 'gitlab.due', { date: card.due }) : undefined));
  if (card.milestone) facts.append(chip('', card.milestone, 'glMilestone'));
  for (const l of card.labels ?? []) facts.append(chip('gl-label', l));
  for (const t of card.topics ?? []) facts.append(chip('gl-label', t));
  if (card.visibility) facts.append(chip('', tl(lang, `gitlab.visibility.${card.visibility}` as I18nKey)));
  if (card.stars !== undefined) facts.append(chip('', String(card.stars), 'glStar', tl(lang, 'gitlab.stars')));
  if (card.forks !== undefined) facts.append(chip('', String(card.forks), 'glFork', tl(lang, 'gitlab.forks')));
  if (card.openIssues !== undefined && card.kind === 'project') facts.append(chip('', tl(lang, 'gitlab.openIssues', { n: card.openIssues }), 'glIssue'));
  if (card.projects !== undefined) facts.append(chip('', tl(lang, 'gitlab.projects', { n: card.projects }), 'glProject'));
  if (card.subgroups !== undefined) facts.append(chip('', tl(lang, 'gitlab.subgroups', { n: card.subgroups }), 'glGroup'));
  if (card.comments) facts.append(chip('', String(card.comments), 'glComment', tl(lang, 'gitlab.comments')));
  if (card.languages?.length) {
    const c = el('span', 'gl-chip gl-langs');
    c.textContent = card.languages.map((l) => `${l.name} ${l.percent} %`).join(' · ');
    facts.append(c);
  }
  if (facts.childElementCount) body.append(facts);

  const foot = el('div', 'gl-foot');
  const who: string[] = [];
  if (card.author) who.push(tl(lang, 'gitlab.by', { name: personText(card.author) }));
  if (card.assignees?.length) who.push(tl(lang, 'gitlab.assignees', { names: card.assignees.map(personText).join(', ') }));
  if (card.reviewers?.length) who.push(tl(lang, 'gitlab.reviewers', { names: card.reviewers.map(personText).join(', ') }));
  const when = card.merged ?? card.closed ?? card.updated ?? card.created;
  if (when) {
    const word = card.merged ? 'gitlab.mergedAt' : card.closed ? 'gitlab.closedAt' : card.updated ? 'gitlab.updatedAt' : 'gitlab.createdAt';
    const time = el('time', 'gl-when', tl(lang, word, { when: relativeTime(when, lang) }));
    time.dateTime = new Date(when).toISOString();
    time.title = new Date(when).toLocaleString(locale(lang), { dateStyle: 'medium', timeStyle: 'short' });
    foot.append(time);
  }
  if (who.length) foot.prepend(el('span', 'gl-who', who.join(' · ')));
  if (foot.childElementCount) body.append(foot);
  return body;
}

function problemText(state: string, lang: Lang): string {
  const key = `gitlab.problem.${state}` as I18nKey;
  const text = tl(lang, key);
  return text === key ? tl(lang, 'gitlab.problem.unreachable') : text;
}

/** A GitLab address alone on its line, as a card; loads when drawn, shows the plain link until then and on errors */
export class GitlabCardWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly lang: Lang
  ) {
    super();
  }

  eq(o: GitlabCardWidget) {
    return o.url === this.url && o.lang === this.lang;
  }

  get estimatedHeight() {
    return 120;
  }

  toDOM(view: EditorView) {
    const wrap = el('div', 'wz-block cm-gl-card');
    const href = safeUrl(this.url);
    const card = el('a', 'gl-card gl-loading');
    if (href) {
      card.href = href;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
    }
    card.setAttribute('data-gitlab-card', 'loading');
    card.append(el('span', 'gl-url', this.url));
    // The click opens the link; editing goes through the edit button
    card.addEventListener('mousedown', (e) => e.stopPropagation());
    wrap.append(card);

    const refresh = el('button', 'gl-refresh');
    refresh.type = 'button';
    refresh.title = tl(this.lang, 'gitlab.refresh');
    refresh.setAttribute('aria-label', tl(this.lang, 'gitlab.refresh'));
    refresh.textContent = '↻';
    refresh.addEventListener('mousedown', (e) => e.preventDefault());
    wrap.append(refresh);
    if (view.state.facet(EditorView.editable) && !view.state.readOnly) wrap.append(editButton(view, () => view.posAtDOM(wrap), this.lang));

    const show = (r: GitlabCardState) => {
      card.replaceChildren();
      card.classList.remove('gl-loading');
      if (r.state === 'ok') {
        card.dataset.gitlabCard = r.card.kind;
        card.classList.remove('gl-problem');
        card.append(gitlabCardBody(r.card, this.lang));
        card.title = this.url;
      } else {
        card.dataset.gitlabCard = 'problem';
        card.classList.add('gl-problem');
        const head = el('div', 'gl-card-head');
        const kind = el('span', 'gl-kind');
        kind.append(icon('glProject', 15), document.createTextNode('GitLab'));
        head.append(kind, el('span', 'gl-problem-text', problemText(r.state, this.lang)));
        card.append(head, el('span', 'gl-url', this.url));
      }
      view.requestMeasure();
    };
    const load = (fresh: boolean) =>
      editorHost.loadGitlabCard(this.url, fresh).then(show, () => show({ state: 'offline' }));
    refresh.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      refresh.classList.add('gl-spin');
      void load(true).finally(() => refresh.classList.remove('gl-spin'));
    });
    void load(false);
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}
