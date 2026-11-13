// End-to-end check of the plugin's own modules, outside the harness.
// Runs a kernel, installs the process-wide proxy through the harness module,
// then proves the exit changed.
if (!process.env.DSH_INSTALL_DIR) {
  console.error('set DSH_INSTALL_DIR to the dsh installation directory first')
  process.exit(1)
}

const { RUNTIME_YAML, LOG_FILE } = await import('../lib/settings.js')
const { findBinary, readSourceConfig, writeRuntimeConfig, versionOf } = await import('../lib/kernel.js')
const { spawnKernel, waitForController, killKernel, selectedNodes } = await import('../lib/runner.js')
const { installProxy } = await import('../lib/proxy.js')

const log = (m) => console.log('[test]', m)
const binary = findBinary('')
if (!binary) throw new Error('kernel binary not found')
console.log('binary:', binary, versionOf(binary))

const { text } = readSourceConfig('')
writeRuntimeConfig(text, { httpPort: 7892, controllerPort: 9091, outPath: RUNTIME_YAML })

const proc = spawnKernel({ binary, dataDir: RUNTIME_YAML.replace(/\/[^/]+$/, ''), runtimeConfig: RUNTIME_YAML, logFile: LOG_FILE, log })
const ready = await waitForController(9091, 25000)
console.log('controller:', ready)
if (!ready.ok) { await killKernel(proc); process.exit(1) }

const before = await (await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(10000) })).json().catch((e) => ({ error: e.message }))
console.log('direct exit:', before.ip, before.city)

const dispose = await installProxy({ port: 7892, bypass: 'api.deepseek.com', log })
const after = await (await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(15000) })).json().catch((e) => ({ error: e.message }))
console.log('proxied exit:', after.ip, after.city, after.country)

console.log('nodes:', await selectedNodes(9091))
await dispose()
const restored = await (await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(10000) })).json().catch((e) => ({ error: e.message }))
console.log('restored exit:', restored.ip, restored.city)

await killKernel(proc)
console.log('done')
