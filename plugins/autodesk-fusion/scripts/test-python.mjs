import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.FUSION_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests/python', '-p', 'test_*.py'], { cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
if (result.error) { process.stderr.write('Python contract runner could not start. Set FUSION_TEST_PYTHON to a supported interpreter.\n'); process.exitCode = 1; }
else process.exitCode = result.status ?? 1;
