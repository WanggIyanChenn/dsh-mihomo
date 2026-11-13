// Host-side integration without a running DSH.
//
// Mock the two services the plugin injects, mount its routes on a plain
// node:http server, then read the real SSE stream. autoStart stays off so this
// never spawns a kernel or installs a proxy.
//
// Run: DSH_INSTALL_DIR=... node test/host.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

if (!process.env.DSH_INSTALL_DIR) {
  console.error('set DSH_INSTALL_DIR to the dsh installation directory first')
  process.exit(1)
}

const { apply } = await import('../index.js')

const routes = new Map()
const effects = []
const fakeScope = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') effects.push(dispose)
    return dispose
  },
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  tools: { register() {} },
}
const ctx = {
  logger: { info() {} },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') effects.push(dispose)
    return dispose
  },
  inject(_deps, callback) { callback(fakeScope) },
}

await apply(ctx, { enabled: false, autoStart: false, httpPort: 7899, controllerPort: 9099 })

const server = createServer((req, res) => {
  const route = routes.get(new URL(req.url, 'http://x').pathname)
  if (route) route.handler(req, res)
  else res.writeHead(404).end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

try {
  const state = await (await fetch(`http://127.0.0.1:${port}/dsh-mihomo/state`)).json()
  assert.equal(state.ok, true)
  assert.equal(state.state.status, 'stopped')

  const openStream = async () => {
    const abort = new AbortController()
    const res = await fetch(`http://127.0.0.1:${port}/dsh-mihomo/state/stream`, { signal: abort.signal })
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (!buf.includes('\n\n')) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
    }
    return { frame: buf, abort, reader }
  }
  const first = await openStream()

  assert.match(first.frame, /^data: /)
  const snapshot = JSON.parse(first.frame.slice('data: '.length, first.frame.indexOf('\n\n')))
  assert.equal(snapshot.status, 'stopped')

  const unknown = await fetch(`http://127.0.0.1:${port}/dsh-mihomo/action`, {
    method: 'POST',
    body: JSON.stringify({ action: 'nope' }),
  })
  assert.equal(unknown.status, 400)

  first.abort.abort()
  await new Promise((resolve) => setTimeout(resolve, 100))

  console.log('host integration ok: routes, snapshot, SSE first frame, action guard')
} finally {
  for (const dispose of effects.reverse()) await dispose()
  await new Promise((resolve) => server.close(resolve))
}
