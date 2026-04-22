import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const generatedFiles = ['background.js', 'content.js', 'options.js'];

await Promise.all(generatedFiles.map((fileName) => rm(path.join(rootDir, fileName), { force: true })));

await build({
  entryPoints: {
    background: path.join(rootDir, 'src', 'background.js'),
    content: path.join(rootDir, 'src', 'content.js'),
    options: path.join(rootDir, 'src', 'options.js')
  },
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  outdir: rootDir,
  sourcemap: false,
  minify: false,
  logLevel: 'info'
});

console.log(`Built extension in ${rootDir}`);