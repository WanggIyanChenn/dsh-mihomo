# dsh-mihomo

在 DSH 进程里托管一个 mihomo 内核，把 DSH 自己的出站请求（web 工具、搜索、模型请求）导到本地 HTTP 代理端口。不用另开 ClashX，也不改系统代理。

## 为什么做这个

DSH 的工具和模型请求都走进程内 `fetch()`。之前要先开 ClashX 之类的代理软件，DSH 才能借用它的端口；代理软件一关，联网工具就断。这个插件把内核作为 DSH 的子进程拉起来，并在进程内热装代理 dispatcher，所以只影响 DSH，不碰系统设置，也不需要常驻的代理客户端。

## 功能

- 首次启动自动下载固定版本的 mihomo 内核（`v1.19.16`，按平台选 darwin / linux / windows）。
- 读取一份 Clash 订阅 YAML，只改监听端口相关键，代理、分组、规则、DNS 原样保留。
- 内核以独立数据目录运行，默认 HTTP 端口 `7892`，REST 控制器 `9091`（仅回环）。
- 通过 DSH 自己的 `@deepseek-ai/dsh-http-proxy` 安装进程级代理，启用后所有 `fetch()` 都走它。
- 可配置订阅定时刷新，默认每 6 小时拉一次并重启内核。
- 自动选节点：把主选择组改成 `url-test`；另建一个日本节点组，给一批日本站点优先走日本节点。
- 输入框下方的胶囊显示开关、端口和当前节点，点击即可启停。
- 胶囊走 SSE：连上先收一帧当前状态，之后只在状态变化时推送；空闲时每 25 秒一条心跳。页面关掉后宿主侧不留定时器。
- 节点名每 60 秒只沿主链路查两个组，不再为了让胶囊显示一个名字去拉整张节点表。
- 给模型两个工具：`mihomo_status`、`mihomo_control`。

## 工作流程

1. 找内核：优先用 `binaryPath`，否则用 `~/.dsh/storages/dsh-mihomo/bin/mihomo`，都没有就下载。
2. 读配置：读 `sourceConfig` 或 `~/.dsh/storages/dsh-mihomo/config.yaml`。
3. 改监听键：把 `port` 改成 `httpPort`，把 `socks-port`、`mixed-port` 置 0，`allow-lan` 置 false，`external-controller` 指到回环。
4. 套用自动选节点与日本站点规则，写到同目录的 `runtime.yaml`。
5. 启动内核，等 REST 控制器就绪，再安装进程级代理。
6. 禁用插件或点「代理关」时，恢复原来的 dispatcher 并停掉内核。
7. 控制面：`/dsh-mihomo/state` 只回内存快照；`/dsh-mihomo/state/stream` 用 SSE 推送变化；`/dsh-mihomo/action` 执行启停，响应里直接带新状态，胶囊不再补一次查询。

## 安装

前提：DSH 0.2.x、Node.js ≥ 20，首次启动能访问 GitHub Releases 下载内核。

包内的 `cordis.patch.yml` 是不含订阅凭据的模板。安装步骤：

1. 把本目录放到 `~/.dsh/plugins/dsh-mihomo`，或任意固定路径。
2. 在 profile 里登记：

   ```bash
   dsh plugin --profile web add file:/绝对路径/dsh-mihomo
   ```

3. 确认 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里有 `dsh-mihomo`；没有就手动加一行。
4. 编辑插件目录下的 `cordis.patch.yml`，把 `subscriptionUrl` 填成自己的 Clash 订阅地址。
5. 重启 DSH。

本机已经用 `link:` 方式装进 web profile；替换源码目录后重启 DSH 即可生效。

## 配置

配置写在 `cordis.patch.yml` 的 `config` 下，都是可选项。

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否启用这一行 |
| `autoStart` | `true` | 插件加载时是否自动启动内核 |
| `httpPort` | `7892` | DSH 实际连接的 HTTP 代理端口 |
| `controllerPort` | `9091` | mihomo REST 控制器端口，仅回环 |
| `startTimeoutMs` | `20000` | 等控制器就绪的超时 |
| `bypass` | `api.deepseek.com` | 额外不走代理的域名；回环地址永远绕过 |
| `binaryPath` | `''` | 指定内核可执行文件，留空用默认位置 |
| `sourceConfig` | `''` | 指定 Clash YAML，留空用默认位置 |
| `subscriptionUrl` | `''` | Clash 订阅地址；为空时不自动拉取 |
| `subscriptionHours` | `6` | 订阅刷新间隔（小时），`0` 表示不刷新 |
| `nodeProbeSeconds` | `60` | 胶囊可见时节点名的探测间隔（秒），`0` 表示不探测 |
| `autoNode` | `true` | 是否把主选择组改成 `url-test` |
| `japanDomains` | `''` | 自定义日本站点列表，逗号或空白分隔；留空用内置列表 |
| `testUrl` | `http://www.gstatic.com/generate_204` | 节点测速地址 |
| `testInterval` | `300` | 测速间隔（秒） |
| `testTolerance` | `50` | url-test 切换容差（毫秒） |

## 使用

- **输入框胶囊**：显示「代理开 / 代理关 / 代理异常」，悬停可看端口和节点；点击切换。状态由 SSE 推送，断线 3 秒后重连；首屏仍用一次普通 GET 兜底。
- **模型工具**：`mihomo_status` 查状态；`mihomo_control` 接受 `start`、`stop`、`restart`、`update-subscription`。
- **本机接口**：`GET /dsh-mihomo/state`（内存快照，不拉内核全表）、`GET /dsh-mihomo/state/stream`（SSE，首帧 + 变化推送 + 25 秒心跳）、`POST /dsh-mihomo/action`（响应带新状态）。只接受回环请求。

## 数据与安全

所有运行时文件在 `~/.dsh/storages/dsh-mihomo/`：

| 路径 | 内容 |
|---|---|
| `bin/mihomo` | 内核可执行文件 |
| `config.yaml` | 订阅拉下来的 Clash 配置，含节点凭据 |
| `runtime.yaml` | 改写端口后的运行配置 |
| `data/` | 内核自己的数据目录 |
| `mihomo.log` | 内核日志 |

- Clash 订阅里带节点账号密码，`config.yaml`、`runtime.yaml` 和真实 `cordis.patch.yml` 都只留在本机，不要提交到公开仓库或发给别人。
- 内核只监听回环，`allow-lan` 固定为 `false`。
- 只接管 DSH 进程的 HTTP/HTTPS 出站，不改系统代理，也没有 TUN 模式。
- DSH 的代理层不接受 `socks5://`，所以内核配的是 HTTP 端口。

## 已知限制

- Windows 首次下载得到的是 zip，当前代码不会自动解压，需要手动解压到 `bin/`。
- 日本分组依赖订阅里的固定命名：`🔰 选择节点` 组和以 `🇯🇵` 开头的节点名。订阅换了命名，自动策略会跳过，不会报错。
- 订阅更新会重启内核，正在进行的请求可能中断一次。
- 只影响 DSH 自己，其他应用的流量不经过它。

## 文件结构

```
dsh-mihomo/
├── index.js              # 插件入口：生命周期、订阅刷新、HTTP 接口、工具
├── client.js             # 输入框胶囊
├── lib/
│   ├── settings.js       # 默认配置与数据目录
│   ├── kernel.js         # 找/下载内核，改写运行配置
│   ├── runner.js         # 启动内核、等控制器、读节点（全量/主链路两种）
│   ├── stream.js         # 胶囊的 SSE 扇出与心跳
│   ├── proxy.js          # 安装进程级代理
│   ├── policy.js         # 自动选节点与日本站点规则
│   └── harness.js        # 定位宿主安装目录，复用同一模块实例
├── locale/               # 中英文案
├── docs/DETAIL.md        # 设计细节
├── test/unit.mjs         # 零网络的单元检查（节点链、SSE、防回退）
├── test/host.mjs         # 假宿主挂真实路由，验 /state 与 SSE 首帧
├── test/e2e.mjs          # 脱离宿主的端到端自测
├── cordis.patch.yml      # 配置模板（无凭据）
└── package.json
```

## 开发自测

`test/unit.mjs` 不需要网络和内核，直接跑：

```bash
node test/unit.mjs
```

`test/host.mjs` 用假的 cordis 上下文加载真实插件入口，把路由挂到普通 HTTP 服务上，验证 `/state`、SSE 首帧与 action 守卫；不会启动内核：

```bash
DSH_INSTALL_DIR=/path/to/dsh node test/host.mjs
```

`test/e2e.mjs` 会在宿主外起内核、装进程级代理，对比代理前后的出口 IP。它在临时数据目录里跑，不会覆盖已安装插件的 `runtime.yaml`；默认端口 `7894 / 9093`，可用 `DSH_MIHOMO_TEST_HTTP_PORT`、`DSH_MIHOMO_TEST_CTRL_PORT` 改。需要先准备真实 Clash 配置和内核二进制，并指定 DSH 安装目录：

```bash
DSH_INSTALL_DIR=/path/to/dsh node test/e2e.mjs
```

## 版本

0.2.0 · 2026-11-13 · 作者 Hsu_Huanyi · MIT
