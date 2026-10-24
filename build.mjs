/**
 * Build script: dsh-feed → deployable DSH plugin.
 *
 * Two artifacts:
 *  - lib/index.js — host loader entry (Node ESM)
 *  - lib/client.js — browser bundle in ModuleLoader.load format (CJS)
 *
 * React stays external on the client side (shell singleton).
 */
import { build, context } from 'esbuild'
import { fileURLToPath } from 'node:url'

const watch = process.argv.includes('--watch')
const nodePaths = [fileURLToPath(new URL('./node_modules', import.meta.url))]

const hostOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  nodePaths,
  outfile: 'lib/index.js',
  // better-sqlite3 是 native addon，不能打进 bundle
  external: ['better-sqlite3'],
  sourcemap: true,
  logLevel: 'info',
}

const clientOptions = {
  entryPoints: ['src/client.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  nodePaths,
  outfile: 'lib/client.js',
  // React 走 shell 单例（ModuleLoader 的 require 解析到 seed 里的 react）
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      '  id: "dsh-feed",',
      '  factory: (require) => {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: ['    return module.exports;', '  }', '});'].join('\n'),
  },
  sourcemap: true,
  logLevel: 'info',
}

if (watch) {
  await (await context(hostOptions)).watch()
  await (await context(clientOptions)).watch()
  console.log('[dsh-feed] watching src/ for changes...')
} else {
  await Promise.all([build(hostOptions), build(clientOptions)])
}
