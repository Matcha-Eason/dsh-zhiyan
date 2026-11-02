import { spawn } from 'node:child_process'
import { access, lstat, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from 'node:process'
import { MAIN_MODEL } from '../lib/protocol.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envFile = resolve(process.env.DSH_ENV_FILE ?? join(root, '.env.local'))
const hasEnvFile = await access(envFile).then(() => true, () => false)
if (hasEnvFile) loadEnvFile(envFile)
const sourceRoot = resolve(process.env.DSH_SOURCE_ROOT ?? join(root, '../deepseek-harness'))
const bin = join(sourceRoot, 'apps/cli/lib/bin.js')
for (const file of [bin, join(root, 'lib/index.js'), join(root, 'lib/client.js')]) {
  await access(file).catch(() => { throw new Error(`Missing ${file}; build the checkout first.`) })
}

// This profile belongs only to this checkout. The installed DSH profile and
// OS home are never involved; DSH_HOME is the native Harness data-root option.
const dshHome = join(root, '.local/dsh')
const profile = join(dshHome, 'profiles/keyboard-dev')
const modules = join(profile, 'node_modules')
await mkdir(modules, { recursive: true })
const pluginLink = join(modules, 'dsh-keyboard-duplex')
const existing = await lstat(pluginLink).catch(error => {
  if (error.code !== 'ENOENT') throw error
})
if (existing === undefined) {
  await symlink(root, pluginLink, 'dir')
} else if (!existing.isSymbolicLink() || await realpath(pluginLink) !== await realpath(root)) {
  throw new Error(`The development profile already has a different plugin at ${pluginLink}`)
}
// Initialize once, so subsequent launches preserve edits made in DSH's UI.
await writeFile(join(profile, 'package.json'), JSON.stringify({
  private: true,
  dependencies: { 'dsh-keyboard-duplex': `file:${root}` },
  dsh: { profile: { bundles: [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-keyboard-duplex',
  ] } },
}, null, 2) + '\n', { flag: 'wx' }).catch(error => {
  if (error.code !== 'EEXIST') throw error
})
const patch = join(dshHome, 'keyboard-dev.patch.json')
await writeFile(patch, JSON.stringify([
  { id: 'hmr', disabled: true },
  { id: 'ui-settings-models', config: { credentialOnboarding: false } },
  { id: 'agent-default-model', config: MAIN_MODEL },
], null, 2) + '\n')

const child = spawn(process.execPath, [
  bin, '--profile', 'keyboard-dev', '--patch', patch,
  ...process.argv.slice(2),
  ...(process.env.DSH_KEYBOARD_OPEN === '1' ? [] : ['--no-open']),
  '--port', process.env.DSH_KEYBOARD_PORT ?? '3082',
], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: join(root, '.local/agents'),
    DSH_TELEMETRY_DISABLED: '1',
  },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
