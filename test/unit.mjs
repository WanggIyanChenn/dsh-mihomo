// Zero-network checks for the pieces behind the chip's state channel.
// Run: node test/unit.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { resolveExitNode, selectedChain } from '../lib/runner.js'
import { createSseHub } from '../lib/stream.js'

const here = dirname(fileURLToPath(import.meta.url))
let passed = 0
const test = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

// --- exit-node resolution ---------------------------------------------------

await test('resolveExitNode walks a group chain to the leaf', () => {
  assert.equal(resolveExitNode({ A: 'B', B: 'C' }), 'C')
  assert.equal(resolveExitNode({ '🐟 漏网之鱼': '🔰 选择节点', '🔰 选择节点': '🇭🇰 香港W03' }), '🇭🇰 香港W03')
  assert.equal(resolveExitNode({ GLOBAL: 'DIRECT' }), '')
  assert.equal(resolveExitNode({}), '')
})

// --- selective chain probe against a fake controller ------------------------

function fakeController(routes) {
  const hits = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const prefix = '/proxies/'
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404).end()
      return
    }
    const name = decodeURIComponent(url.pathname.slice(prefix.length))
    hits.push(name)
    const route = routes[name]
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ now: route }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port }))
  })
}

await test('selectedChain reads only the preferred chain, not the full table', async () => {
  const { server, hits, port } = await fakeController({
    '🐟 漏网之鱼': '🔰 选择节点',
    '🔰 选择节点': '🇭🇰 香港W03',
  })
  try {
    const chain = await selectedChain(port)
    assert.equal(chain.exitNode, '🇭🇰 香港W03')
    assert.deepEqual(chain.nodes, { '🐟 漏网之鱼': '🔰 选择节点', '🔰 选择节点': '🇭🇰 香港W03' })
    assert.deepEqual(hits, ['🐟 漏网之鱼', '🔰 选择节点', '🇭🇰 香港W03'])
  } finally {
    await new Promise((r) => server.close(r))
  }
})

await test('selectedChain falls through to GLOBAL and the main selector', async () => {
  const { server, port } = await fakeController({
    GLOBAL: 'DIRECT',
    '🔰 选择节点': '🇯🇵 日本W04',
  })
  try {
    const chain = await selectedChain(port)
    assert.equal(chain.exitNode, '🇯🇵 日本W04')
  } finally {
    await new Promise((r) => server.close(r))
  }
})

await test('selectedChain rejects on a controller error instead of clearing the node', async () => {
  const server = createServer((req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' }).end('boom')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    await assert.rejects(() => selectedChain(server.address().port), /HTTP 500/)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

// --- SSE hub ----------------------------------------------------------------

function fakeRes() {
  return {
    headers: null,
    chunks: [],
    ended: false,
    writeHead(code, headers) { this.code = code; this.headers = headers },
    flushHeaders() { this.flushed = true },
    write(chunk) { this.chunks.push(chunk); return true },
    end() { this.ended = true },
  }
}

await test('SSE hub sends one initial frame and skips unchanged broadcasts', () => {
  const hub = createSseHub({ pingMs: 100000 })
  const res = fakeRes()
  hub.add(res, { status: 'running', exitNode: 'A' })
  assert.equal(res.code, 200)
  assert.match(res.headers['content-type'], /text\/event-stream/)
  assert.equal(res.chunks.length, 1)
  assert.match(res.chunks[0], /^data: \{"status":"running","exitNode":"A"\}\n\n$/)

  assert.equal(hub.broadcast({ status: 'running', exitNode: 'A' }), false)
  assert.equal(res.chunks.length, 1)

  assert.equal(hub.broadcast({ status: 'running', exitNode: 'B' }), true)
  assert.equal(res.chunks.length, 2)
  assert.match(res.chunks[1], /"exitNode":"B"/)
  hub.closeAll()
})

await test('SSE hub fans out, survives removal, and pings', async () => {
  const hub = createSseHub({ pingMs: 20 })
  const a = fakeRes()
  const b = fakeRes()
  hub.add(a, { status: 'stopped' })
  hub.add(b, { status: 'stopped' })
  assert.equal(hub.broadcast({ status: 'running' }), true)
  assert.equal(a.chunks.length, 2)
  assert.equal(b.chunks.length, 2)

  hub.remove(a)
  assert.equal(hub.broadcast({ status: 'error' }), true)
  assert.equal(a.chunks.length, 2)
  assert.equal(b.chunks.length, 3)

  await new Promise((r) => setTimeout(r, 55))
  assert.ok(b.chunks.includes(': ping\n\n'))
  hub.closeAll()
  assert.equal(b.ended, true)
  assert.equal(hub.size, 0)
})

// --- static guards: keep the polling path from coming back -------------------

await test('the chip no longer polls on a fixed interval', () => {
  const client = readFileSync(join(here, '..', 'client.js'), 'utf8')
  assert.ok(!/setInterval\(\s*refresh/.test(client), 'client.js must not poll refresh on a timer')
  assert.match(client, /EventSource\('\/dsh-mihomo\/state\/stream'\)/)
  assert.match(client, /body\.state/)
})

await test('the state route reads the snapshot instead of the kernel table', () => {
  const host = readFileSync(join(here, '..', 'index.js'), 'utf8')
  const stateRoute = host.slice(host.indexOf("path: '/dsh-mihomo/state',"), host.indexOf("path: '/dsh-mihomo/state/stream',"))
  assert.ok(!stateRoute.includes('selectedNodes'), '/state must not call selectedNodes')
  assert.match(host, /path: '\/dsh-mihomo\/state\/stream'/)
  assert.match(host, /createSseHub/)
})

console.log(`\n${passed} checks passed`)
