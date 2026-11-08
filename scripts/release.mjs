#!/usr/bin/env node
// Bumps the version of all workspaces and turns the "Unveröffentlicht" section of
// the changelogs (CHANGELOG*.md) into a new release.
//
//   npm run release -- patch|minor|major|<x.y.z>   stable release (or first RC with --rc)
//   npm run release -- patch|minor|major|<x.y.z> --rc   start release candidate x.y.z-rc.1
//   npm run release -- rc                            next candidate (x.y.z-rc.N → x.y.z-rc.N+1)
//   npm run release -- final                         promote x.y.z-rc.N to x.y.z
//   npm run release -- auto                          derive the bump from the commits since
//                                                    the last tag (used by the deploy pipeline)
//
// auto reads Conventional Commits since the last v* tag: a breaking change ("feat!:" or a
// "BREAKING CHANGE:" footer) is major (minor while the version is 0.x), feat is minor,
// fix/perf/revert is patch; anything else (docs, chore, ci, ...) releases nothing. Without
// any v* tag the current version itself is released. An empty "Unveröffentlicht" section
// is allowed here, so a fix without a changelog line still ships.
//
// Release candidates only bump versions; the changelogs stay under "Unveröffentlicht"
// and are written into the final release.
//
// Afterwards: review the diff, then commit and tag, e.g.
//   git commit -am "chore(release): v1.2.1" && git tag v1.2.1
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = (rel) => path.join(root, rel);
const PACKAGES = ['package.json', 'packages/shared/package.json', 'packages/server/package.json', 'packages/client/package.json'];
const VERSION_TS = 'packages/shared/src/version.ts';
// One changelog for everybody
const CHANGELOGS = ['CHANGELOG.md'];
const UNRELEASED = 'Unveröffentlicht';

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;
const USAGE = 'Usage: npm run release -- patch|minor|major|<x.y.z> [--rc] | rc | final | auto';

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Bump for "auto": null = nothing to release, 'initial' = no tag yet, release the current version */
function autoBump(current) {
  let lastTag;
  try {
    lastTag = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD');
  } catch {
    return 'initial';
  }
  const commits = git('log', '--format=%B%x00', `${lastTag}..HEAD`).split('\0').map((c) => c.trim()).filter(Boolean);
  const rank = { patch: 1, minor: 2, major: 3 };
  let bump = null;
  for (const message of commits) {
    const header = message.split('\n')[0];
    const m = /^(\w+)(?:\([^)]*\))?(!)?:/.exec(header);
    if (!m || /^chore\(release\)/.test(header)) continue;
    let level = null;
    if (m[2] || /^BREAKING[ -]CHANGE:/m.test(message)) level = 'major';
    else if (m[1] === 'feat') level = 'minor';
    else if (['fix', 'perf', 'revert'].includes(m[1])) level = 'patch';
    if (level && (!bump || rank[level] > rank[bump])) bump = level;
  }
  // 0.x: breaking changes only bump the minor version
  if (bump === 'major' && current.startsWith('0.')) bump = 'minor';
  return bump;
}

function nextVersion(current, bump, asRc) {
  const [, major, minor, patch, rc] = current.match(VERSION_RE).map((n) => (n === undefined ? n : Number(n)));
  const base = `${major}.${minor}.${patch}`;
  if (rc !== undefined) {
    // A candidate is in flight: only continue or finish it
    if (bump === 'rc') return `${base}-rc.${rc + 1}`;
    if (bump === 'final') return base;
    fail(`${current} is a release candidate – use "rc" for the next candidate or "final" to release ${base}`);
  }
  if (bump === 'rc' || bump === 'final') fail(`${current} is not a release candidate`);
  let target;
  if (/^\d+\.\d+\.\d+$/.test(bump)) target = bump;
  else if (bump === 'major') target = `${major + 1}.0.0`;
  else if (bump === 'minor') target = `${major}.${minor + 1}.0`;
  else if (bump === 'patch') target = `${major}.${minor}.${patch + 1}`;
  else fail(USAGE);
  return asRc ? `${target}-rc.1` : target;
}

const args = process.argv.slice(2);
const asRc = args.includes('--rc');
let bump = args.find((a) => !a.startsWith('--'));
if (!bump) fail(USAGE);
const current = JSON.parse(readFileSync(file('package.json'), 'utf8')).version;
if (!VERSION_RE.test(current)) fail(`Unsupported current version ${current}`);
const auto = bump === 'auto';
if (auto) {
  if (asRc) fail('auto cannot start a release candidate');
  bump = autoBump(current);
  if (!bump) {
    console.log('✔ No feat/fix commits since the last release – nothing to release');
    process.exit(0);
  }
  if (bump === 'initial') bump = current;
  console.log(`  auto: ${bump}`);
}
const version = nextVersion(current, bump, asRc);
// auto without a tag releases the current version itself
if (version === current && !(auto && bump === current)) fail(`Version is already ${current}`);
const isRc = VERSION_RE.exec(version)[4] !== undefined;

// CHANGELOGS: move unreleased entries under a new version heading
const heading = `## [${UNRELEASED}]`;
const today = new Date().toISOString().slice(0, 10);
const releases = [];
for (const name of isRc ? [] : CHANGELOGS) {
  const changelog = readFileSync(file(name), 'utf8');
  const start = changelog.indexOf(heading);
  if (start === -1) fail(`${name} has no "${heading}" section`);
  const bodyStart = start + heading.length;
  const nextHeading = changelog.indexOf('\n## [', bodyStart);
  const body = changelog.slice(bodyStart, nextHeading === -1 ? undefined : nextHeading).trim();
  if (!body) continue;
  releases.push({
    name,
    text:
      changelog.slice(0, bodyStart) +
      `\n\n## [${version}] – ${today}\n\n${body}\n` +
      (nextHeading === -1 ? '' : changelog.slice(nextHeading)),
  });
}
if (!isRc && !auto && !releases.length) fail(`"${heading}" is empty in all of ${CHANGELOGS.join(', ')} – add the changes first`);
for (const { name, text } of releases) writeFileSync(file(name), text);

for (const rel of PACKAGES) {
  const pkg = JSON.parse(readFileSync(file(rel), 'utf8'));
  pkg.version = version;
  writeFileSync(file(rel), JSON.stringify(pkg, null, 2) + '\n');
}
const lock = JSON.parse(readFileSync(file('package-lock.json'), 'utf8'));
lock.version = version;
for (const rel of PACKAGES) lock.packages[path.dirname(rel).replace(/^\.$/, '')].version = version;
writeFileSync(file('package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
writeFileSync(file(VERSION_TS), `// Generated by scripts/release.mjs – do not edit by hand.\nexport const APP_VERSION = '${version}';\n`);

console.log(`✔ ${current} → ${version}`);
console.log(`  Next: git commit -am "chore(release): v${version}" && git tag v${version}`);
