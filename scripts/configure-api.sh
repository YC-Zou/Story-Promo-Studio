#!/usr/bin/env bash
set -euo pipefail

default_base_url="https://api.openai-next.com/v1"
default_hook_model="gpt-5.6-sol"
default_image_model="doubao-seedream-5-0-pro-260628"

config_dir() {
  if [[ -n "${STORY_PROMO_CONFIG_DIR:-}" ]]; then
    printf '%s\n' "$STORY_PROMO_CONFIG_DIR"
  elif [[ "$(uname -s)" == "Darwin" ]]; then
    printf '%s\n' "$HOME/Library/Application Support/StoryPromoStudio"
  else
    printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/story-promo-studio"
  fi
}

clean_value() {
  local value="$1"
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    printf '配置值不能包含换行符。\n' >&2
    return 1
  fi
  printf '%s' "$value"
}

printf '知乎故事 AI 宣发工作台 - API 配置\n'
printf '密钥会保存在当前用户的私有配置目录，不会写入 Git 仓库。\n\n'

read -r -s -p 'API Key: ' api_key
printf '\n'
if [[ -z "$api_key" ]]; then
  printf 'API Key 不能为空。\n' >&2
  exit 1
fi

read -r -p "OpenAI 兼容 Base URL [$default_base_url]: " base_url
read -r -p "文本模型 [$default_hook_model]: " hook_model
read -r -p "图片模型 [$default_image_model]: " image_model

base_url="${base_url:-$default_base_url}"
hook_model="${hook_model:-$default_hook_model}"
image_model="${image_model:-$default_image_model}"
base_url="${base_url%/}"

if [[ ! "$base_url" =~ ^https:// && ! "$base_url" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?(/|$) ]]; then
  printf 'Base URL 必须使用 HTTPS；仅本机 127.0.0.1/localhost 可使用 HTTP。\n' >&2
  exit 1
fi

api_key="$(clean_value "$api_key")"
base_url="$(clean_value "$base_url")"
hook_model="$(clean_value "$hook_model")"
image_model="$(clean_value "$image_model")"

target_dir="$(config_dir)"
config_file="$target_dir/config.env"
temp_file="$target_dir/.config.env.$$"
umask 077
mkdir -p "$target_dir"
trap 'rm -f "$temp_file"' EXIT
{
  printf 'OPENAI_API_KEY=%s\n' "$api_key"
  printf 'OPENAI_NEXT_API_KEY=%s\n' "$api_key"
  printf 'OPENAI_BASE_URL=%s\n' "$base_url"
  printf 'SEEDREAM_BASE_URL=%s\n' "$base_url"
  printf 'HOOK_MODEL=%s\n' "$hook_model"
  printf 'SEEDREAM_MODEL=%s\n' "$image_model"
} > "$temp_file"
chmod 600 "$temp_file"
mv -f "$temp_file" "$config_file"
trap - EXIT

printf '\n配置已安全保存。现在可以双击“启动.command”。\n'
