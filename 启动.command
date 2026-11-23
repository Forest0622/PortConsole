#!/bin/zsh
# 双击运行：启动本地端口控制台
cd "$(dirname "$0")" || exit 1
exec node server.mjs
