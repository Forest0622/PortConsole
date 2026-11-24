# PortConsole

macOS 本机端口控制台。扫描当前所有处于 LISTEN 状态的 TCP 端口，在网页上完成启动、停止、重启、查看日志与跳转项目目录。

![platform](https://img.shields.io/badge/platform-macOS%2011%2B-lightgrey)
![runtime](https://img.shields.io/badge/runtime-Node.js%2018%2B-blue)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)

![界面](docs/preview-github.png)

## 特性

- 端口自动纳入：`lsof` 扫到的监听端口直接成为清单条目，不需要手动登记
- 每张卡片 6 个操作：启动 / 停止 / 重启 / 打开 / 日志 / 访达
- 启动以 `/bin/zsh -lc` 执行，可读取 nvm、Homebrew 等 PATH
- 状态按端口是否 LISTEN 判定，4 秒刷新一次，显示 PID 与运行时长
- 停止只作用于占用该端口的进程；自身拉起的进程按进程组处理，其余单进程 SIGTERM
- 日志按服务分文件写入，界面抽屉 1.5 秒刷新
- 零第三方依赖，仅使用 Node 内置模块
- 仅绑定 `127.0.0.1`，不对外网暴露
- 关闭控制台不停止已启动的服务

## 安装

到 [Releases](../../releases) 下载 `PortConsole-macOS-<版本>.zip`，解压后将 `PortConsole.app` 拖入「应用程序」。

前置条件：本机已有 Node.js 18+（`brew install node` 或从 nodejs.org 安装），应用调用系统 node。

未做 Apple 公证，首次打开走「右键 → 打开」。若提示「已损坏」：

```bash
xattr -dr com.apple.quarantine /Applications/PortConsole.app
```

双击后拉起本地服务并打开默认浏览器，重复双击只打开已有页面，不会产生第二个实例。

数据目录为 `~/Library/Application Support/PortConsole/`（`services.json`、`logs/`、`console.log`），卸载应用不会删除。

## 源码运行

```bash
cd /path/to/PortConsole
node server.mjs
```

或双击「启动.command」。打开 <http://127.0.0.1:4318>。

## 打包

```bash
./build-app.sh
```

产物：`dist/PortConsole.app`、`dist/PortConsole-macOS-<版本>.zip`。版本号取自 `VERSION`，图标源为 `assets/icon-1024.png`。

## 端口清单机制

控制台启动后，`lsof` 扫到的每个监听端口都会写入 `services.json`，条目 id 为 `auto-<端口>`：

| 行为 | 规则 |
| --- | --- |
| 新增 | 新出现的端口直接建条目，命令、工作目录、访问地址取自进程本身 |
| 跟随 | 同一端口更换进程（命令或目录变化）时，`auto` 条目同步更新 |
| 换端口复用 | 同一程序绑定到新端口时（命令中仅端口号不同亦判定为同一程序，覆盖 `rapportd`、`llama-server` 等会重新绑定的进程），旧条目改到新端口，不产生失效卡片 |
| 保留 | 端口已停止时条目保留，卡片显示「已停止」，可再次启动 |
| 清理 | `auto` 条目连续 7 天未监听则删除；同命令已换端口的旧条目立即清理；总数上限 80，超出按最久未出现优先丢弃 |
| 不覆盖手工配置 | 不含 `auto` 字段的条目不会被自动逻辑修改 |

因此正在监听的端口无法从界面移除：删除条目后下一轮扫描会重新加入。要隐藏某个端口，只能停掉对应进程或用搜索过滤。

需要固定名称、启动命令或 id 时，把 `auto` 条目改为手工条目：删除 `"auto": true`（及 `addedAt` / `lastSeen`），此后自动逻辑不再处理该条目。

## 服务配置

`services.json` 的每个 `services` 元素对应一张卡片：

```json
{
  "services": [
    {
      "id": "api",
      "name": "后端 API",
      "port": 8000,
      "cwd": "~/code/backend",
      "command": "npm run dev",
      "url": "http://localhost:8000",
      "note": "依赖本地 Postgres",
      "env": { "NODE_ENV": "development" },
      "startTimeout": 25000
    }
  ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 唯一标识，限英文、数字、短横线；日志文件名同此值 |
| `name` | 是 | 界面显示名称 |
| `port` | 是 | 服务监听端口，状态判定依据 |
| `command` | 是 | 启动命令，经 `/bin/zsh -lc` 执行 |
| `cwd` | 否 | 工作目录，支持 `~` 与相对路径。自动条目取不到目录时为 `null`，启动时回退到本目录 |
| `url` | 否 | 「打开」按钮目标地址，默认 `http://localhost:<port>` |
| `note` | 否 | 卡片备注 |
| `env` | 否 | 追加环境变量 |
| `startTimeout` | 否 | 启动后等待端口就绪的毫秒数，默认 25000 |
| `auto` | 否 | `true` 表示扫描自动纳入，接受自动更新与清理；缺省为手工条目 |

保存后网页 4 秒内同步，无需重启后端。

## 卡片操作

| 按钮 | 作用 | 置灰条件 |
| --- | --- | --- |
| 启动 | 在 `cwd` 下执行 `command`，等待端口就绪 | 已在运行 |
| 停止 | 结束占用该端口的进程 | 未运行 |
| 重启 | 先停后启 | 未运行 |
| 打开 | 浏览器打开 `url` | 未运行 |
| 日志 | 打开 `logs/<id>.log` 抽屉，1.5 秒刷新 | 无 |
| 访达 | 在访达打开项目目录 | 无法确定目录 |

访达目录的解析顺序：配置中的 `cwd` → 进程真实 cwd → 从命令行路径向上查找项目标记（`.git`、`package.json`、`Cargo.toml`、`platformio.ini`、`CMakeLists.txt`、`*.xcodeproj` 等）。系统进程（`ControlCenter`、`rapportd`、`ollama` 等）通常无法解析，按钮置灰并显示「项目目录未知」。

默认隐藏 1024 以下系统端口。顶部搜索框按名称、端口、命令、目录过滤。

## 批量操作

- 全部启动：只处理未运行的条目，已在监听的跳过；无可启动项时直接提示
- 全部停止：只处理运行中的条目，先弹确认框并提示会包含系统进程
- 单项失败不影响其余任务，结束时汇总成功数与失败原因

## 运行行为

- 状态：每 4 秒用 `lsof` 查询 LISTEN，显示 PID 与运行时长
- 启动：先检查端口占用，被占时返回占用进程 PID；启动后轮询端口，就绪才返回成功，上限为 `startTimeout`
- 停止：只结束监听该端口的进程。自身拉起的进程（独立进程组，pgid 等于子进程 pid）整组 SIGTERM，其余单进程 SIGTERM，6 秒未退出升级为 SIGKILL
- 日志：`logs/<id>.log` 按时间追加；`?log=<id>` 可直接打开指定服务日志
- 关闭控制台：仅退出 node 进程，已启动的服务不受影响

## 快捷键

| 键 | 作用 |
| --- | --- |
| `/` | 聚焦搜索框 |
| `Esc` | 关闭日志抽屉 / 取消搜索框聚焦 |

## 限制

- 依赖 macOS 自带的 `lsof`、`ps` 与 `/bin/zsh`，当前仅在 macOS 上验证
- 仅适用于非容器场景，Docker 服务请用 `docker compose` 管理
- 后端无鉴权，绑定 `127.0.0.1`。不要改为 `0.0.0.0` 或暴露到公网
- 接口只接受 `services.json` 中已有的 `id`，不接受任意命令
- 系统进程可能因权限不足无法停止，会返回明确错误
- 状态以端口是否监听为准，启动成功但未绑定端口的进程会被判定为「已停止」，需查日志排查
- 自动条目会回写 `services.json`；同时手工编辑该文件时，`auto` 条目可能在 4 秒内被覆盖，手工条目不受影响

## 目录结构

```
PortConsole/
├── server.mjs              后端：状态探测、启停、自动纳入、日志接口
├── public/index.html       前端：单文件，内联 CSS/JS
├── packaging/launcher.sh   .app 启动器
├── build-app.sh            打包 .app / zip
├── VERSION                 版本号
├── assets/icon-1024.png    图标源图
├── services.json           服务清单（运行后生成，已 gitignore）
├── 启动.command             源码直接运行
├── logs/                   服务日志
└── docs/                   界面截图
```

## 常见问题

**修改控制台自身端口**

```bash
PORT=4319 node server.mjs
```

**服务启动后立即退出**

查看 `logs/<id>.log`。常见原因是命令拼写、依赖未安装或 `cwd` 不正确。自动条目取不到目录时会回退到本目录，命令建议使用绝对路径。

**端口被占用但需要强制接管**

先在卡片上点「停止」结束占用进程，再点「启动」。系统级进程可能因权限失败，界面会给出提示。

**某个端口不希望出现在界面**

停掉对应进程，或使用搜索过滤。删除 `services.json` 条目无效，下一轮扫描会重新写入。

## License

MIT
