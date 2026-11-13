import { harnessRoot, importHarnessPackage } from './harness.js'

/**
 * Import the harness's own `@deepseek-ai/dsh-http-proxy` module instance.
 *
 * An absolute path resolves to the same module instance the launcher loaded,
 * which is what makes the installed dispatcher affect this process.
 */
async function loadHttpProxy() {
  return await importHarnessPackage(harnessRoot(), 'dsh-http-proxy')
}

/** Build the environment map `installProxyFromEnvironment` reads. */
function proxyEnv(port, bypass) {
  const proxy = `http://127.0.0.1:${port}`
  const noProxy = ['localhost', '127.0.0.1', '::1', '[::1]']
  for (const entry of String(bypass ?? '').split(/[,\s]+/)) {
    const trimmed = entry.trim()
    if (trimmed !== '' && !noProxy.includes(trimmed)) noProxy.push(trimmed)
  }
  return new Map([
    ['http_proxy', { value: proxy }],
    ['https_proxy', { value: proxy }],
    ['no_proxy', { value: noProxy.join(',') }],
  ])
}

/**
 * Route every `fetch()` in this process through the local kernel.
 * Returns a disposer restoring the previous dispatcher and environment.
 */
export async function installProxy({ port, bypass, log = () => {} }) {
  const mod = await loadHttpProxy()
  const report = (message) => log(`[proxy] ${message}`)
  return await mod.installProxyFromEnvironment(proxyEnv(port, bypass), report)
}
