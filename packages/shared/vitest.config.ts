import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  test: { environment: 'node', globals: true },
});
