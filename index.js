import { dirname } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { DEFAULTS, LOG_FILE, RUNTIME_YAML, SOURCE_YAML } from './lib/settings.js'
import {
  findBinary, versionOf, downloadBinary, readSourceConfig, writeRuntimeConfig,
} from './lib/kernel.js'
import { spawnKernel, waitForController, killKernel, selectedNodes, resolveExitNode } from './lib/runner.js'
import { installProxy } from './lib/proxy.js'
import { harnessRoot, importHarnessPackage } from './lib/harness.js'
import { applyAutoPolicy, DEFAULT_JAPAN_DOMAINS } from './lib/policy.js'

export const name = 'dsh-mihomo'

/** Load the harness's own tool-definition helper (same module instance as the host). */
async function loadDefineTool() {
  const mod = await importHarnessPackage(harnessRoot(), 'dsh-tools')
  return mod.defineTool
}

/** Write a JSON response; the panel polls this shape. */
function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** Loopback-only guard: the panel is a local control surface. */
function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === ''
}

/**
 * Host half of dsh-mihomo: own one kernel child process and one proxy install.
 *
 * The row's `config` is read as plain data; every start/stop is serialized
 * through `busy` so a double click cannot spawn two kernels.
 */
export async function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const state = {
    status: 'stopped',
    since: null,
    error: '',
    version: '',
    pid: null,
    port: cfg.httpPort,
    exitIp: '',
    exitNode: '',
    nodes: {},
    subscription: { configured: Boolean(cfg.subscriptionUrl), lastAt: null, error: '', bytes: 0 },
  }
  let proc = null
  let disposeProxy = null
  let busy = false

  const log = (message) => {
    try { ctx.logger?.info?.(`[dsh-mihomo] ${message}`) } catch { /* never throw from logging */ }
  }

  function snapshot() {
    return {
      status: state.status,
      since: state.since,
      error: state.error,
      version: state.version,
      pid: state.pid,
      port: state.port,
      exitIp: state.exitIp,
      exitNode: state.exitNode,
      nodes: state.nodes,
      subscription: { ...state.subscription },
      logFile: LOG_FILE,
    }
  }

  async function start() {
    if (state.status === 'running' || state.status === 'starting') return snapshot()
    state.status = 'starting'
    state.error = ''
    try {
      let binary = findBinary(cfg.binaryPath)
      if (binary === '') {
        log('kernel binary missing, downloading')
        binary = await downloadBinary(log)
      }
      state.version = versionOf(binary)
      const { text } = readSourceConfig(cfg.sourceConfig)
      writeRuntimeConfig(text, {
        httpPort: cfg.httpPort,
        controllerPort: cfg.controllerPort,
        outPath: RUNTIME_YAML,
        transform: (draft) => applyAutoPolicy(draft, {
          autoNode: cfg.autoNode !== false,
          testUrl: cfg.testUrl,
          interval: cfg.testInterval,
          tolerance: cfg.testTolerance,
          japanDomains: String(cfg.japanDomains ?? '').trim() === ''
            ? DEFAULT_JAPAN_DOMAINS
            : String(cfg.japanDomains).split(/[,\s]+/).filter(Boolean),
        }),
      })
      proc = spawnKernel({
        binary,
        dataDir: dirname(RUNTIME_YAML),
        runtimeConfig: RUNTIME_YAML,
        logFile: LOG_FILE,
        log,
      })
      state.pid = proc.pid ?? null
      const ready = await waitForController(cfg.controllerPort, cfg.startTimeoutMs)
      if (!ready.ok) throw new Error(`kernel controller never answered (${ready.error})`)
      disposeProxy = await installProxy({ port: cfg.httpPort, bypass: cfg.bypass, log })
      state.status = 'running'
      state.since = new Date().toISOString()
      state.nodes = await selectedNodes(cfg.controllerPort)
      state.exitNode = resolveExitNode(state.nodes)
      log(`running on 127.0.0.1:${cfg.httpPort} (kernel ${state.version})`)
      void probeExitIp(cfg.httpPort)
    } catch (err) {
      state.status = 'error'
      state.error = String(err?.message ?? err)
      log(`start failed: ${state.error}`)
      await stopQuiet()
    }
    return snapshot()
  }

  async function stopQuiet() {
    try { if (disposeProxy) await disposeProxy() } catch { /* already disposed */ }
    disposeProxy = null
    if (proc) await killKernel(proc)
    proc = null
    state.pid = null
    state.nodes = {}
    state.exitNode = ''
  }

  async function stop() {
    if (state.status === 'stopped') return snapshot()
    await stopQuiet()
    state.status = 'stopped'
    state.since = null
    log('stopped')
    return snapshot()
  }

  /** Record the public exit address so the panel can show where traffic leaves. */
  async function probeExitIp(port) {
    try {
      const res = await fetch('https://ipinfo.io/json', {
        signal: AbortSignal.timeout(8000),
        headers: { 'user-agent': 'dsh-mihomo' },
      })
      if (!res.ok) return
      const body = await res.json()
      state.exitIp = [body.ip, body.city, body.country].filter(Boolean).join(' · ')
    } catch { /* exit probe is decorative */ }
  }

  /** Pull the subscription and replace the stored Clash config. */
  async function refreshSubscription() {
    if (!cfg.subscriptionUrl) throw new Error('no subscription URL configured')
    const res = await fetch(cfg.subscriptionUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
      headers: { 'user-agent': 'dsh-mihomo' },
    })
    if (!res.ok) throw new Error(`subscription HTTP ${res.status}`)
    const text = await res.text()
    if (!/^\s*(port|mixed-port|proxies|proxy-groups|rules):/m.test(text)) {
      throw new Error('subscription did not return a Clash YAML')
    }
    writeFileSync(SOURCE_YAML, text)
    state.subscription.lastAt = new Date().toISOString()
    state.subscription.bytes = Buffer.byteLength(text)
    state.subscription.error = ''
    return state.subscription
  }

  async function updateAndRestart() {
    await refreshSubscription()
    if (state.status === 'running') {
      await stopQuiet()
      state.status = 'stopped'
      return await start()
    }
    return snapshot()
  }

  async function withBusy(fn) {
    if (busy) return { ok: false, error: 'another start/stop is in progress', state: snapshot() }
    busy = true
    try { return { ok: true, state: await fn() } }
    finally { busy = false }
  }

  ctx.effect(() => {
    if (cfg.enabled && cfg.autoStart) {
      void withBusy(async () => {
        if (cfg.subscriptionUrl && !existsSync(SOURCE_YAML)) {
          try { await refreshSubscription() } catch (err) { log(`subscription fetch failed: ${err?.message ?? err}`) }
        }
        return await start()
      })
    }
    return async () => { await withBusy(stop) }
  })

  // Periodic subscription refresh; skipped when no URL is configured or hours is 0.
  if (cfg.subscriptionUrl && Number(cfg.subscriptionHours) > 0) {
    const timer = setInterval(() => {
      void withBusy(async () => {
        try { await updateAndRestart() } catch (err) {
          state.subscription.error = String(err?.message ?? err)
          log(`subscription refresh failed: ${state.subscription.error}`)
        }
        return snapshot()
      })
    }, Number(cfg.subscriptionHours) * 3600 * 1000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer))
  }

  // Local control surface for the composer chip.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/dsh-mihomo/state',
      handler: async (req, res) => {
        if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
        if (state.status === 'running') {
          try {
            state.nodes = await selectedNodes(cfg.controllerPort)
            state.exitNode = resolveExitNode(state.nodes)
          } catch { /* keep the last known selection */ }
        }
        sendJson(res, 200, { ok: true, state: snapshot() })
      },
    }), 'dsh-mihomo: state')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/dsh-mihomo/action',
      handler: async (req, res) => {
        if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
        if ((req.method ?? 'GET') !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        let action = ''
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          action = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')?.action ?? ''
        } catch {
          return sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
        }
        try {
          if (action === 'start') return sendJson(res, 200, await withBusy(start))
          if (action === 'stop') return sendJson(res, 200, await withBusy(stop))
          if (action === 'restart') return sendJson(res, 200, await withBusy(async () => { await stopQuiet(); return await start() }))
          if (action === 'update-subscription') {
            return sendJson(res, 200, await withBusy(async () => {
              try { await updateAndRestart() } catch (err) {
                state.subscription.error = String(err?.message ?? err)
              }
              return snapshot()
            }))
          }
          return sendJson(res, 400, { ok: false, error: `unknown action: ${action}` })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
        }
      },
    }), 'dsh-mihomo: action')
  })

  // Tools: let the agent inspect and toggle the tunnel without leaving the chat.
  const defineTool = await loadDefineTool()
  ctx.inject(['tools'], (scope) => {
    scope.tools.register(defineTool({
      name: 'mihomo_status',
      description: 'Check whether the built-in mihomo proxy kernel is running, which port it listens on, and which policy group nodes are selected.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async () => ({ state: snapshot() }),
    }))
    scope.tools.register(defineTool({
      name: 'mihomo_control',
      description: 'Start, stop, or restart the built-in mihomo proxy kernel, or pull the configured subscription again. While it runs, all DSH outbound requests go through it except the configured bypass list.',
      parameters: {
        action: { type: 'string', required: true, enum: ['start', 'stop', 'restart', 'update-subscription'], description: 'start | stop | restart | update-subscription' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async (args) => {
        const action = args?.action
        try {
          if (action === 'start') return await withBusy(start)
          if (action === 'stop') return await withBusy(stop)
          if (action === 'restart') {
            return await withBusy(async () => { await stopQuiet(); return await start() })
          }
          if (action === 'update-subscription') {
            return await withBusy(async () => {
              await updateAndRestart()
              return snapshot()
            })
          }
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err), state: snapshot() }
        }
        return { ok: false, error: `unknown action: ${String(action)}`, state: snapshot() }
      },
    }))
  })
}
