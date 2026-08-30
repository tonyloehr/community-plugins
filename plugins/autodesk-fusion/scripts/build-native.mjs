#!/usr/bin/env node
// Developer-only build entry point. The MCP server and package lifecycle never
// import or invoke this file. Install the exact toolchain separately with rustup;
// this script neither installs tools nor changes a global Rust default.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RUST_TOOLCHAIN = '1.98.0';
const UPSTREAM_COMMIT = 'e46be75c3ba8d5fde6b88a17c6153b87ffe4b946';
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceNames = ['Cargo.lock', 'Cargo.toml', 'LICENSE', 'build.rs', 'src/async_entry.rs', 'src/credential_result.rs', 'src/entry.rs', 'src/lib.rs', 'src/linux_credential_builder.rs'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const helperSourceHash = sha256(await readFile(fileURLToPath(import.meta.url)));
const shaPattern = /^[a-f0-9]{64}$/;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const platforms = {
  'darwin-arm64': { target: 'aarch64-apple-darwin', suffix: 'darwin-arm64', library: 'libnapi_keyring.dylib' },
  'darwin-x64': { target: 'x86_64-apple-darwin', suffix: 'darwin-x64', library: 'libnapi_keyring.dylib' },
  'linux-arm64': { target: 'aarch64-unknown-linux-gnu', suffix: 'linux-arm64-gnu', library: 'libnapi_keyring.so' },
  'linux-x64': { target: 'x86_64-unknown-linux-gnu', suffix: 'linux-x64-gnu', library: 'libnapi_keyring.so' },
  'win32-arm64': { target: 'aarch64-pc-windows-msvc', suffix: 'win32-arm64-msvc', library: 'napi_keyring.dll' },
  'win32-x64': { target: 'x86_64-pc-windows-msvc', suffix: 'win32-x64-msvc', library: 'napi_keyring.dll' }
};

export function hostBuild(platform = process.platform, arch = process.arch) {
  const entry = platforms[`${platform}-${arch}`];
  if (!entry) throw new Error('Only the six declared native host OS/architecture combinations are supported.');
  return { ...entry, platform, arch, filename: `keyring.${entry.suffix}.node` };
}
export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    if (!['--output', '--target'].includes(option) || !args[index + 1] || args[index + 1].startsWith('--') || Object.hasOwn(result, option.slice(2))) {
      throw new Error('Use --output <absolute empty directory> and optionally --target <host Rust triple>; no other arguments are accepted.');
    }
    result[option.slice(2)] = args[index + 1];
  }
  if (!result.output || !path.isAbsolute(result.output) || /[\x00-\x1f=]/u.test(result.output) || result.output.startsWith('\\\\') || result.output.startsWith('//') || result.output.split(/[\\/]/u).includes('..')) {
    throw new Error('An explicit absolute local output directory without traversal, control characters or equals signs is required.');
  }
  return result;
}
export function sourceIdentity(records) {
  // Match source-manifest.json: sorted paths and sorted object keys, compact
  // UTF-8 JSON without a trailing newline. This is a source identity, not a
  // claim that different compilers or SDKs produce identical binary bytes.
  return sha256(JSON.stringify([...records].sort((a, b) => compare(a.path, b.path)).map(file => ({ bytes: file.bytes, path: file.path, sha256: file.sha256 }))));
}
export function isWithin(root, candidate, pathApi = path) {
  const relative = pathApi.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${pathApi.sep}`) && relative !== '..' && !pathApi.isAbsolute(relative));
}
async function regularFile(filename, maximum = 1_048_576, allowHardlinks = false) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (!allowHardlinks && metadata.nlink !== 1) || metadata.size < 1 || metadata.size > maximum) throw new Error('A pinned build input/output is not a bounded ordinary file.');
  const bytes = await readFile(filename);
  if (bytes.length !== metadata.size) throw new Error('A build input/output changed while being read.');
  return bytes;
}
async function sourceFileNames(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory() && relative === 'src') result.push(...await sourceFileNames(path.join(directory, entry.name), `${relative}/`));
    else if (entry.isFile()) result.push(relative);
    else throw new Error('The vendored source contains an unexpected directory, link or special file.');
  }
  return result.sort(compare);
}
export async function readPinnedSource(root = pluginRoot) {
  const manifestBytes = await regularFile(path.join(root, 'native', 'source-manifest.json'), 65_536);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.version !== 1 || manifest.upstream?.commit !== UPSTREAM_COMMIT || manifest.upstream?.rustPackage !== 'napi-keyring' || manifest.upstream?.rustPackageVersion !== '0.1.0' || !shaPattern.test(manifest.sourceIdentitySha256) || !Array.isArray(manifest.files) || manifest.files.length !== sourceNames.length) throw new Error('The native source manifest does not describe the pinned community source.');
  const sourceRoot = path.join(root, 'native', 'source');
  if ((await lstat(sourceRoot)).isSymbolicLink() || JSON.stringify(await sourceFileNames(sourceRoot)) !== JSON.stringify(sourceNames)) throw new Error('The source directory must contain exactly the nine pinned files; no Cargo configuration or extra build inputs are accepted.');
  const files = [];
  for (const record of [...manifest.files].sort((a, b) => compare(a.path, b.path))) {
    if (!sourceNames.includes(record.path) || files.some(file => file.path === record.path) || !shaPattern.test(record.sha256) || !Number.isSafeInteger(record.bytes)) throw new Error('Invalid or duplicate source manifest entry.');
    const bytes = await regularFile(path.join(sourceRoot, ...record.path.split('/')));
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new Error(`Pinned source hash mismatch: ${record.path}`);
    files.push({ path: record.path, bytes: bytes.length, sha256: record.sha256, content: bytes });
  }
  if (sourceIdentity(files) !== manifest.sourceIdentitySha256) throw new Error('The source identity does not match its committed manifest.');
  if (manifest.patch?.path !== 'community-credential-errors.patch' || !shaPattern.test(manifest.patch.sha256)) throw new Error('The community patch is not pinned.');
  const patch = await regularFile(path.join(root, 'native', manifest.patch.path));
  if (patch.length !== manifest.patch.bytes || sha256(patch) !== manifest.patch.sha256) throw new Error('The preserved community patch does not match its manifest.');
  return { files, identity: manifest.sourceIdentitySha256, manifestHash: sha256(manifestBytes), patchHash: manifest.patch.sha256 };
}
async function rejectAncestorCargoConfig(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    for (const name of ['config', 'config.toml']) {
      try { await lstat(path.join(current, '.cargo', name)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error('An ancestor Cargo configuration would affect this build. Choose an external output location with no ancestor .cargo/config or .cargo/config.toml.');
    }
    if (path.dirname(current) === current) break;
  }
}

function run(command, args, { cwd, env, timeout = 30_000, accepted = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, limitError;
    const terminate = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.once('error', () => { child.kill(); });
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); } }
    };
    const timer = setTimeout(() => { limitError = new Error('A native build command exceeded its time limit.'); terminate(); }, timeout);
    const collect = field => data => {
      size += data.length;
      if (size > 4_194_304) { if (!limitError) { limitError = new Error('A native build command exceeded its diagnostic output limit.'); terminate(); } return; }
      if (field === 'stdout') stdout += data.toString('utf8'); else stderr += data.toString('utf8');
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.once('error', error => { clearTimeout(timer); reject(new Error(`Required native build executable could not start (${error.code ?? 'unknown'}). Install the pinned toolchain and platform build tools separately.`)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (limitError) reject(limitError);
      else if (!accepted.includes(code)) { const error = new Error(`Native build command ${path.basename(command)} failed with exit code ${code}.`); error.diagnostics = stderr || stdout; reject(error); }
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
export function buildEnvironment(input = process.env) {
  // Do not inherit Cargo configuration, rustc wrappers, Node hooks, compiler
  // flags or registry tokens. Preserve the host's required proxy/certificate
  // routing; do not bypass managed network controls. Those values never enter
  // receipts or CLI arguments. HOME itself is preserved, not repurposed.
  const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'RUSTUP_HOME', 'DEVELOPER_DIR', 'INCLUDE', 'LIB', 'LIBPATH', 'VCTOOLSINSTALLDIR', 'VCTOOLSVERSION', 'VCINSTALLDIR', 'VSINSTALLDIR', 'VISUALSTUDIOVERSION', 'WINDOWSSDKDIR', 'WINDOWSSDKVERSION', 'WINDOWSSDKBINPATH', 'WINDOWSSDKVERBINPATH', 'UNIVERSALCRTSDKDIR', 'UCRTVERSION', 'VSCMD_ARG_TGT_ARCH', 'VSCMD_ARG_HOST_ARCH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CARGO_HTTP_CAINFO', 'CODEX_NETWORK_PROXY_ACTIVE', 'CODEX_NETWORK_PROXY_ATTRIBUTION']);
  return Object.fromEntries(Object.entries(input).filter(([key]) => allowed.has(key.toUpperCase())));
}
export function redactNetwork(value, input = process.env) {
  let result = String(value);
  for (const [key, setting] of Object.entries(input)) {
    if (/^(https?_proxy|all_proxy|no_proxy|ssl_cert_file|ssl_cert_dir|cargo_http_cainfo|codex_network_proxy_attribution)$/iu.test(key) && setting && setting.length > 3) result = result.replaceAll(setting, '<inherited-network-setting>');
  }
  return result.replace(/\b(https?|socks5h?):\/\/[^\s/@]+:[^\s/@]+@/giu, '$1://<redacted>@');
}
function environmentValue(env, name) { return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]; }
function pathVariants(value) { return [...new Set([value, value.replaceAll('\\', '/'), value.replaceAll('/', '\\')])]; }
export function assertNoPrivatePaths(bytes, prefixes, scope = 'Native output/receipt') {
  // Windows filesystem spellings can differ only in drive/directory case. Fold
  // ASCII bytes for both UTF-8 and UTF-16LE searches without altering the output.
  const fold = buffer => Buffer.from(buffer.map(byte => byte >= 65 && byte <= 90 ? byte + 32 : byte));
  const searchable = fold(bytes);
  for (const prefix of prefixes.filter(value => value && value.length > 3)) {
    for (const variant of pathVariants(prefix)) {
      if (searchable.includes(fold(Buffer.from(variant))) || searchable.includes(fold(Buffer.from(variant, 'utf16le')))) throw new Error(`${scope} contains a private source, build, cache, toolchain or home path; output was not admitted.`);
    }
  }
  for (const marker of ['/Users/', '/home/', '/private/tmp/', '/private/var/folders/', '\\Users\\', '\\AppData\\']) {
    if (searchable.includes(fold(Buffer.from(marker))) || searchable.includes(fold(Buffer.from(marker, 'utf16le')))) throw new Error(`${scope} contains a recognizable private filesystem prefix (${marker}); output was not admitted.`);
  }
}
function githubMetadata(env) {
  const value = (name, pattern) => typeof env[name] === 'string' && pattern.test(env[name]) ? env[name] : null;
  return {
    repository: value('GITHUB_REPOSITORY', /^[\w.-]+\/[\w.-]+$/), commit: value('GITHUB_SHA', /^[a-f0-9]{40}$/),
    head_commit: value('FUSION_BUILD_HEAD_SHA', /^[a-f0-9]{40}$/), run_id: value('GITHUB_RUN_ID', /^\d+$/),
    run_attempt: value('GITHUB_RUN_ATTEMPT', /^\d+$/), job: value('GITHUB_JOB', /^[\w.-]{1,128}$/),
    runner_image: value('ImageOS', /^[\w.-]{1,128}$/), runner_image_version: value('ImageVersion', /^[\w.-]{1,128}$/)
  };
}

export async function buildNative(options) {
  const selected = hostBuild();
  if (options.target && options.target !== selected.target) throw new Error('Cross builds are not accepted: the requested target must match the running Node host.');
  if (process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime) throw new Error('The Linux artifacts require a glibc host; musl is outside this build matrix.');
  const root = await realpath(pluginRoot);
  const parent = await realpath(path.dirname(options.output));
  const output = path.join(parent, path.basename(options.output));
  if (isWithin(root, output) || isWithin(output, root)) throw new Error('Output and all build/cache files must be outside, and must not contain, the plugin source tree.');
  try {
    const info = await lstat(output);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(output)).length) throw new Error('The explicit output directory must be an ordinary empty directory.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(output, { mode: 0o700 }); }
  const pinned = await readPinnedSource(root);
  const work = await mkdtemp(path.join(output, '.build-'));
  const source = path.join(work, 'source'), targetDirectory = path.join(work, 'target'), cargoHome = path.join(work, 'cargo-home');
  const binaryPath = path.join(output, selected.filename), receiptPath = path.join(output, `keyring.${selected.suffix}.build.json`);
  let binaryWritten = false, receiptWritten = false;
  let redact = redactNetwork;
  try {
    await mkdir(path.join(source, 'src'), { recursive: true });
    for (const file of pinned.files) await writeFile(path.join(source, ...file.path.split('/')), file.content, { flag: 'wx' });
    for (const directory of [targetDirectory, cargoHome, path.join(work, 'tmp')]) await mkdir(directory, { mode: 0o700 });
    await rejectAncestorCargoConfig(source);
    const env = buildEnvironment();
    env.CARGO_HOME = cargoHome; env.CARGO_TARGET_DIR = targetDirectory; env.CARGO_INCREMENTAL = '0';
    env.CARGO_TERM_COLOR = 'never'; env.RUSTUP_AUTO_INSTALL = '0';
    env.TMPDIR = path.join(work, 'tmp'); env.TMP = env.TMPDIR; env.TEMP = env.TMPDIR;
    const probe = { cwd: source, env };
    const rustc = (await run('rustc', [`+${RUST_TOOLCHAIN}`, '-vV'], probe)).stdout;
    const cargo = (await run('cargo', [`+${RUST_TOOLCHAIN}`, '-vV'], probe)).stdout;
    if (!rustc.split(/\r?\n/u).includes(`release: ${RUST_TOOLCHAIN}`) || !cargo.startsWith(`cargo ${RUST_TOOLCHAIN} `) || !rustc.split(/\r?\n/u).includes(`host: ${selected.target}`)) throw new Error('The installed Rust/Cargo version or host does not match the exact pinned toolchain and target.');
    const sysroot = await realpath((await run('rustc', [`+${RUST_TOOLCHAIN}`, '--print', 'sysroot'], probe)).stdout);
    const rustcPath = (await run('rustup', ['which', '--toolchain', RUST_TOOLCHAIN, 'rustc'], probe)).stdout;
    const cargoPath = (await run('rustup', ['which', '--toolchain', RUST_TOOLCHAIN, 'cargo'], probe)).stdout;
    const home = os.homedir();
    const mappings = [
      [home, '/fusion-home'], [path.resolve(root, '..', '..'), '/fusion-repository'], [root, '/fusion-plugin'],
      [os.tmpdir(), '/fusion-temporary'], [path.dirname(sysroot), '/fusion-rust-toolchains'],
      [environmentValue(process.env, 'RUSTUP_HOME') || path.join(home, '.rustup'), '/fusion-rustup'],
      [environmentValue(process.env, 'CARGO_HOME') || path.join(home, '.cargo'), '/fusion-original-cargo'],
      [sysroot, '/fusion-rust-toolchain'], [output, '/fusion-output'], [work, '/fusion-build'],
      [source, '/fusion-source'], [cargoHome, '/fusion-cargo']
    ].filter(([from]) => from && from.length > 3).sort((a, b) => a[0].length - b[0].length);
    for (const [from] of mappings) if (/[\x00-\x1f=]/u.test(from)) throw new Error('A build path cannot be represented safely in compiler remapping flags.');
    // Public temporary-root literals (for example a DBus runtime socket under
    // /tmp) are not private build paths. Scan the specific output/work/cache
    // prefixes instead; keep the broad compiler remapping independently.
    const publicTemporaryRoots = new Set(['/tmp', '/var/tmp', '/private/tmp']);
    const prefixes = [...new Set(mappings.filter(([from]) => !publicTemporaryRoots.has(from.replaceAll('\\', '/').replace(/\/$/u, ''))).flatMap(([from]) => pathVariants(from)))];
    redact = value => {
      let result = redactNetwork(value);
      for (const [from, to] of [...mappings].reverse()) for (const variant of pathVariants(from)) result = result.replaceAll(variant, to);
      return result;
    };
    const remapFlags = mappings.map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
    env.CARGO_ENCODED_RUSTFLAGS = ['-Cdebuginfo=0', ...remapFlags].join('\x1f');
    let sdkVersion = null, compiler = null;
    if (process.platform === 'darwin') {
      sdkVersion = (await run('xcrun', ['--sdk', 'macosx', '--show-sdk-version'], probe)).stdout;
      env.SDKROOT = (await run('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], probe)).stdout;
      env.MACOSX_DEPLOYMENT_TARGET = '11.0';
      // Rust 1.98's bundled strip tool on Apple hosts needs its own LLVM dylib.
      // This environment is used by build subprocesses only, never module load.
      env.DYLD_LIBRARY_PATH = path.join(sysroot, 'lib');
    } else if (process.platform === 'win32') {
      sdkVersion = environmentValue(env, 'WindowsSDKVersion')?.replace(/[\\/]+$/u, '') ?? null;
      const msvc = environmentValue(env, 'VCToolsVersion');
      if (!sdkVersion || !msvc) throw new Error('Run this Windows build in a Visual Studio Developer PowerShell with a selected Windows SDK and MSVC toolset.');
      compiler = `MSVC ${msvc}; host ${environmentValue(env, 'VSCMD_ARG_HOST_ARCH') ?? 'unknown'}; target ${environmentValue(env, 'VSCMD_ARG_TGT_ARCH') ?? 'unknown'}`;
    } else sdkVersion = `glibc ${process.report.getReport().header.glibcVersionRuntime}`;
    if (process.platform !== 'win32') {
      compiler = (await run('cc', ['--version'], probe)).stdout.split(/\r?\n/u)[0];
      // cc 1.4.4 supports shell-escaped *FLAGS. Keep each path-containing flag
      // intact when a developer's explicit output directory contains spaces.
      // https://docs.rs/cc/1.4.4/cc/#external-configuration-via-environment-variables
      env.CC_SHELL_ESCAPED_FLAGS = '1';
      const flags = mappings.map(([from, to]) => `-ffile-prefix-map=${from}=${to}`);
      env.CFLAGS = flags.map(flag => `'${flag.replaceAll("'", "'\\''")}'`).join(' '); env.CXXFLAGS = env.CFLAGS;
    }
    process.stdout.write(`Building pinned community keyring for ${selected.target}; no credentials are requested.\n`);
    const args = [`+${RUST_TOOLCHAIN}`, 'build', '--locked', '--release', '--manifest-path', path.join(source, 'Cargo.toml'), '--target', selected.target, '--target-dir', targetDirectory];
    const build = await run('cargo', args, { ...probe, timeout: 18 * 60_000 });
    const warnings = (build.stderr + '\n' + build.stdout).split(/\r?\n/u).filter(line => /warning(?:\[[^\]\r\n]+\])?:/iu.test(line));
    const networkRetries = warnings.filter(line => /warning: spurious network error/iu.test(line));
    if (warnings.length !== networkRetries.length) {
      const error = new Error('The native build emitted a warning; review it before admitting an artifact.');
      error.diagnostics = [build.stderr, build.stdout].filter(Boolean).join('\n');
      throw error;
    }
    for (const file of pinned.files) if (sha256(await regularFile(path.join(source, ...file.path.split('/')))) !== file.sha256) throw new Error('Cargo changed a pinned source or lockfile during the build.');
    // Cargo can hard-link its top-level artifact to its own deps/ output. Read
    // that private build result, then create a separate ordinary output file.
    const binary = await regularFile(path.join(targetDirectory, selected.target, 'release', selected.library), 67_108_864, true);
    assertNoPrivatePaths(binary, prefixes, 'Built native binary');
    await writeFile(binaryPath, binary, { flag: 'wx', mode: 0o644 }); binaryWritten = true;
    const smokeCode = `const m=require(process.argv[1]); for(const n of ['Entry','AsyncEntry']){if(typeof m[n]!=='function')throw Error('Missing native export');for(const p of ['getPassword','setPassword','getSecret','setSecret','deleteCredential'])if(typeof m[n].prototype[p]!=='function')throw Error('Missing native method');} process.stdout.write('native-module-load-ok');`;
    // Loading and checking export shapes must not construct a credential entry
    // or invoke any vault operation. Real vault tests are a separate gate.
    const smoke = await run(process.execPath, ['--no-warnings', '-e', smokeCode, binaryPath], { cwd: output, env: buildEnvironment(), timeout: 30_000 });
    if (smoke.stdout !== 'native-module-load-ok') throw new Error('The built native module did not pass its credential-free load check.');
    const receipt = {
      schema: 1, kind: 'community-source-native-build', platform: selected.platform, arch: selected.arch, target: selected.target,
      build_helper_sha256: helperSourceHash,
      upstream_commit: UPSTREAM_COMMIT, source_tree_sha256: pinned.identity, source_manifest_sha256: pinned.manifestHash,
      source_files: Object.fromEntries(pinned.files.map(file => [file.path, file.sha256])), community_patch_sha256: pinned.patchHash,
      cargo_lock_sha256: pinned.files.find(file => file.path === 'Cargo.lock').sha256,
      rust_toolchain: { version: RUST_TOOLCHAIN, rustc_verbose: redact(rustc), cargo_verbose: redact(cargo), compiler_sha256: sha256(await regularFile(rustcPath, 268_435_456, true)), cargo_sha256: sha256(await regularFile(cargoPath, 268_435_456, true)) },
      build_command_args: args.map(redact),
      build_warnings: { compiler: 0, recovered_network_retries: networkRetries.length },
      environment: { os_release: os.release(), os_version: redact(os.version()), architecture: os.arch(), sdk_version: redact(sdkVersion), deployment_target: process.platform === 'darwin' ? '11.0' : null, compiler: redact(compiler), cargo_incremental: '0', rustflags: ['-Cdebuginfo=0', ...mappings.map(([, to]) => `--remap-path-prefix=<${to.slice(1)}>=${to}`)], c_file_prefix_map: process.platform !== 'win32', macos_build_llvm_library: process.platform === 'darwin' ? '/fusion-rust-toolchain/lib' : null },
      ci: githubMetadata(process.env), output: { filename: selected.filename, sha256: sha256(binary), size_bytes: binary.length },
      smoke_test: { kind: 'module-load-export-shape', passed: true, credential_accessed: false, node_version: process.version, napi_version: process.versions.napi },
      path_remapping: { enabled: true, labels: [...new Set(mappings.map(([, to]) => to))], private_prefix_scan: 'ASCII-folded UTF-8 and UTF-16LE scan of private source, build, cache, toolchain and home prefixes; passed' },
      reproducibility: 'Source, lockfile and Rust toolchain are pinned. OS, linker and SDK differences can produce different binaries; this receipt does not claim cross-host byte reproducibility or vault qualification.'
    };
    const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
    assertNoPrivatePaths(receiptBytes, prefixes, 'Build receipt');
    await writeFile(receiptPath, receiptBytes, { flag: 'wx', mode: 0o644 }); receiptWritten = true;
    process.stdout.write(`Produced ${selected.filename} and ${path.basename(receiptPath)}; SHA256 ${receipt.output.sha256}.\n`);
    return receipt;
  } catch (error) {
    if (binaryWritten && !receiptWritten) await rm(binaryPath, { force: true });
    const safe = new Error(redact(error.message));
    if (error.diagnostics) safe.diagnostics = redact(error.diagnostics);
    throw safe;
  } finally { await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) process.stdout.write(`Developer-only native source build.\nUsage: node scripts/build-native.mjs --output <absolute empty directory outside plugin> [--target <host triple>]\nInstall Rust ${RUST_TOOLCHAIN} and the host target separately; on Windows use Developer PowerShell. No startup build, cross compilation, credentials, automatic package admission or publication.\n`);
    else await buildNative(options);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    if (error.diagnostics) process.stderr.write(`${error.diagnostics}\n`);
    process.exitCode = 1;
  }
}
