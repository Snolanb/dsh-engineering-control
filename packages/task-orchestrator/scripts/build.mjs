import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

rmSync('lib', { recursive: true, force: true })
rmSync('.client-build', { recursive: true, force: true })
mkdirSync('lib', { recursive: true })
cpSync('src', 'lib', { recursive: true })

execFileSync('pnpm', ['exec', 'tsdown', '--config', 'scripts/tsdown.client.config.mjs', '--no-report'], { stdio: 'inherit' })
if (!existsSync('.client-build/client.cjs')) throw new Error('tsdown did not produce .client-build/client.cjs')
cpSync('.client-build/client.cjs', 'lib/client.js')
rmSync('.client-build', { recursive: true, force: true })

for (const file of ['lib/index.js', 'lib/store.js', 'lib/routes.js', 'lib/tools.js', 'lib/client-api.js', 'lib/dispatcher.js', 'lib/worker-specs.js', 'lib/worker-preflight.js', 'lib/client.js']) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
}
const client = readFileSync('lib/client.js', 'utf8')
if (!client.startsWith('window.__ModuleLoader__.load({')) throw new Error('client bundle is missing the DSH ModuleLoader registration')
if (!client.includes('id: "dsh-task-orchestrator"')) throw new Error('client bundle has the wrong DSH module id')
if (!client.includes('factory: (require) =>')) throw new Error('client bundle is missing the DSH module factory')
if (!client.includes('return module.exports')) throw new Error('client bundle is missing the CommonJS factory return')
if (/^\s*(?:import|export)\b/m.test(client)) throw new Error('client bundle still contains top-level ESM syntax')
if (/\brequire\s*\(/.test(client)) throw new Error('client bundle contains an unresolved require call')
if (!client.trimEnd().endsWith('})')) throw new Error('client bundle has an invalid DSH ModuleLoader footer')
if (!existsSync('lib/index.js')) throw new Error('build did not produce lib/index.js')
console.log('built lib/ host modules and DSH ModuleLoader client bundle')
