#!/usr/bin/env node
// Builds a standalone single-file executable (Node.js SEA) of Kladde.
//
// Usage:
//   npm run build:desktop                 # native executable for current OS (dist/kladde or dist/kladde.exe)
//   npm run build:exe                     # Windows portable executable (dist/kladde.exe; native on Win, downloads node.exe on macOS/Linux)
//   node scripts/build-desktop.mjs --win --arch=x64 --skip-build --console --out=dist/kladde.exe --node-exe=/path/to/node.exe
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

function checkNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    fail(`Node.js >= 22.13 wird benötigt (gefunden: ${process.version}).`);
  }
}

function readArg(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
    if (a === flag && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  }
  return undefined;
}

function parsePeOffsets(buf) {
  if (buf.length < 64 || buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('Ungültige Windows-PE-Datei (MZ-Signatur fehlt)');
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 > buf.length || buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('Ungültiger PE-Header');
  }
  const numberOfSections = buf.readUInt16LE(peOffset + 6);
  const sizeOfOptionalHeader = buf.readUInt16LE(peOffset + 20);
  const optOffset = peOffset + 24;
  if (optOffset + sizeOfOptionalHeader > buf.length || sizeOfOptionalHeader < 96) {
    throw new Error('Ungültiger PE-Optional-Header');
  }
  const magic = buf.readUInt16LE(optOffset);
  if (magic !== 0x010b && magic !== 0x020b) {
    throw new Error(`Unbekanntes PE-Format: 0x${magic.toString(16)}`);
  }
  const isPe32Plus = magic === 0x020b;
  const checkSumOffset = optOffset + 64;
  const subsystemOffset = optOffset + 68;
  const numRvaOffset = optOffset + (isPe32Plus ? 108 : 92);
  const dataDirOffset = optOffset + (isPe32Plus ? 112 : 96);
  const numRvas = numRvaOffset + 4 <= optOffset + sizeOfOptionalHeader ? buf.readUInt32LE(numRvaOffset) : 0;

  let maxSectionFileEnd = optOffset + sizeOfOptionalHeader + numberOfSections * 40;
  for (let i = 0; i < numberOfSections; i++) {
    const secOffset = optOffset + sizeOfOptionalHeader + i * 40;
    const rawSize = buf.readUInt32LE(secOffset + 16);
    const rawPtr = buf.readUInt32LE(secOffset + 20);
    if (rawPtr > 0 && rawPtr + rawSize > maxSectionFileEnd) {
      maxSectionFileEnd = rawPtr + rawSize;
    }
  }

  return { checkSumOffset, subsystemOffset, dataDirOffset, numRvas, maxSectionFileEnd };
}

/**
 * Removes an Authenticode signature cleanly from a Windows PE executable without requiring signtool.exe.
 */
function stripPeSignature(buf) {
  const { checkSumOffset, dataDirOffset, numRvas, maxSectionFileEnd } = parsePeOffsets(buf);
  let out = Buffer.from(buf);
  out.writeUInt32LE(0, checkSumOffset);

  if (numRvas <= 4) return { buf: out, removedBytes: 0 };
  const secDirOffset = dataDirOffset + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY
  const certOffset = out.readUInt32LE(secDirOffset);
  const certSize = out.readUInt32LE(secDirOffset + 4);
  if (certOffset === 0 && certSize === 0) return { buf: out, removedBytes: 0 };

  out.writeUInt32LE(0, secDirOffset);
  out.writeUInt32LE(0, secDirOffset + 4);
  if (certSize > 0 && certOffset >= maxSectionFileEnd && certOffset + certSize === out.length) {
    out = out.subarray(0, certOffset);
    return { buf: out, removedBytes: certSize };
  }
  return { buf: out, removedBytes: 0 };
}

/**
 * Sets PE OptionalHeader.Subsystem (`2` = WINDOWS_GUI to suppress console popup, `3` = WINDOWS_CUI) and clears CheckSum.
 */
function setPeSubsystem(buf, subsystem) {
  const { checkSumOffset, subsystemOffset } = parsePeOffsets(buf);
  const out = Buffer.from(buf);
  out.writeUInt32LE(0, checkSumOffset);
  out.writeUInt16LE(subsystem, subsystemOffset);
  return out;
}

/**
 * Extracts `node.exe` from an official Node.js Windows ZIP archive using only Node built-ins.
 */
function extractNodeExeFromZip(zipBuf) {
  const minScan = Math.max(0, zipBuf.length - 65557);
  let eocdOffset = -1;
  for (let i = zipBuf.length - 22; i >= minScan; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Ungültige ZIP-Datei (EOCD nicht gefunden)');

  const entriesCount = zipBuf.readUInt16LE(eocdOffset + 10);
  let pos = zipBuf.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < entriesCount; i++) {
    if (pos + 46 > zipBuf.length || zipBuf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error('Ungültiger ZIP Central Directory Header');
    }
    const method = zipBuf.readUInt16LE(pos + 10);
    const compressedSize = zipBuf.readUInt32LE(pos + 20);
    const uncompressedSize = zipBuf.readUInt32LE(pos + 24);
    const nameLen = zipBuf.readUInt16LE(pos + 28);
    const extraLen = zipBuf.readUInt16LE(pos + 30);
    const commentLen = zipBuf.readUInt16LE(pos + 32);
    const localOffset = zipBuf.readUInt32LE(pos + 42);
    const fileName = zipBuf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;

    if (fileName === 'node.exe' || fileName.endsWith('/node.exe')) {
      if (localOffset + 30 > zipBuf.length || zipBuf.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error('Ungültiger ZIP Local File Header');
      }
      const lhNameLen = zipBuf.readUInt16LE(localOffset + 26);
      const lhExtraLen = zipBuf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
      const compressed = zipBuf.subarray(dataStart, dataStart + compressedSize);
      let extracted;
      if (method === 0) extracted = Buffer.from(compressed);
      else if (method === 8) extracted = zlib.inflateRawSync(compressed);
      else throw new Error(`Nicht unterstützte ZIP-Kompression (${method})`);
      if (extracted.length !== uncompressedSize) {
        throw new Error(`Größenabweichung beim Entpacken von node.exe (${extracted.length} != ${uncompressedSize})`);
      }
      return extracted;
    }
  }
  throw new Error('node.exe nicht im ZIP-Archiv gefunden');
}

function parseSemver(ver) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(ver.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isSupportedNodeVersion(ver) {
  const p = parseSemver(ver);
  return !!p && (p[0] > 22 || (p[0] === 22 && p[1] >= 13));
}

function compareSemverDesc(a, b) {
  const pa = parseSemver(a) || [0, 0, 0];
  const pb = parseSemver(b) || [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (pb[i] !== pa[i]) return pb[i] - pa[i];
  }
  return 0;
}

function binaryHasSeaFuse(binPath) {
  try {
    if (!fs.existsSync(binPath)) return false;
    const st = fs.statSync(binPath);
    // Dynamically linked libnode shims (e.g. Homebrew) are < 1 MB and have no embedded SEA fuse
    if (!st.isFile() || st.size < 20_000_000) return false;
    return fs.readFileSync(binPath).includes(SEA_FUSE);
  } catch {
    return false;
  }
}

function findLocalSeaNode(preferVersion) {
  const home = os.homedir();
  const candidates = [];

  if (process.env.KLADDE_SEA_NODE) candidates.push(process.env.KLADDE_SEA_NODE);
  if (!process.config?.variables?.node_shared) candidates.push(process.execPath);

  const versionedRoots = [
    path.join(process.env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node'),
    path.join(process.env.FNM_DIR || path.join(home, '.local', 'share', 'fnm'), 'node-versions'),
    path.join(home, '.volta', 'tools', 'image', 'node'),
  ];

  for (const base of versionedRoots) {
    try {
      if (!fs.existsSync(base)) continue;
      const dirs = fs.readdirSync(base).sort(compareSemverDesc);
      if (preferVersion) {
        dirs.sort((a, b) => (a === preferVersion ? -1 : b === preferVersion ? 1 : compareSemverDesc(a, b)));
      }
      for (const dir of dirs) {
        if (!isSupportedNodeVersion(dir)) continue;
        const relBin = process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node');
        candidates.push(path.join(base, dir, relBin));
        candidates.push(path.join(base, dir, 'installation', relBin));
      }
    } catch {
      // ignore unreadable version directories
    }
  }

  if (process.platform !== 'win32') {
    candidates.push('/usr/local/bin/node', '/opt/homebrew/opt/node@24/bin/node', '/opt/homebrew/opt/node@22/bin/node');
  }

  for (const binPath of new Set(candidates)) {
    if (!binaryHasSeaFuse(binPath)) continue;
    try {
      const version = execFileSync(binPath, ['-p', 'process.version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (isSupportedNodeVersion(version)) return { executable: binPath, version };
    } catch {
      // ignore unusable candidate
    }
  }
  return null;
}

async function fetchOfficialDist(archiveName, nodeVersion) {
  const url = `https://nodejs.org/dist/${nodeVersion}/${archiveName}`;
  const sumsUrl = `https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`;
  const [sumsRes, fileRes] = await Promise.all([fetch(sumsUrl), fetch(url)]);
  if (!sumsRes.ok) fail(`Konnte ${sumsUrl} nicht laden (${sumsRes.status})`);
  if (!fileRes.ok) fail(`Konnte ${url} nicht laden (${fileRes.status})`);

  const sumsText = await sumsRes.text();
  const expectedLine = sumsText
    .split(/\r?\n/)
    .find((line) => line.trim().endsWith(` ${archiveName}`) || line.trim().endsWith(`\t${archiveName}`));
  if (!expectedLine) fail(`SHA256 für ${archiveName} in SHASUMS256.txt nicht gefunden`);
  const expectedHash = expectedLine.trim().split(/\s+/)[0].toLowerCase();

  const buf = Buffer.from(await fileRes.arrayBuffer());
  const actualHash = crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
  if (actualHash !== expectedHash) {
    fail(`SHA256-Prüfung fehlgeschlagen für ${archiveName} (${actualHash} != ${expectedHash})`);
  }
  return buf;
}

async function resolveHostSeaNode(requestedVersion) {
  const local = findLocalSeaNode(requestedVersion);
  if (local && (!requestedVersion || local.version === requestedVersion)) {
    return local;
  }
  if (local && !requestedVersion) {
    return local;
  }

  const version = requestedVersion || process.version;
  const plat = process.platform === 'win32' ? 'win' : process.platform;
  const cacheDir = path.join(root, 'build', 'cache', `node-${version}-${plat}-${process.arch}`);
  const binPath = path.join(cacheDir, process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'));
  if (binaryHasSeaFuse(binPath)) {
    return { executable: binPath, version };
  }

  if (process.platform === 'win32') {
    const archiveName = `node-${version}-win-${process.arch}.zip`;
    console.log(`⬇️  Lade statische Node-Laufzeit (${archiveName}) …`);
    const zipBuf = await fetchOfficialDist(archiveName, version);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(binPath, extractNodeExeFromZip(zipBuf));
    return { executable: binPath, version };
  }

  const folder = `node-${version}-${plat}-${process.arch}`;
  const archiveName = `${folder}.tar.gz`;
  console.log(`⬇️  Aktuelles Node (${path.basename(process.execPath)}) unterstützt kein SEA – lade statische Laufzeit (${archiveName}) …`);
  const tgzBuf = await fetchOfficialDist(archiveName, version);
  fs.mkdirSync(cacheDir, { recursive: true });
  const tgzPath = path.join(cacheDir, archiveName);
  fs.writeFileSync(tgzPath, tgzBuf);
  try {
    execFileSync('tar', ['-xzf', tgzPath, '-C', cacheDir, '--strip-components=1', `${folder}/bin/node`], { stdio: 'inherit' });
  } finally {
    fs.rmSync(tgzPath, { force: true });
  }
  if (!binaryHasSeaFuse(binPath)) fail(`Entpackte Node-Laufzeit hat kein SEA-Support: ${binPath}`);
  return { executable: binPath, version };
}

async function resolveBaseBinary({ targetWindows, arch, nodeVersion, nodeExeOverride, hostSea }) {
  if (nodeExeOverride) {
    const abs = path.resolve(root, nodeExeOverride);
    if (!fs.existsSync(abs)) fail(`--node-exe nicht gefunden: ${abs}`);
    return abs;
  }

  if (!targetWindows) {
    return hostSea.executable;
  }

  if (process.platform === 'win32' && arch === process.arch && nodeVersion === hostSea.version) {
    return hostSea.executable;
  }

  const cacheDir = path.join(root, 'build', 'cache', `node-${nodeVersion}-win-${arch}`);
  const cachedExe = path.join(cacheDir, 'node.exe');
  if (fs.existsSync(cachedExe) && fs.statSync(cachedExe).size > 10_000_000) {
    return cachedExe;
  }

  const archiveName = `node-${nodeVersion}-win-${arch}.zip`;
  console.log(`⬇️  Lade Windows-Node-Laufzeit (${archiveName}) …`);
  const zipBuf = await fetchOfficialDist(archiveName, nodeVersion);
  const exeBuf = extractNodeExeFromZip(zipBuf);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cachedExe, exeBuf);
  return cachedExe;
}

async function main() {
  checkNodeVersion();

  const argv = process.argv.slice(2);
  const targetWindows = argv.includes('--win') || process.platform === 'win32';
  const arch = readArg(argv, '--arch') || (targetWindows && process.platform !== 'win32' ? 'x64' : process.arch);
  const explicitVersion = readArg(argv, '--node-version');
  const requestedVersion = explicitVersion ? (explicitVersion.startsWith('v') ? explicitVersion : `v${explicitVersion}`) : undefined;
  const nodeExeOverride = readArg(argv, '--node-exe');
  const skipBuild = argv.includes('--skip-build');
  const keepConsole = argv.includes('--console');
  const customOut = readArg(argv, '--out');
  const outFile = path.resolve(root, customOut || (targetWindows ? 'dist/kladde.exe' : 'dist/kladde'));

  if (!skipBuild) {
    console.log('🔨 Baue shared, server und client …');
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const buildEnv = {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
    };
    execFileSync(npmCmd, ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: buildEnv });
  }

  const clientDist = path.join(root, 'packages', 'client', 'dist');
  const standaloneJs = path.join(root, 'packages', 'server', 'dist', 'standalone.js');
  if (!fs.existsSync(path.join(clientDist, 'index.html'))) {
    fail(`Frontend-Build fehlt: ${path.join(clientDist, 'index.html')}`);
  }
  if (!fs.existsSync(standaloneJs)) {
    fail(`Server-Build fehlt: ${standaloneJs}`);
  }

  const workDir = path.join(root, 'build', 'desktop');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  console.log('📦 Packe Frontend-Assets …');
  const { packClientAssets } = await import(pathToFileURL(standaloneJs).href);
  const assetsBlob = packClientAssets(clientDist);
  const assetsPath = path.join(workDir, 'client-assets.bin');
  fs.writeFileSync(assetsPath, assetsBlob);

  console.log('⚡ Bündle Server als Single-File-CJS …');
  const esbuild = require('esbuild');
  const bundlePath = path.join(workDir, 'server.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'packages', 'server', 'src', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['node:*'],
    define: {
      'import.meta.url': 'undefined',
    },
    legalComments: 'none',
    minify: true,
    outfile: bundlePath,
  });

  const hostSea = await resolveHostSeaNode(requestedVersion);
  const targetVersion = requestedVersion || hostSea.version;
  console.log(`🧪 Erzeuge Node.js SEA-Blob (${hostSea.version}) …`);
  const seaConfigPath = path.join(workDir, 'sea-config.json');
  const seaBlobPath = path.join(workDir, 'sea-prep.blob');
  fs.writeFileSync(
    seaConfigPath,
    JSON.stringify(
      {
        main: bundlePath,
        output: seaBlobPath,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        assets: {
          'client-assets.bin': assetsPath,
        },
      },
      null,
      2
    )
  );
  execFileSync(hostSea.executable, ['--experimental-sea-config', seaConfigPath], { cwd: root, stdio: 'inherit' });

  const baseBinary = await resolveBaseBinary({
    targetWindows,
    arch,
    nodeVersion: targetVersion,
    nodeExeOverride,
    hostSea,
  });
  const seaBlob = fs.readFileSync(seaBlobPath);
  const tmpOut = `${outFile}.tmp`;
  fs.copyFileSync(baseBinary, tmpOut);

  if (targetWindows) {
    const rawPe = fs.readFileSync(tmpOut);
    const { buf: unsignedPe } = stripPeSignature(rawPe);
    fs.writeFileSync(tmpOut, unsignedPe);
  } else if (process.platform === 'darwin') {
    execFileSync('codesign', ['--remove-signature', tmpOut], { stdio: 'inherit' });
  }

  console.log(`💉 Injiziere Anwendung in ${path.relative(root, outFile)} …`);
  const { inject } = require('postject');
  await inject(tmpOut, 'NODE_SEA_BLOB', seaBlob, {
    machoSegmentName: !targetWindows && process.platform === 'darwin' ? 'NODE_SEA' : undefined,
    sentinelFuse: SEA_FUSE,
    overwrite: true,
  });

  if (targetWindows) {
    const injectedPe = fs.readFileSync(tmpOut);
    // Use WINDOWS_GUI (2) by default so launching kladde.exe never flashes an empty cmd console
    const finalizedPe = setPeSubsystem(injectedPe, keepConsole ? 3 : 2);
    fs.writeFileSync(tmpOut, finalizedPe);
  } else if (process.platform === 'darwin') {
    execFileSync('codesign', ['--sign', '-', tmpOut], { stdio: 'inherit' });
  }

  if (!targetWindows) {
    fs.chmodSync(tmpOut, 0o755);
  }

  fs.renameSync(tmpOut, outFile);
  const sizeMb = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(1);
  console.log(`✅ Standalone-Executable erstellt: ${path.relative(root, outFile)} (${sizeMb} MB)`);
}

main().catch((err) => {
  console.error('Build fehlgeschlagen:', err);
  process.exit(1);
});
