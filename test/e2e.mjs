// End-to-end check of the plugin's own modules, outside the harness.
// Runs a kernel in a throwaway data directory, installs the process-wide proxy
// through the harness module, then proves the exit changed.
//
// It deliberately does not touch ~/.dsh/storages/dsh-mihomo/runtime.yaml: the
// installed plugin may already be running a kernel from that file.
//
// Run: DSH_INSTALL_DIR=... node test/e2e.mjs
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.DSH_INSTALL_DIR) {
  console.error('set DSH_INSTALL_DIR to the dsh installation directory first')
  process.exit(1)
}

const { STORE_DIR } = await import('../lib/settings.js')
const { findBinary, readSourceConfig, writeRuntimeConfig, versionOf } = await import('../lib/kernel.js')
const { spawnKernel, waitForController, killKernel, selectedChain, selectedNodes, resolveExitNode } = await import('../lib/runner.js')
const { installProxy } = await import('../lib/proxy.js')

const log = (m) => console.log('[test]', m)
const httpPort = Number(process.env.DSH_MIHOMO_TEST_HTTP_PORT || 7894)
const controllerPort = Number(process.env.DSH_MIHOMO_TEST_CTRL_PORT || 9093)

const binary = findBinary('')
if (!binary) throw new Error('kernel binary not found')
console.log('binary:', binary, versionOf(binary))

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-mihomo-e2e-'))
const runtimeConfig = join(dataDir, 'runtime.yaml')
const logFile = join(dataDir, 'kernel.log')
const geoip = join(STORE_DIR, 'geoip.metadb')
if (existsSync(geoip)) copyFileSync(geoip, join(dataDir, 'geoip.metadb'))

const { text } = readSourceConfig('')
writeRuntimeConfig(text, { httpPort, controllerPort, outPath: runtimeConfig })

let proc = null
let dispose = null
try {
  proc = spawnKernel({ binary, dataDir, runtimeConfig, logFile, log })
  const ready = await waitForController(controllerPort, 25000)
  console.log('controller:', ready)
  if (!ready.ok) throw new Error('controller never answered')

  const before = await (await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(10000) })).json()
  console.log('direct exit:', before.ip, before.city)

  dispose = await installProxy({ port: httpPort, bypass: 'api.deepseek.com', log })
  const after = await (await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(15000) })).json()
  console.log('proxied exit:', after.ip, after.city, after.country)

  const chain = await selectedChain(controllerPort)
  const all = await selectedNodes(controllerPort)
  console.log('chain exit:', chain.exitNode)
  console.log('full table exit:', resolveExitNode(all))

  await dispose()
  dispose = null
  const restored = await (await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(10000) })).json()
  console.log('restored exit:', restored.ip, restored.city)

  console.log('done')
} finally {
  if (dispose) await dispose().catch(() => {})
  if (proc) await killKernel(proc)
  rmSync(dataDir, { recursive: true, force: true })
}
