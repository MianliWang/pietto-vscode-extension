const {spawnSync} = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const python = process.env.PIETTO_TEST_PYTHON || path.join(root, '.local', 'release-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const result = spawnSync(python, ['-I', '-B', path.join(__dirname, '..', 'adapter', 'test_analysis.py')], {stdio: 'inherit', shell: false, windowsHide: true});
if (result.error) { process.stderr.write('Set PIETTO_TEST_PYTHON to a compatible isolated interpreter.\n'); process.exit(1); }
if (result.status !== 0) process.exit(result.status ?? 1);
if (process.platform === 'win32') {
  const rootInWsl = '/mnt/' + root[0].toLowerCase() + root.slice(2).replaceAll('\\', '/');
  const launcher = process.env.PIETTO_TEST_PROJECT_PYTHON || 'wsl.exe';
  const args = JSON.parse(process.env.PIETTO_TEST_PROJECT_PYTHON_ARGUMENTS || JSON.stringify(['-d', 'Ubuntu', '--', rootInWsl + '/.local/release-venv-wsl/bin/python']));
  const project = spawnSync(launcher, [...args, '-I', '-B', rootInWsl + '/adapter/test_analysis.py'], {stdio: 'inherit', shell: false, windowsHide: true});
  process.exit(project.status ?? 1);
}
process.exit(0);
