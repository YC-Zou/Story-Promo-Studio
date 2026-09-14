#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="${STORY_PROMO_RUNTIME_DIR:-$root/.runtime}"
pid_file="$runtime_dir/processes.env"

if [[ ! -f "$pid_file" ]]; then
  printf '没有找到本项目的进程记录，无需停止。\n'
  exit 0
fi

recorded_root=""
app_pid=""
audio_pid=""
proxy_pid=""
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" != *=* ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    root) recorded_root="$value" ;;
    app_pid) app_pid="$value" ;;
    audio_pid) audio_pid="$value" ;;
    proxy_pid) proxy_pid="$value" ;;
  esac
done < "$pid_file"

if [[ "$recorded_root" != "$root" ]]; then
  printf '进程记录不属于当前项目，未停止任何进程。\n' >&2
  exit 1
fi

stop_owned_process() {
  local name="$1" pid="$2" command_line attempts=0
  [[ -z "$pid" ]] && return 0
  if [[ ! "$pid" =~ ^[0-9]+$ ]] || ! kill -0 "$pid" 2>/dev/null; then
    printf '%s 已停止。\n' "$name"
    return 0
  fi
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$command_line" != *"$root"* ]]; then
    printf 'PID %s 已不属于当前项目，未停止。\n' "$pid" >&2
    return 0
  fi
  kill "$pid"
  while kill -0 "$pid" 2>/dev/null && (( attempts < 20 )); do
    sleep 0.25
    ((attempts += 1))
  done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid"; fi
  printf '已停止%s（PID %s）。\n' "$name" "$pid"
}

stop_owned_process '应用' "$app_pid"
stop_owned_process ' Stable Audio' "$audio_pid"
stop_owned_process '模型接口本地代理' "$proxy_pid"
rm -f "$pid_file"
