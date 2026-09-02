import { defineConfig } from 'tsdown'

export default defineConfig({
  cwd: process.cwd(),
  entry: { client: 'src/client.js' },
  outDir: '.client-build',
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  sourcemap: false,
  clean: true,
  treeshake: true,
  banner: [
    'window.__ModuleLoader__.load({',
    '  id: "dsh-task-orchestrator",',
    '  factory: (require) => {',
    '    const module = { exports: {} }',
    '    const exports = module.exports',
  ].join('\n'),
  footer: [
    '    return module.exports',
    '  },',
    '})',
  ].join('\n'),
})
