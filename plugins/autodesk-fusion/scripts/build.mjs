import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyNativeDistribution } from './verify-native.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
const nativeDistribution = await verifyNativeDistribution(root);
await writeFile(path.join(root, 'native', 'build-manifest.json'), JSON.stringify(nativeDistribution, null, 2) + '\n');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await promisify(execFile)(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--declaration', '--emitDeclarationOnly', '--noEmit', 'false', '--outDir', path.join(output, 'types')], { cwd: root, maxBuffer: 4_194_304 });
await writeFile(path.join(output, 'index.d.mts'), 'export * from "./types/index.js";\n');
const built = await build({ absWorkingDir: root, entryPoints: { index: 'src/index.ts', server: 'src/server.ts', cli: 'src/cli.ts' }, outdir: 'dist', bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node22.19', outExtension: { '.js': '.mjs' }, sourcemap: false, minify: false, legalComments: 'eof', metafile: true });
const addinOutput = path.join(output, 'addin', 'CodexFusionInterop');
await cp(path.join(root, 'addin', 'CodexFusionInterop'), addinOutput, { recursive: true, filter: name => !name.includes('__pycache__') && !name.endsWith('.pyc') });
const handler = await readFile(path.join(root, 'handlers', 'fusion_runtime.py'));
await writeFile(path.join(addinOutput, 'fusion_runtime.py'), handler);
await writeFile(path.join(addinOutput, 'handler-manifest.json'), JSON.stringify({ version: 1, handler_file: 'fusion_runtime.py', handler_hash: createHash('sha256').update(handler).digest('hex') }, null, 2) + '\n');
const registry = await import(pathToFileURL(path.join(output, 'index.mjs')).href);
const operations = registry.describeOperations(undefined, true);
const boundaries = [...registry.capabilityBoundaries,
  { family: 'released_variants_outside_registry', maturity: 'released', status: 'not_implemented_in_typed_facade', reason: 'Guided/surface/solid-body sweep and loft variants, two-angle draft, feature/occurrence mirrors, general surface/direct geometry authoring, motion-joint variants, appearance editing, hem/Form/mesh exchange, turning/multi-axis/additive and administration require additional reviewed handlers and live qualification. The assisted native route is separate broad authority.' }
];
await mkdir(path.join(root, 'docs'), { recursive: true });
for (const name of ['autodesk-fusion-360-plugin-implementation-plan.md', 'autodesk-fusion-implementation-status.md']) {
  const installedPath = path.join(root, 'docs', name);
  try {
    const source = await readFile(path.resolve(root, '..', '..', 'docs', name), 'utf8');
    await writeFile(installedPath, source.replaceAll('(../plugins/autodesk-fusion/', '(../'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A source-only plugin checkout may use its already packaged research/status
    // copies. Never create empty substitutes for missing documentation.
    await readFile(installedPath);
  }
}
await writeFile(path.join(root, 'docs', 'operation-catalog.json'), JSON.stringify({ schema: 1, generated_from: 'src/catalog.ts', live_qualified: false, operations, boundaries }, null, 2) + '\n');
const lines = ['# Generated desktop support matrix', '', 'Generated from the shipped typed operation registry. “Implemented” means an actual reviewed handler exists. It does not establish installed entitlement, kernel correctness or live qualification. Exact argument schemas are in `operation-catalog.json` and the MCP discovery tool.', '', '| Operation | Effect | Implemented variant / API | Live qualification |', '| --- | --- | --- | --- |'];
for (const op of operations) lines.push(`| \`${op.id}\` | ${op.effect} | [${op.title}](${op.source})${op.notes ? ' — ' + op.notes : ''} | Required |`);
lines.push('', '## Explicit boundaries', '', '| Family | Status | Reason |', '| --- | --- | --- |');
for (const boundary of boundaries) lines.push(`| ${boundary.family} | ${boundary.status} | ${boundary.reason} |`);
lines.push('', 'Cloud read/property/BOM/Automation/enterprise extension contracts are documented in the enterprise guide and exposed by their own discovery tools. Data and compute availability requires its own credentials, scopes, schema/recipe and account qualification. Preview APIs do not count as production coverage.', '', 'The implementation plan remains the broader roadmap. This registry does not claim every Fusion UI command, extension, API variant, business-system transition or machine process.', '');
await writeFile(path.join(root, 'docs', 'support-matrix.md'), lines.join('\n'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const bundledPackages = new Set(Object.keys(built.metafile.inputs).filter(name => name.startsWith('node_modules/')).map(name => name.split('/').slice(1, name.startsWith('node_modules/@') ? 3 : 2).join('/')));
const notices = ['Autodesk Fusion interoperability — third-party notices', '', 'This plugin is Apache-2.0. Bundled third-party JavaScript and community-patched native credential sources retain their upstream licenses. Complete collected native dependency/runtime license texts are included in native/UPSTREAM_NOTICES.txt; source, lockfile, compiler and asset provenance are in native/source-manifest.json, native/receipts and docs/native-dependencies.json. Original npm native binaries are not redistributed. No Autodesk runtime or SDK entitlement is distributed.', ''];
const inventory = [];
for (const [location, entry] of Object.entries(lock.packages).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
  if (!location.startsWith('node_modules/')) continue;
  const name = location.slice('node_modules/'.length);
  const distributed = bundledPackages.has(name);
  inventory.push({ name, version: entry.version, license: entry.license ?? 'See upstream package', development_dependency: entry.dev === true, distributed, registry_integrity: entry.integrity ?? null, resolved: entry.resolved ?? null });
  if (!bundledPackages.has(name)) continue;
  notices.push(`${name}@${entry.version}`, `License: ${entry.license ?? 'See included license'}`, `Registry integrity: ${entry.integrity ?? 'not available'}`);
  let found = false;
  for (const candidate of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'LICENCE']) {
    try { notices.push(await readFile(path.join(root, location, candidate), 'utf8')); found = true; break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!found) throw new Error(`Bundled dependency ${name} is missing its upstream license text.`);
  notices.push('');
}
notices.push('Native source origin: https://github.com/Brooooooklyn/keyring-node at e46be75c3ba8d5fde6b88a17c6153b87ffe4b946 (npm version 1.3.0). The upstream release omitted Cargo.lock; our new committed lock is an independent resolution, not reconstruction of those unpublished binary inputs. The preserved community patch fixes credential error handling and build-path disclosure. Source-built assets have individual compiler/SDK/target/load receipts. Review native/UPSTREAM_NOTICES.txt for original source, locked Cargo dependencies, linked C libraries and Rust runtime attribution.', '');
await writeFile(path.join(root, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
await writeFile(path.join(root, 'docs', 'software-inventory.json'), JSON.stringify({ schema: 1, package: '@community-plugins/autodesk-fusion', version: '0.1.0', lockfile_version: lock.lockfileVersion, inventory_type: 'npm lockfile/bundle membership plus independently built native asset receipts and a conservative Cargo/runtime dependency inventory; not a reconstructed upstream binary SBOM', components: inventory, native: nativeDistribution, native_dependencies: 'native-dependencies.json' }, null, 2) + '\n');
const hashes = {};
async function walk(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(filename);
    else if (entry.isFile() && !entry.name.endsWith('.pyc')) hashes[path.relative(root, filename).split(path.sep).join('/')] = createHash('sha256').update(await readFile(filename)).digest('hex');
  }
}
for (const directory of ['src', 'handlers', 'addin', 'recipes', 'evaluation', 'docs', 'native', 'scripts', 'skills', 'dist']) {
  try { await walk(path.join(root, directory)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
hashes['package-lock.json'] = createHash('sha256').update(await readFile(path.join(root, 'package-lock.json'))).digest('hex');
for (const filename of ['package.json', '.codex-plugin/plugin.json', '.mcp.json', 'mcp/server.mjs', 'README.md', 'SECURITY.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) hashes[filename] = createHash('sha256').update(await readFile(path.join(root, filename))).digest('hex');
await writeFile(path.join(output, 'build-receipt.json'), JSON.stringify({ schema: 1, runtime: 'node>=22.19.0', hash_algorithm: 'sha256', files: hashes }, null, 2) + '\n');
process.stdout.write(`Built ${Object.keys(hashes).length} source/runtime receipts.\n`);
