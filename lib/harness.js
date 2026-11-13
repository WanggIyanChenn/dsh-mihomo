import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Locate the running harness installation.
 *
 * A plugin lives in the profile's node_modules, which is not on the
 * resolution path of a globally installed harness, so bare specifiers would
 * create second module instances. The installation root is derived from the
 * launch environment first, then from the Node executable and the entry
 * script, which both sit inside it for a global install.
 */
export function harnessRoot() {
  const roots = []
  if (process.env.DSH_INSTALL_DIR) roots.push(process.env.DSH_INSTALL_DIR)
  // <prefix>/bin/node -> <prefix>/lib/node_modules/@deepseek-ai/dsh
  const execDir = dirname(process.execPath)
  roots.push(join(execDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
  // .../dsh/bin/dsh.js or .../dsh/dist/cli.js, walking up a few levels
  const entry = process.argv[1]
  if (entry) {
    let dir = dirname(entry)
    for (let i = 0; i < 4; i += 1) {
      roots.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh'))
      dir = dirname(dir)
    }
  }
  for (const root of roots) {
    const probe = join(root, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
    if (existsSync(probe)) return root
  }
  return ''
}

/** Import one of the harness's own packages by absolute path. */
export async function importHarnessPackage(root, packageName, subpath = 'lib/index.js') {
  if (!root) throw new Error('harness installation not found')
  const entry = join(root, 'node_modules', '@deepseek-ai', packageName, subpath)
  return await import(pathToFileURL(entry).href)
}
