import { build } from 'esbuild';
await build({ entryPoints: ['src/editor-entry.mjs'], bundle: true, minify: true, format: 'esm', target: 'es2022', outfile: 'public/editor.bundle.js', legalComments: 'eof' });
console.log('Editor bundle built locally.');
