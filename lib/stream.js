/**
 * One SSE fan-out for the composer chip.
 *
 * The hub owns every connected response, the shared 25 s comment-frame timer,
 * and the last frame it sent. `broadcast` serializes the snapshot once and
 * skips the write when nothing changed, so a probe that found the same node
 * costs zero bytes.
 *
 * Frames are plain `data:` messages (no event name), which keeps the client on
 * `EventSource.onmessage`; a comment frame (`: ping\n\n`) keeps idle proxies
 * from closing the connection and is invisible to the client.
 */
export function createSseHub({ pingMs = 25000 } = {}) {
  const clients = new Set()
  let lastFrame = ''
  let timer = null

  const stopTimer = () => {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  const startTimer = () => {
    if (timer !== null || clients.size === 0) return
    timer = setInterval(() => {
      for (const res of clients) send(res, ': ping\n\n')
    }, pingMs)
    timer.unref?.()
  }

  const drop = (res) => {
    if (!clients.delete(res)) return
    try { res.end() } catch { /* already closed */ }
    if (clients.size === 0) stopTimer()
  }

  const send = (res, chunk) => {
    try {
      res.write(chunk)
      return true
    } catch {
      drop(res)
      return false
    }
  }

  return {
    get size() {
      return clients.size
    },

    /** Attach one response and send the current snapshot immediately. */
    add(res, initial) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.flushHeaders?.()
      clients.add(res)
      const frame = JSON.stringify(initial ?? {})
      lastFrame = frame
      send(res, `data: ${frame}\n\n`)
      startTimer()
    },

    /** Push one snapshot to every client; no-op when unchanged or nobody listens. */
    broadcast(value) {
      const frame = JSON.stringify(value)
      if (frame === lastFrame) return false
      lastFrame = frame
      if (clients.size === 0) return false
      for (const res of clients) send(res, `data: ${frame}\n\n`)
      return true
    },

    remove(res) {
      drop(res)
    },

    closeAll() {
      for (const res of clients) {
        try { res.end() } catch { /* already closed */ }
      }
      clients.clear()
      stopTimer()
    },
  }
}
