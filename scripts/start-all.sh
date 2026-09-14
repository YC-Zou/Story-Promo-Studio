#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
audio_dir="$root/third_party/stable-audio-3-tflite"
runtime_dir="${STORY_PROMO_RUNTIME_DIR:-$root/.runtime}"
log_dir="$runtime_dir/logs"
pid_file="$runtime_dir/processes.env"
app_port="${STORY_PROMO_PORT:-4173}"
if [[ ! "$app_port" =~ ^[0-9]+$ ]] || (( app_port < 1 || app_port > 65535 )); then
  printf 'STORY_PROMO_PORT 必须是 1–65535 的整数。\n' >&2
  exit 2
fi
app_url="http://127.0.0.1:$app_port"
audio_url="http://127.0.0.1:7871"
proxy_url=""
proxy_pid=""
start_bgm=1
open_browser=1

usage() {
  printf '用法: %s [--no-bgm] [--no-open]\n' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-bgm) start_bgm=0 ;;
    --no-open) open_browser=0 ;;
    -h|--help) usage; exit 0 ;;
    *) printf '未知参数: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

mkdir -p "$log_dir"
app_pid=""
audio_pid=""

step() { printf '\n> %s\n' "$1"; }
ready() { curl --silent --show-error --fail --max-time 3 "$1" >/dev/null 2>&1; }
wait_ready() {
  local url="$1" seconds="$2" name="$3" elapsed=0
  while (( elapsed < seconds * 4 )); do
    ready "$url" && return 0
    sleep 0.25
    ((elapsed += 1))
  done
  printf '%s 在 %s 秒内未就绪，请检查 %s。\n' "$name" "$seconds" "$log_dir" >&2
  return 1
}

cleanup_failed_start() {
  local code=$?
  [[ -n "$app_pid" ]] && kill "$app_pid" 2>/dev/null || true
  [[ -n "$audio_pid" ]] && kill "$audio_pid" 2>/dev/null || true
  [[ -n "$proxy_pid" ]] && kill "$proxy_pid" 2>/dev/null || true
  exit "$code"
}
trap cleanup_failed_start ERR INT TERM

step '检查 Node.js'
if ! command -v node >/dev/null 2>&1; then
  printf '未找到 Node.js，请安装 Node.js 20 或更高版本：https://nodejs.org/\n' >&2
  exit 1
fi
node_version="$(node --version)"
node_major="${node_version#v}"
node_major="${node_major%%.*}"
if [[ ! "$node_major" =~ ^[0-9]+$ ]] || (( node_major < 20 )); then
  printf '需要 Node.js 20 或更高版本，当前为 %s。\n' "$node_version" >&2
  exit 1
fi
printf '  Node.js %s\n' "${node_version#v}"

config_dir="${STORY_PROMO_CONFIG_DIR:-}"
if [[ -z "$config_dir" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    config_dir="$HOME/Library/Application Support/StoryPromoStudio"
  else
    config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/story-promo-studio"
  fi
fi
config_file="$config_dir/config.env"
if [[ -f "$config_file" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      OPENAI_API_KEY|OPENAI_NEXT_API_KEY|OPENAI_BASE_URL|SEEDREAM_BASE_URL|HOOK_MODEL|SEEDREAM_MODEL)
        if [[ -z "${!key:-}" ]]; then export "$key=$value"; fi
        ;;
    esac
  done < "$config_file"
fi

if [[ -z "${OPENAI_API_KEY:-}" && -n "${OPENAI_NEXT_API_KEY:-}" ]]; then
  export OPENAI_API_KEY="$OPENAI_NEXT_API_KEY"
fi
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.openai-next.com/v1}"
export SEEDREAM_BASE_URL="${SEEDREAM_BASE_URL:-$OPENAI_BASE_URL}"
export HOOK_MODEL="${HOOK_MODEL:-gpt-5.6-sol}"
export SEEDREAM_MODEL="${SEEDREAM_MODEL:-doubao-seedream-5-0-pro-260628}"
export MUSIC_BASE_URL="$audio_url"
export PORT="$app_port"
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
export no_proxy="127.0.0.1,localhost${no_proxy:+,$no_proxy}"

upstream_interface="${STORY_PROMO_UPSTREAM_INTERFACE:-}"
if [[ -z "$upstream_interface" && "$(uname -s)" == "Darwin" && "$OPENAI_BASE_URL" == https://* ]]; then
  if ! curl --silent --show-error --connect-timeout 5 --max-time 10 -o /dev/null "$OPENAI_BASE_URL/models" 2>/dev/null; then
    if curl --interface en0 --silent --show-error --connect-timeout 5 --max-time 10 -o /dev/null "$OPENAI_BASE_URL/models" 2>/dev/null; then
      upstream_interface="en0"
      printf '  检测到 VPN 证书拦截，模型接口将通过 en0 安全直连。\n'
    fi
  fi
fi

if [[ -n "$upstream_interface" ]]; then
  if [[ ! "$upstream_interface" =~ ^[A-Za-z0-9]+$ ]]; then
    printf 'STORY_PROMO_UPSTREAM_INTERFACE 包含非法字符。\n' >&2
    exit 2
  fi
  local_address="$(ipconfig getifaddr "$upstream_interface" 2>/dev/null || true)"
  if [[ -z "$local_address" ]]; then
    printf '网络接口 %s 没有可用 IPv4 地址。\n' "$upstream_interface" >&2
    exit 1
  fi
  proxy_port="${STORY_PROMO_PROXY_PORT:-4174}"
  if [[ ! "$proxy_port" =~ ^[0-9]+$ ]] || (( proxy_port < 1 || proxy_port > 65535 )); then
    printf 'STORY_PROMO_PROXY_PORT 必须是 1–65535 的整数。\n' >&2
    exit 2
  fi
  proxy_url="http://127.0.0.1:$proxy_port"
  upstream_origin="${OPENAI_BASE_URL%/}"
  upstream_origin="${upstream_origin%/v1}"
  if ! ready "$proxy_url/__proxy_health"; then
    nohup env PROXY_PORT="$proxy_port" UPSTREAM_ORIGIN="$upstream_origin" UPSTREAM_LOCAL_ADDRESS="$local_address" \
      node "$root/scripts/api-interface-proxy.mjs" \
      >"$log_dir/api-proxy.out.log" 2>"$log_dir/api-proxy.err.log" &
    proxy_pid=$!
    wait_ready "$proxy_url/__proxy_health" 15 '模型接口本地代理'
  fi
  export OPENAI_BASE_URL="$proxy_url/v1"
  export SEEDREAM_BASE_URL="$proxy_url/v1"
fi

audio_python="$audio_dir/.venv/bin/python"
if (( start_bgm == 1 )) && [[ ! -x "$audio_python" ]]; then
  available_kib="$(df -Pk "$audio_dir" | awk 'NR==2 { print $4 }')"
  required_kib=$((5 * 1024 * 1024))
  if [[ "$available_kib" =~ ^[0-9]+$ ]] && (( available_kib < required_kib )); then
    printf '  磁盘可用空间不足 5 GB，已跳过首次 BGM 安装，主应用继续启动。\n' >&2
    printf '  清理空间后重新运行“启动.command”即可补装音乐模块。\n' >&2
    start_bgm=0
  fi
fi

if (( start_bgm == 1 )); then
  if ready "$audio_url/gradio_api/info"; then
    printf '  Stable Audio 已在 %s 运行。\n' "$audio_url"
  else
    step '准备 Stable Audio 3'
    if [[ ! -x "$audio_python" ]]; then
      printf '  首次启动将安装受管 Python 3.11、依赖并下载音乐模型（约 2.5 GB）。\n'
      (cd "$audio_dir" && ./install.sh -y --python 3.11 --download sm-music)
    elif ! (cd "$audio_dir" && "$audio_python" -c 'import sys; sys.path.insert(0,"scripts"); from weights import bundle_status; present,total=bundle_status("sm-music"); raise SystemExit(0 if present == total else 1)'); then
      printf '  正在补全 Stable Audio 音乐模型（约 2.5 GB）。\n'
      (cd "$audio_dir" && ./install.sh -y --python 3.11 --download sm-music)
    fi
    if ! "$audio_python" -c 'import gradio, PIL, soundfile' >/dev/null 2>&1; then
      printf '  正在安装 Stable Audio Web 服务依赖……\n'
      "$audio_python" -m pip install -r "$audio_dir/requirements-gradio.txt"
    fi
    export HF_HOME="$audio_dir/.cache/huggingface"
    unset HF_HUB_OFFLINE || true
    export GRADIO_ANALYTICS_ENABLED=False
    nohup "$audio_python" "$audio_dir/scripts/sa3_gradio.py" \
      --dit sm-music --decoder same-s --precision fp32 \
      --default-seconds 20 --default-steps 8 --threads 10 \
      --port 7871 --no-share \
      >"$log_dir/stable-audio.out.log" 2>"$log_dir/stable-audio.err.log" &
    audio_pid=$!
    printf '  正在启动 Stable Audio（PID %s）……\n' "$audio_pid"
    wait_ready "$audio_url/gradio_api/info" 180 'Stable Audio'
    printf '  Stable Audio 已就绪。\n'
  fi
else
  printf '  已跳过 BGM 服务；文字、图片和素材包功能仍可使用。\n'
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  printf '提示：尚未配置 API Key。界面可以打开，但模型生成功能不可用。\n' >&2
  printf '请先双击“首次配置 API Key.command”。\n' >&2
fi

if ready "$app_url/api/health"; then
  printf '  应用已在 %s 运行。\n' "$app_url"
else
  step '启动知乎故事 AI 宣发工作台'
  nohup node "$root/server.mjs" >"$log_dir/app.out.log" 2>"$log_dir/app.err.log" &
  app_pid=$!
  wait_ready "$app_url/api/health" 30 '应用'
  printf '  应用已就绪（PID %s）。\n' "$app_pid"
fi

umask 077
{
  printf 'root=%s\n' "$root"
  printf 'app_pid=%s\n' "$app_pid"
  printf 'audio_pid=%s\n' "$audio_pid"
  printf 'proxy_pid=%s\n' "$proxy_pid"
} > "$pid_file"

trap - ERR INT TERM
printf '\n体验地址：%s\n' "$app_url"
printf '使用结束后请运行“停止.command”。\n'
if (( open_browser == 1 )); then
  if [[ "$(uname -s)" == "Darwin" ]]; then open "$app_url"; fi
fi
