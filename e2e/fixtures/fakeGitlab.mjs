// A tiny GitLab for the remote notes tests: the repository files API behind a token. Tests put files with
// `PUT /__files?project=…&ref=…&path=…`; `GET /__seen` lists the requests (paths only).
import http from 'http';

export async function startFakeGitlab(token) {
  const files = new Map();
  const seen = [];
  const key = (project, ref, path) => [project, ref, path].join('\n');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const q = url.searchParams;
    if (url.pathname === '/__seen') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(seen));
    if (url.pathname === '/__files') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      files.set(key(q.get('project'), q.get('ref'), q.get('path')), Buffer.concat(chunks));
      return res.writeHead(204).end();
    }
    seen.push(req.url);
    const json = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (req.headers['private-token'] !== token) return json(401, { message: '401 Unauthorized' });
    if (url.pathname === '/api/v4/user') return json(200, { username: 'kladde-bot' });
    // Preview cards: one merge request and its project (team/cards)
    if (url.pathname === '/api/v4/projects/team%2Fcards/merge_requests/12')
      return json(200, { title: 'Faster sync', state: 'opened', draft: false, source_branch: 'feat/sync', target_branch: 'main', labels: ['perf'], author: { name: 'Anna', username: 'anna' }, head_pipeline: { status: 'success' }, user_notes_count: 2, changes_count: '4', updated_at: '2026-11-20T10:00:00Z' });
    if (url.pathname === '/api/v4/projects/team%2Fcards') return json(200, { name: 'Cards', path_with_namespace: 'team/cards', description: 'Preview **cards**', default_branch: 'main', star_count: 7, forks_count: 1, visibility: 'internal' });
    if (url.pathname === '/api/v4/projects/team%2Fcards/languages') return json(200, { TypeScript: 90.2, CSS: 9.8 });
    if (url.pathname.endsWith('/repository/commits')) return json(200, [{ id: 'abcdef0123456789abcdef0123456789abcdef01', committed_date: '2026-03-04T05:06:07Z' }]);
    const m = /^\/api\/v4\/projects\/([^/]+)\/repository\/files\/([^/]+)\/raw$/.exec(url.pathname);
    const file = m && files.get(key(decodeURIComponent(m[1]), q.get('ref') ?? 'HEAD', decodeURIComponent(m[2])));
    if (!file) return json(404, { message: '404 File Not Found' });
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(file);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  server.unref();
  return `http://127.0.0.1:${server.address().port}`;
}
