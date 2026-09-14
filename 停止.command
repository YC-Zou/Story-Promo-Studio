#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
./scripts/stop-all.sh
status=$?
if (( status != 0 )); then read -r -p '停止失败，按回车键关闭窗口……' _; fi
exit "$status"
