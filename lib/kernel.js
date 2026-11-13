import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { BIN_DIR, DATA_DIR, STORE_DIR } from './settings.js'

/** Release the plugin was tested against. */
export const PINNED_VERSION = 'v1.19.16'

/** Where a pre-downloaded kernel may already sit, in priority order. */
function candidates(explicit) {
  const list = []
  if (explicit) list.push(explicit)
  list.push(join(BIN_DIR, 'mihomo'))
  return list
}

/** Return the first existing executable, or an empty string. */
export function findBinary(explicit) {
  for (const p of candidates(explicit)) {
    try {
      if (existsSync(p)) {
        // Make sure it is executable; a fresh checkout loses the bit.
        try { chmodSync(p, 0o755) } catch { /* best effort */ }
        return p
      }
    } catch { /* ignore */ }
  }
  return ''
}

/** Report the kernel version, or an empty string when it cannot run. */
export function versionOf(binary) {
  try {
    const out = execFileSync(binary, ['-v'], { encoding: 'utf8', timeout: 8000 })
    return (out.match(/v\d+\.\d+\.\d+/)?.[0]) ?? out.trim().split('\n')[0]
  } catch {
    return ''
  }
}

/** Ensure the store layout exists. */
export function ensureDirs() {
  mkdirSync(BIN_DIR, { recursive: true })
  mkdirSync(DATA_DIR, { recursive: true })
}

/**
 * Download the pinned kernel for this platform.
 * GitHub releases are the only source; the caller reports progress through `log`.
 */
export async function downloadBinary(log = () => {}) {
  const platform = process.platform === 'darwin' ? 'darwin'
    : process.platform === 'linux' ? 'linux'
      : process.platform === 'win32' ? 'windows' : ''
  if (platform === '') throw new Error(`unsupported platform: ${process.platform}`)
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const ext = platform === 'windows' ? '.zip' : '.gz'
  const asset = `mihomo-${platform}-${arch}-${PINNED_VERSION}${ext}`
  const url = `https://github.com/MetaCubeX/mihomo/releases/download/${PINNED_VERSION}/${asset}`
  ensureDirs()
  const target = join(BIN_DIR, platform === 'windows' ? 'mihomo.exe' : 'mihomo')
  log(`downloading ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (platform === 'windows') {
    writeFileSync(join(BIN_DIR, asset), buf)
    throw new Error(`unzipped install not implemented; extract ${asset} into ${BIN_DIR}`)
  }
  const { gunzipSync } = await import('node:zlib')
  writeFileSync(target, gunzipSync(buf))
  chmodSync(target, 0o755)
  // Fresh downloads carry the quarantine flag on macOS.
  try { execFileSync('xattr', ['-d', 'com.apple.quarantine', target]) } catch { /* not on macOS */ }
  log(`installed ${target}`)
  return target
}

/** Read the user's Clash configuration from the store, or `sourceConfig`. */
export function readSourceConfig(sourceConfig) {
  const p = sourceConfig && existsSync(sourceConfig) ? sourceConfig : join(STORE_DIR, 'config.yaml')
  if (!existsSync(p)) {
    throw new Error(`no Clash config found: put a Clash YAML at ${join(STORE_DIR, 'config.yaml')} or set sourceConfig`)
  }
  return { path: p, text: readFileSync(p, 'utf8') }
}

/**
 * Rewrite the top-level listener keys of a Clash config so the kernel owns
 * its own ports, then write the result next to the store.
 *
 * A line-wise edit keeps the rest of the file — proxies, groups, rules, dns —
 * byte-for-byte as the subscription wrote it.
 */
export function writeRuntimeConfig(text, { httpPort, controllerPort, outPath, transform }) {
  const setKey = (src, key, value) => {
    const re = new RegExp(`^${key}:.*$`, 'm')
    return re.test(src) ? src.replace(re, `${key}: ${value}`) : `${key}: ${value}\n${src}`
  }
  let out = text
  out = setKey(out, 'port', httpPort)
  out = setKey(out, 'socks-port', 0)
  out = setKey(out, 'mixed-port', 0)
  out = setKey(out, 'allow-lan', false)
  out = setKey(out, 'external-controller', `127.0.0.1:${controllerPort}`)
  if (typeof transform === 'function') out = transform(out)
  ensureDirs()
  writeFileSync(outPath, out)
  return outPath
}
