import { defineConfig } from 'vitest/config';

export default defineConfig({
  // На GitHub Pages приложение живёт в подкаталоге /<репозиторий>/.
  base: process.env.BASE_PATH ?? '/',
  server: { port: 5190, strictPort: true },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'] },
});
