#!/bin/sh
set -eu

DSH_HOME="${DSH_HOME:-/data/dsh}"
KAIWU_PORT="${KAIWU_PORT:-3080}"
KAIWU_WEB_TOKEN_SECRET_NAME="${KAIWU_WEB_TOKEN_SECRET_NAME:-}"
KAIWU_WEB_TOKEN_TIMEOUT="${KAIWU_WEB_TOKEN_TIMEOUT:-60}"
PROFILE_DIR="$DSH_HOME/profiles/employee"
VERSION_FILE="$DSH_HOME/.kaiwu-profile-version"

mkdir -p "$DSH_HOME/profiles" \
         "$DSH_HOME/sessions" \
         "$DSH_HOME/storages" \
         "$DSH_HOME/临时对话" \
         "$DSH_HOME/.agent-presets"

# CephFS PVC 可能把历史凭据文件恢复为 group-readable；DSH 出于安全要求
# credentials 文件必须 owner-only。启动前只修正权限，不读取、不输出文件内容。
if [ -f "$DSH_HOME/.credentials.yaml" ]; then
  chmod 600 "$DSH_HOME/.credentials.yaml"
fi

# 镜像升级时刷新 profile 插件代码，但不覆盖 settings、sessions、storages。
if [ ! -f "$VERSION_FILE" ] || [ "$(cat "$VERSION_FILE" 2>/dev/null || true)" != "$KAIWU_PROFILE_VERSION" ]; then
  rm -rf "$PROFILE_DIR"
  cp -a /opt/kaiwu-home-template/profiles/employee "$DSH_HOME/profiles/"
  printf '%s\n' "$KAIWU_PROFILE_VERSION" > "$VERSION_FILE"
fi

# dsh-web-app 0.1.2-rc.1 硬性拒绝 --host 0.0.0.0（Web UI 可执行任意代码，
# 上游为防 RCE 暴露有意只允许回环）。因此 dsh 绑 127.0.0.1:3081（回环 + 内部
# 端口），socat 监听 0.0.0.0:3080（对外端口，Service/探针不变）四层转发过去。
# 内外端口必须错开：同端口时 0.0.0.0 与 127.0.0.1 地址重叠，后绑定者 EADDRINUSE。
# browser-trust fence 校验的是 HTTP Host 头，socat 纯 TCP 转发不改头，
# --trusted-host 的语义不变。
DSH_PORT=3081
socat TCP-LISTEN:"$KAIWU_PORT",bind=0.0.0.0,fork,reuseaddr \
  TCP:127.0.0.1:"$DSH_PORT" &
SOCK_PID=$!

if [ -n "${KAIWU_TRUSTED_HOST:-}" ]; then
  DSH_ARGS="--profile employee --host 127.0.0.1 --port $DSH_PORT --no-open --trusted-host $KAIWU_TRUSTED_HOST"
else
  DSH_ARGS="--profile employee --host 127.0.0.1 --port $DSH_PORT --no-open"
fi

if [ -z "$KAIWU_WEB_TOKEN_SECRET_NAME" ]; then
  # 兼容未接入 Secret 的部署：保持原有前台执行方式。
  # shellcheck disable=SC2086
  exec dsh $DSH_ARGS
fi

KAIWU_NAMESPACE="${KAIWU_NAMESPACE:-$(cat /var/run/secrets/kubernetes.io/serviceaccount/namespace 2>/dev/null || true)}"
POD_NAME="${POD_NAME:-}"
SA_TOKEN_FILE="/var/run/secrets/kubernetes.io/serviceaccount/token"
SA_CA_FILE="/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
LOG_PIPE="${TMPDIR:-/tmp}/kaiwu-dsh-log.$$"
TOKEN_FILE="${TMPDIR:-/tmp}/kaiwu-web-token.$$"
export DSH_LAUNCH_TOKEN_FILE="$TOKEN_FILE"

case "$KAIWU_WEB_TOKEN_SECRET_NAME" in
  ''|*[!A-Za-z0-9._-]*)
    echo "kaiwu: KAIWU_WEB_TOKEN_SECRET_NAME contains invalid characters" >&2
    exit 1
    ;;
esac

case "$KAIWU_NAMESPACE" in
  ''|*[!A-Za-z0-9-]*)
    echo "kaiwu: KAIWU_NAMESPACE contains invalid characters" >&2
    exit 1
    ;;
esac

case "$POD_NAME" in
  ''|*[!A-Za-z0-9.-]*)
    echo "kaiwu: POD_NAME is missing or contains invalid characters" >&2
    exit 1
    ;;
esac

case "${KAIWU_INSTANCE_ID:-}" in
  *[!A-Za-z0-9.-]*)
    echo "kaiwu: KAIWU_INSTANCE_ID contains invalid characters" >&2
    exit 1
    ;;
esac

if [ -z "${KUBERNETES_SERVICE_HOST:-}" ] || [ -z "${KUBERNETES_SERVICE_PORT:-}" ]; then
  echo "kaiwu: Kubernetes API host and port are required" >&2
  exit 1
fi

for required_file in "$SA_TOKEN_FILE" "$SA_CA_FILE"; do
  if [ ! -r "$required_file" ]; then
    echo "kaiwu: Kubernetes ServiceAccount file is not readable: $required_file" >&2
    exit 1
  fi
done

rm -f "$LOG_PIPE" "$TOKEN_FILE"
mkfifo "$LOG_PIPE"
umask 077

shutdown() {
  trap - TERM INT
  kill -TERM "$DSH_PID" "$AWK_PID" "$SOCK_PID" 2>/dev/null || true
  wait "$DSH_PID" 2>/dev/null || true
  wait "$AWK_PID" 2>/dev/null || true
  rm -f "$LOG_PIPE" "$TOKEN_FILE"
  exit 1
}
trap shutdown TERM INT

# DSH 官方 CLI 不支持固定 token 或关闭 token。这里只读取启动日志中的
# token，随后立即写入 Secret，并把原日志中的 token 脱敏，避免继续泄露。
awk -v token_file="$TOKEN_FILE" '
  BEGIN { captured = 0 }
  {
    if (captured == 0 && match($0, /token=[A-Za-z0-9_-]+/)) {
      token = substr($0, RSTART + 6, RLENGTH - 6)
      print token > token_file
      close(token_file)
      captured = 1
      gsub(/token=[A-Za-z0-9_-]+/, "token=<redacted>")
    }
    print
    fflush()
  }
' < "$LOG_PIPE" &
AWK_PID=$!

# shellcheck disable=SC2086
dsh $DSH_ARGS > "$LOG_PIPE" 2>&1 &
DSH_PID=$!

elapsed=0
while [ ! -s "$TOKEN_FILE" ]; do
  if ! kill -0 "$DSH_PID" 2>/dev/null; then
    echo "kaiwu: DSH exited before publishing its web token" >&2
    shutdown
  fi

  if [ "$elapsed" -ge "$KAIWU_WEB_TOKEN_TIMEOUT" ]; then
    echo "kaiwu: timed out while waiting for the DSH web token" >&2
    shutdown
  fi

  sleep 1
  elapsed=$((elapsed + 1))
done

web_token=$(cat "$TOKEN_FILE")
payload=$(printf '{"stringData":{"webToken":"%s","podName":"%s","instanceId":"%s"}}' \
  "$web_token" "$POD_NAME" "${KAIWU_INSTANCE_ID:-}")
api_base="https://${KUBERNETES_SERVICE_HOST:-}:${KUBERNETES_SERVICE_PORT:-443}"
api_url="$api_base/api/v1/namespaces/$KAIWU_NAMESPACE/secrets/$KAIWU_WEB_TOKEN_SECRET_NAME"

if ! http_code=$(curl \
  --silent \
  --show-error \
  --connect-timeout 5 \
  --max-time 10 \
  --request PATCH \
  --header "Authorization: Bearer $(cat "$SA_TOKEN_FILE")" \
  --header "Content-Type: application/merge-patch+json" \
  --data "$payload" \
  --output /dev/null \
  --write-out "%{http_code}" \
  --cacert "$SA_CA_FILE" \
  "$api_url"); then
  echo "kaiwu: failed to call the Kubernetes API for web token publishing" >&2
  shutdown
fi

if [ "$http_code" != "200" ]; then
  echo "kaiwu: Kubernetes API rejected web token publishing with HTTP $http_code" >&2
  shutdown
fi

rm -f "$TOKEN_FILE"
echo "kaiwu: DSH web token published to Secret $KAIWU_NAMESPACE/$KAIWU_WEB_TOKEN_SECRET_NAME"

set +e
wait "$DSH_PID"
dsh_status=$?
set -e

kill -TERM "$AWK_PID" "$SOCK_PID" 2>/dev/null || true
wait "$AWK_PID" 2>/dev/null || true
rm -f "$LOG_PIPE"
exit "$dsh_status"
