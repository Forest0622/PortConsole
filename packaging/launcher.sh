#!/bin/bash
# PortConsole.app 启动器：拉起本地服务，然后打开默认浏览器
set -u

CONTENTS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_RES="$CONTENTS_DIR/Resources/app"
DATA_DIR="$HOME/Library/Application Support/PortConsole"
PORT="${PORTCONSOLE_PORT:-4318}"
URL="http://127.0.0.1:$PORT/"

mkdir -p "$DATA_DIR"
export PORTCONSOLE_DATA="$DATA_DIR"

alert() {
  /usr/bin/osascript -e "display dialog \"$1\" buttons {\"好\"} default button 1 with title \"端口控制台\" with icon caution" >/dev/null 2>&1 || true
}

# 找 node：GUI 启动时 PATH 很短，需要挨个兜底
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  for c in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.nvm/versions/node"/*/bin/node \
    /usr/local/opt/node/bin/node; do
    if [ -x "$c" ]; then NODE_BIN="$c"; break; fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  alert "没有找到 Node.js。请先安装 Node.js 18 或更高版本（brew install node 或 nodejs.org），再打开本应用。"
  exit 1
fi

# 已经有一个控制台在跑：直接打开，不重复启动
if /usr/bin/curl -fsS --max-time 2 "$URL" >/dev/null 2>&1; then
  /usr/bin/open "$URL"
  exit 0
fi

# 端口被别的程序占着：明确提示，不静默失败
if /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  alert "端口 $PORT 已被其他程序占用，端口控制台无法启动。请先释放该端口，或设置环境变量 PORTCONSOLE_PORT 换一个端口。"
  exit 1
fi

cd "$APP_RES" || exit 1
/usr/bin/nohup "$NODE_BIN" "$APP_RES/server.mjs" >"$DATA_DIR/console.log" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" >"$DATA_DIR/console.pid"
disown "$SERVER_PID" 2>/dev/null || true

for _ in $(seq 1 40); do
  if /usr/bin/curl -fsS --max-time 1 "$URL" >/dev/null 2>&1; then
    /usr/bin/open "$URL"
    exit 0
  fi
  sleep 0.25
done

alert "控制台没有在预期时间内启动，日志在：$DATA_DIR/console.log"
exit 1
