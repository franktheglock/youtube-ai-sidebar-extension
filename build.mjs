import { build } from 'esbuild';
import { rm, mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const generatedFiles = ['background.js', 'content.js', 'options.js', 'offscreen.js'];

await Promise.all(generatedFiles.map((fileName) => rm(path.join(rootDir, fileName), { force: true })));

await build({
  entryPoints: {
    background: path.join(rootDir, 'src', 'background.js'),
    content: path.join(rootDir, 'src', 'content.js'),
    options: path.join(rootDir, 'src', 'options.js'),
    offscreen: path.join(rootDir, 'src', 'offscreen.js')
  },
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  outdir: rootDir,
  sourcemap: false,
  minify: false,
  logLevel: 'info'
});

// Copy ONNX Runtime WASM/MJS files so they load locally (extension CSP blocks CDN)
const ortSrc = path.join(rootDir, 'node_modules', 'onnxruntime-web', 'dist');
const ortDst = path.join(rootDir, 'ort');
await mkdir(ortDst, { recursive: true });

const ortFiles = (await readdir(ortSrc)).filter(
  (f) => f.startsWith('ort-wasm') && (f.endsWith('.wasm') || f.endsWith('.mjs'))
);

for (const file of ortFiles) {
  await copyFile(path.join(ortSrc, file), path.join(ortDst, file));
}

console.log(`Copied ${ortFiles.length} ONNX Runtime files to ort/`);
console.log(`Built extension in ${rootDir}`);