import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Application 100 % locale : aucun serveur, les plans ne quittent jamais le poste.
// `base: './'` permet d'ouvrir le build depuis n'importe quel dossier ou hébergement statique.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { target: 'es2022', sourcemap: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
