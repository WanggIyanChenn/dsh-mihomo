/** Selector injected for Japan-only sites; keeps every Japan node reachable. */
export const JAPAN_GROUP = '🇯🇵 日本自动'

/** Sites that refuse or degrade traffic from outside Japan. */
export const DEFAULT_JAPAN_DOMAINS = [
  'nicovideo.jp',
  'nico.ms',
  'dmm.co.jp',
  'dmm.com',
  'abema.tv',
  'tver.jp',
  'nhk.or.jp',
  'tv-asahi.co.jp',
  'tbs.co.jp',
  'ntv.co.jp',
  'fujitv.co.jp',
  'jra.go.jp',
  'bookwalker.jp',
  'dlsite.com',
  'pixiv.net',
  'amazon.co.jp',
  'rakuten.co.jp',
  'yahoo.co.jp',
]

/**
 * Add automatic node selection and a Japan-only rule set to a Clash config.
 *
 * The subscription is regenerated on every update, so edits here are applied
 * to the runtime copy each start instead of to the downloaded file.
 *
 * - `🔰 选择节点` becomes a `url-test` group: the kernel picks the lowest
 *   latency node itself, with no manual selection.
 * - A `🇯🇵 日本自动` group collects every Japan node, and the listed domains
 *   are routed to it ahead of the subscription's own rules.
 */
export function applyAutoPolicy(text, options = {}) {
  const testUrl = options.testUrl ?? 'http://www.gstatic.com/generate_204'
  const interval = Number(options.interval ?? 300)
  const tolerance = Number(options.tolerance ?? 50)
  const japanDomains = (options.japanDomains ?? DEFAULT_JAPAN_DOMAINS).filter(Boolean)
  const autoNode = options.autoNode !== false
  let out = text

  if (autoNode) {
    // Only the primary selector converts; the themed groups stay manual.
    const selector = /(\n  - name: 🔰 选择节点\n)(    )type: select\n/
    if (selector.test(out)) {
      out = out.replace(selector, (_m, head) => `${head}    type: url-test\n    url: ${testUrl}\n    interval: ${interval}\n    tolerance: ${tolerance}\n`)
    }
  }

  // Japan nodes come from the inline `{name: …, server: …}` proxy rows.
  const allJapan = [...out.matchAll(/^\s*-\s*\{name:\s*(🇯🇵[^,}]*?)\s*,/gm)]
    .map((match) => match[1].trim())
    .filter((name, index, list) => name !== '' && list.indexOf(name) === index)
  // Paid IEPL nodes only: free and download-only Japan nodes answer ping tests
  // but throttle ordinary browsing.
  const paidJapan = allJapan.filter((name) => !name.includes('免费') && !name.includes('下载专用'))
  const japanNodes = paidJapan.length > 0 ? paidJapan : allJapan

  if (japanNodes.length > 0 && !out.includes(`- name: ${JAPAN_GROUP}`) && japanDomains.length > 0) {
    const block = [
      `  - name: ${JAPAN_GROUP}`,
      '    type: url-test',
      `    url: ${testUrl}`,
      `    interval: ${interval}`,
      `    tolerance: ${tolerance}`,
      '    proxies:',
      ...japanNodes.map((name) => `      - ${name}`),
      '',
    ].join('\n')
    out = out.replace(/\nproxy-groups:\n/, `\nproxy-groups:\n${block}`)

    const rules = japanDomains
      .map((domain) => ` - DOMAIN-SUFFIX,${domain},${JAPAN_GROUP}`)
      .join('\n')
    out = out.replace(/\nrules:\n/, `\nrules:\n${rules}\n`)
  }

  return out
}
