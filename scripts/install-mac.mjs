// Сборка приложения на этом Mac и установка в «Программы» — так обновляется vibe_cutter.
// Приложение, собранное на этом же компьютере, macOS открывает без предупреждений Gatekeeper.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, cpSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const appName = 'vibe_cutter.app';
const target = path.join('/Applications', appName);
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const run = (cmd, args, env = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });

console.log(`\n▶ Сборка vibe_cutter ${version} (${arch})`);
run('npx', ['tsc', '--noEmit']);
run('npx', ['vitest', 'run', '--silent']);
run('npx', ['vite', 'build']);
run('npx', ['electron-builder', '--mac', 'dir', `--${arch}`, '--publish', 'never']);

const built = path.join(root, 'release', arch === 'arm64' ? 'mac-arm64' : 'mac', appName);
if (!existsSync(built)) throw new Error(`Не найдено собранное приложение: ${built}`);

console.log('\n▶ Самопроверка собранного приложения');
const exe = path.join(built, 'Contents', 'MacOS', 'vibe_cutter');
const test = spawnSync(exe, [], { env: { ...process.env, VIBE_SELFTEST: '1' }, encoding: 'utf8', timeout: 90_000 });
const line = (test.stdout ?? '').split('\n').find((l) => l.startsWith('VIBE_SELFTEST '));
const result = line ? JSON.parse(line.slice('VIBE_SELFTEST '.length)) : null;
if (!result?.ok) {
  console.error('Самопроверка не прошла — приложение НЕ установлено.\n', result ?? test.stderr);
  process.exit(1);
}
console.log('  ✓ WebCodecs, воркер рендера, запись файлов, мост приложения');

console.log('\n▶ Установка в «Программы»');
// Закрываем запущенную версию, чтобы заменить её.
spawnSync('osascript', ['-e', 'tell application "vibe_cutter" to quit'], { stdio: 'ignore' });
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
cpSync(built, target, { recursive: true, verbatimSymlinks: true });
// Регистрируем в macOS, чтобы двойной щелчок по .vcut открывал vibe_cutter.
spawnSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', target], { stdio: 'ignore' });
console.log(`\n✓ vibe_cutter ${version} установлен: ${target}`);
console.log('  Проекты, автосохранение и недавние файлы сохраняются между версиями.\n');
