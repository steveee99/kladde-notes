import { describe, expect, it } from 'vitest';
import { cardLineUrl, gitlabPathAllowed, gitlabTone, parseGitlabUrl, type RemoteHost } from '../src/index.js';

const hosts: RemoteHost[] = [
  { kind: 'gitlab', url: 'https://git.example.com' },
  { kind: 'gitlab', url: 'https://example.org/gitlab' },
  { kind: 'github', url: 'https://github.com' },
];
const parse = (url: string) => parseGitlabUrl(url, hosts);

describe('GitLab addresses for preview cards', () => {
  it('knows merge requests, issues, pipelines, commits, milestones and releases', () => {
    expect(parse('https://git.example.com/team/app/-/merge_requests/12')).toEqual({ kind: 'merge_request', host: 'https://git.example.com', path: 'team/app', id: '12' });
    expect(parse('https://git.example.com/team/sub/app/-/merge_requests/12/diffs?view=inline#note_1')).toMatchObject({ kind: 'merge_request', path: 'team/sub/app', id: '12' });
    expect(parse('https://git.example.com/team/app/-/issues/4')).toMatchObject({ kind: 'issue', id: '4' });
    expect(parse('https://git.example.com/team/app/-/work_items/5')).toMatchObject({ kind: 'issue', id: '5' });
    expect(parse('https://git.example.com/team/app/-/pipelines/991')).toMatchObject({ kind: 'pipeline', id: '991' });
    expect(parse('https://git.example.com/team/app/-/commit/ABCDEF1234')).toMatchObject({ kind: 'commit', id: 'abcdef1234' });
    expect(parse('https://git.example.com/team/app/-/milestones/3')).toMatchObject({ kind: 'milestone', id: '3' });
    expect(parse('https://git.example.com/team/app/-/releases/v1.2.0')).toMatchObject({ kind: 'release', id: 'v1.2.0' });
    expect(parse('https://git.example.com/team/app/-/tags/release/2026')).toMatchObject({ kind: 'release', id: 'release/2026' });
  });

  it('knows projects and groups', () => {
    expect(parse('https://git.example.com/team/app')).toMatchObject({ kind: 'path', path: 'team/app' });
    expect(parse('https://git.example.com/team/app/-/tree/main/docs')).toMatchObject({ kind: 'project', path: 'team/app' });
    expect(parse('https://git.example.com/team/app/-/merge_requests')).toMatchObject({ kind: 'project' });
    expect(parse('https://git.example.com/groups/team/sub')).toMatchObject({ kind: 'group', path: 'team/sub' });
    expect(parse('https://git.example.com/groups/team/-/epics')).toMatchObject({ kind: 'group', path: 'team' });
    expect(parse('https://git.example.com/team')).toMatchObject({ kind: 'group', path: 'team' });
    expect(parse('https://example.org/gitlab/team/app/-/issues/1')).toMatchObject({ kind: 'issue', host: 'https://example.org/gitlab', path: 'team/app' });
  });

  it('refuses everything else', () => {
    expect(parse('https://github.com/team/app/pull/1')).toBeNull();
    expect(parse('https://other.example.com/team/app')).toBeNull();
    expect(parse('https://git.example.com/')).toBeNull();
    expect(parse('https://git.example.com/users/anna')).toBeNull();
    expect(parse('https://git.example.com/explore/projects')).toBeNull();
    expect(parse('https://user:pw@git.example.com/team/app')).toBeNull();
    expect(parse('https://git.example.com/team/%2E%2E/app')).toBeNull();
    expect(parse('https://git.example.com/team/a%2Fb')).toBeNull();
    expect(parse('https://git.example.com/team/app/-/commit/xyz')).toBeNull();
    expect(parse('javascript:alert(1)')).toBeNull();
  });

  it('finds the address on a line of its own', () => {
    expect(cardLineUrl('https://git.example.com/a/b/-/issues/1')).toBe('https://git.example.com/a/b/-/issues/1');
    expect(cardLineUrl('  <https://git.example.com/a/b>  ')).toBe('https://git.example.com/a/b');
    expect(cardLineUrl('See https://git.example.com/a/b')).toBeNull();
    expect(cardLineUrl('[x](https://git.example.com/a/b)')).toBeNull();
  });

  it('checks allowed paths and tones', () => {
    expect(gitlabPathAllowed('team/app', ['team'])).toBe(true);
    expect(gitlabPathAllowed('team', ['team/docs'])).toBe(false);
    expect(gitlabPathAllowed('other/app', [])).toBe(true);
    expect(gitlabTone('merge_request', 'opened', true)).toBe('draft');
    expect(gitlabTone('merge_request', 'merged')).toBe('merged');
    expect(gitlabTone('pipeline', 'running')).toBe('running');
    expect(gitlabTone('issue', 'closed')).toBe('closed');
  });
});
