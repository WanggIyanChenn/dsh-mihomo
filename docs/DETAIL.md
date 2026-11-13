# Mihomo proxy

Runs a [mihomo](https://github.com/MetaCubeX/mihomo) kernel as a child process of the harness and
routes this process's outbound HTTP through it. It exists so DSH can reach the network through a
Clash subscription **without a separate ClashX / Clash Verge window running**.

## What it does

1. Ensures a mihomo binary exists under `~/.dsh/storages/dsh-mihomo/bin/mihomo`
   (downloads the pinned `v1.19.16` build for this platform when missing).
2. Reads a Clash YAML from `~/.dsh/storages/dsh-mihomo/config.yaml`, rewrites only the listener
   keys (`port`, `socks-port`, `mixed-port`, `allow-lan`, `external-controller`), and writes
   `runtime.yaml` next to it. Proxies, groups, rules and DNS stay exactly as the subscription
   produced them.
3. Starts the kernel on a private port (default `7892`) with its own data directory.
4. Waits for the REST controller, then installs a process-wide proxy through the harness's own
   `@deepseek-ai/dsh-http-proxy`, so every `fetch()` — web tools, search, LLM requests — is routed.
5. Restores the previous dispatcher and stops the kernel when the plugin is disabled.

## Configuration

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | the row is active |
| `autoStart` | `true` | start the kernel with the plugin |
| `httpPort` | `7892` | HTTP listener the harness talks to |
| `controllerPort` | `9091` | mihomo REST controller, loopback only |
| `bypass` | `api.deepseek.com` | extra `no_proxy` entries; loopback is always bypassed |
| `binaryPath` | `''` | override the kernel location |
| `sourceConfig` | `''` | override the Clash YAML location |

## Limits

- HTTP/HTTPS proxies only. The harness proxy layer refuses `socks5://`, which is why the kernel
  is configured with an HTTP `port` rather than a SOCKS one.
- The kernel binds loopback ports only (`allow-lan: false`).
- A Clash subscription YAML carries its own node credentials; it stays on this machine.
- No TUN mode, no system-wide proxy, no traffic from other apps.
