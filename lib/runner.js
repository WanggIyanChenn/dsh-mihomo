import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Wait until the kernel's REST controller answers, or fail the start. */
export async function waitForController(port, timeoutMs = 20000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) {
        const body = await res.json().catch(() => ({}))
        return { ok: true, version: body?.version ?? '', meta: body?.meta === true }
      }
      last = `HTTP ${res.status}`
    } catch (err) {
      last = String(err?.message ?? err)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return { ok: false, error: last || 'timeout' }
}

/**
 * Spawn the kernel with its own data directory and runtime config.
 * Output goes to one log file so a failed start can be read afterwards.
 */
export function spawnKernel({ binary, dataDir, runtimeConfig, logFile, log = () => {} }) {
  mkdirSync(dirname(logFile), { recursive: true })
  const out = createWriteStream(logFile, { flags: 'a' })
  const proc = spawn(binary, ['-d', dataDir, '-f', runtimeConfig], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  proc.stdout.pipe(out)
  proc.stderr.pipe(out)
  proc.on('error', (err) => log(`kernel spawn error: ${err.message}`))
  log(`kernel started pid=${proc.pid} config=${runtimeConfig}`)
  return proc
}

/** Stop the kernel, escalating to SIGKILL after a grace period. */
export function killKernel(proc, timeoutMs = 3000) {
  if (!proc || proc.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* already gone */ }
    }, timeoutMs)
    proc.once('exit', () => { clearTimeout(timer); resolve() })
    try { proc.kill('SIGTERM') } catch { clearTimeout(timer); resolve() }
  })
}

/**
 * Fetch every group's selected node from the kernel controller.
 *
 * This is the expensive call (~80 KB with a full subscription), so the polling
 * path uses {@link selectedChain} instead. It throws on failure: swallowing the
 * error here used to make the caller's "keep the last known selection" branch
 * unreachable.
 */
export async function selectedNodes(port) {
  const res = await fetch(`http://127.0.0.1:${port}/proxies`, { signal: AbortSignal.timeout(2000) })
  if (!res.ok) throw new Error(`proxies HTTP ${res.status}`)
  const body = await res.json()
  const out = {}
  for (const [name, value] of Object.entries(body?.proxies ?? {})) {
    if (value && typeof value.now === 'string') out[name] = value.now
  }
  return out
}

/**
 * Ask the controller for one group's current pick.
 *
 * Returns `undefined` when the name is not a selector group (a leaf node has no
 * `now`, and an unknown name is 404); any other failure throws so the caller
 * keeps the last known selection instead of showing an empty node name.
 */
async function groupNow(port, name) {
  const res = await fetch(`http://127.0.0.1:${port}/proxies/${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(2000),
  })
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(`proxies/${name} HTTP ${res.status}`)
  const body = await res.json()
  return typeof body?.now === 'string' ? body.now : undefined
}

/**
 * Resolve the exit node by walking only the groups the chip actually shows.
 *
 * Instead of downloading `/proxies` (every group, ~80 KB), walk the preferred
 * chain one group at a time (each answer is ~2 KB) and stop at the first root
 * that resolves to a real leaf. The default roots cover the usual subscription
 * shape: the catch-all group, GLOBAL, then the main selector.
 */
export async function selectedChain(port, roots = ['🐟 漏网之鱼', 'GLOBAL', '🔰 选择节点']) {
  const nodes = {}
  for (const root of roots) {
    let current = root
    let depth = 0
    while (current && depth < 9) {
      const next = await groupNow(port, current)
      if (next === undefined) break
      nodes[current] = next
      current = next
      depth += 1
    }
    const exitNode = resolveExitNode(nodes)
    if (exitNode) return { nodes, exitNode }
  }
  return { nodes, exitNode: '' }
}

/**
 * Resolve the policy group chain down to a real node name.
 *
 * A group's `now` is often another group (`🔰 选择节点`), so a naive read shows
 * the group label instead of where traffic actually leaves. Walk the chain
 * until the target is not itself a selector.
 */
export function resolveExitNode(nodes) {
  const keys = new Set(Object.keys(nodes ?? {}))
  const walk = (name, depth = 0, seen = new Set()) => {
    if (!name || depth > 8 || seen.has(name)) return name
    seen.add(name)
    return keys.has(name) ? walk(nodes[name], depth + 1, seen) : name
  }
  const usable = (leaf) => Boolean(leaf) && !keys.has(leaf) && leaf !== 'DIRECT' && leaf !== 'REJECT'
  for (const preferred of ['🐟 漏网之鱼', 'GLOBAL']) {
    if (nodes?.[preferred] !== undefined) {
      const leaf = walk(nodes[preferred])
      if (usable(leaf)) return leaf
    }
  }
  for (const target of Object.values(nodes ?? {})) {
    if (!target || target === 'DIRECT' || target === 'REJECT') continue
    const leaf = walk(target)
    if (usable(leaf)) return leaf
  }
  return ''
}
