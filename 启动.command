#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
./scripts/start-all.sh
status=$?
if (( status != 0 )); then read -r -p '启动失败，按回车键关闭窗口……' _; fi
exit "$status"
