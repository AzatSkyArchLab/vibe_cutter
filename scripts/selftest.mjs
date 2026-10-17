// Самопроверка собранного приложения (настоящий рендер в воркере, запись файлов, мост).
// Использование: node scripts/selftest.mjs <путь к исполняемому файлу приложения>
import { spawnSync } from 'node:child_process';

const exe = process.argv[2];
if (!exe) throw new Error('Укажите путь к приложению');
const r = spawnSync(exe, [], { env: { ...process.env, VIBE_SELFTEST: '1' }, encoding: 'utf8', timeout: 120_000 });
const line = (r.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('VIBE_SELFTEST '));
const result = line ? JSON.parse(line.slice('VIBE_SELFTEST '.length)) : null;
console.log(JSON.stringify(result ?? { stdout: r.stdout, stderr: r.stderr, error: String(r.error ?? '') }, null, 2));
process.exit(result?.ok ? 0 : 1);
