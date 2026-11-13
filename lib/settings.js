import { homedir } from 'node:os'
import { join } from 'node:path'

/** Resolve the DSH home the same way the harness does. */
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** Everything this plugin writes lives under one store directory. */
export const STORE_DIR = join(DSH_HOME, 'storages', 'dsh-mihomo')
export const BIN_DIR = join(STORE_DIR, 'bin')
export const DATA_DIR = join(STORE_DIR, 'data')
export const LOG_FILE = join(STORE_DIR, 'mihomo.log')
export const RUNTIME_YAML = join(STORE_DIR, 'runtime.yaml')
export const SOURCE_YAML = join(STORE_DIR, 'config.yaml')

/** Defaults for the row's `config` object. */
export const DEFAULTS = {
  enabled: true,
  autoStart: true,
  binaryPath: '',
  sourceConfig: '',
  httpPort: 7892,
  controllerPort: 9091,
  startTimeoutMs: 20000,
  bypass: 'api.deepseek.com',
  subscriptionUrl: '',
  subscriptionHours: 6,
  autoNode: true,
  japanDomains: '',
  testUrl: 'http://www.gstatic.com/generate_204',
  testInterval: 300,
  testTolerance: 50,
}
