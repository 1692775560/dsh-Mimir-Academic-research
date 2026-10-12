import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

// Node-half bundle from the tsc-emitted lib/types JavaScript, plus the
// Typert face artifacts (typert.host.js / typert.remote-client.js) emitted at
// the package output root. Workspace mode generates only packages whose
// manifest exposes a Typert entry (dsh-mimir alone); the default package mode
// would analyze the vendored protocol package too, which fails on merged
// interfaces partly owned by npm releases.
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  plugins: [typertPlugin({ mode: 'workspace', faces: ['host'] })],
})
