#!/usr/bin/env bash
# =============================================================================
# Node-Proxy Client - one-shot installer for Linux (issue #40)
#   * downloads the latest dev client binary (client-linux-x64 / -arm64)
#   * installs it to /opt/node-proxy
#   * writes config.yaml (server_url / auth_token / region / tags)
#   * registers + starts a systemd service: node-proxy-client
#
# Usage:
#   sudo bash docs/install.sh --server-url ws://1.2.3.4:3000/ws --token SECRET \
#        [--client-id np-node-01] [--region cn] [--tags region:cn]
#   sudo bash docs/install.sh --status | --restart | --uninstall
#
# Network: tries GitHub directly, then several public GitHub mirror prefixes,
# retrying each automatically (China-friendly).
# =============================================================================
set -euo pipefail

REPO="WAADRI/node-proxy"
TAG="dev"
INSTALL_DIR="/opt/node-proxy"
SERVICE="node-proxy-client"

# --- arguments ----------------------------------------------------------------
SERVER_URL=""
TOKEN=""
CLIENT_ID=""
REGION=""
TAGS=""
ACTION="install"

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url) SERVER_URL="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --client-id) CLIENT_ID="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --tags) TAGS="${2:-}"; shift 2 ;;
    --status) ACTION="status"; shift ;;
    --restart) ACTION="restart"; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1"; usage ;;
  esac
done

if [[ $EUID -ne 0 ]]; then echo "请用 root 或 sudo 运行"; exit 1; fi

# --- arch ---------------------------------------------------------------------
case "$(uname -m)" in
  x86_64|amd64) ASSET="client-linux-x64" ;;
  aarch64|arm64) ASSET="client-linux-arm64" ;;
  *) echo "不支持的架构: $(uname -m)（仅 x64/arm64）"; exit 1 ;;
esac

# GitHub download URL plus mirror prefixes (China-friendly). Mirrors are
# prepended in order; each attempt retries automatically.
GH="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
MIRRORS=(
  "https://ghfast.top/"
  "https://gh-proxy.com/"
  "https://ghproxy.net/"
  "https://ghproxy.cn/"
  ""
)

download_with_retry() {
  local url="$1" dest="$2"
  for attempt in 1 2 3; do
    if curl -fSL --connect-timeout 12 --retry 3 --retry-delay 2 -o "$dest" "$url"; then
      return 0
    fi
    echo "  第 ${attempt} 次尝试失败，重试..." >&2
    sleep 2
  done
  return 1
}

fetch_asset() {
  local dest="$1" ok=""
  for prefix in "${MIRRORS[@]}"; do
    local url="${prefix}${GH}"
    echo "尝试下载: ${url}"
    if download_with_retry "$url" "$dest"; then ok=1; break; fi
  done
  [[ -n "$ok" ]] || { echo "所有下载源均失败，请检查网络后重试"; exit 1; }
}

# --- status / restart / uninstall --------------------------------------------
if [[ "$ACTION" == "status" ]]; then
  systemctl status "$SERVICE" --no-pager || true
  exit 0
fi

if [[ "$ACTION" == "restart" ]]; then
  systemctl restart "$SERVICE"
  systemctl status "$SERVICE" --no-pager || true
  exit 0
fi

if [[ "$ACTION" == "uninstall" ]]; then
  systemctl stop "$SERVICE" || true
  systemctl disable "$SERVICE" || true
  rm -f "/etc/systemd/system/${SERVICE}.service"
  systemctl daemon-reload
  echo "已移除服务 $SERVICE（保留 ${INSTALL_DIR}，如需彻底删除请手动 rm -rf ${INSTALL_DIR}）"
  exit 0
fi

# --- install ------------------------------------------------------------------
if [[ -z "$SERVER_URL" || -z "$TOKEN" ]]; then
  echo "缺少参数: --server-url 与 --token 必填"
  usage
fi

echo "==> 安装目录: ${INSTALL_DIR}"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

echo "==> 下载二进制 ${ASSET} ..."
fetch_asset "${INSTALL_DIR}/node-proxy-client.tmp"
chmod +x "${INSTALL_DIR}/node-proxy-client.tmp"
mv -f "${INSTALL_DIR}/node-proxy-client.tmp" "${INSTALL_DIR}/node-proxy-client"

# config.yaml next to the binary (client reads cwd/config.yaml + __dirname/config.yaml)
echo "==> 写入 config.yaml ..."
cat > "${INSTALL_DIR}/config.yaml" <<EOF
server_url: ${SERVER_URL}
auth_token: ${TOKEN}
$( [[ -n "$REGION" ]] && echo "region: ${REGION}" )
$( [[ -n "$TAGS" ]] && echo "tags: ${TAGS}" )
EOF

echo "==> 注册 systemd 服务 ${SERVICE} ..."
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=Node-Proxy Client (node)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${INSTALL_DIR}/node-proxy-client
Restart=always
RestartSec=5
$( [[ -n "$CLIENT_ID" ]] && echo "Environment=CLIENT_ID=${CLIENT_ID}" )
Environment=CONFIG_PATH=${INSTALL_DIR}/config.yaml

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE"
systemctl restart "$SERVICE"

echo
echo "==> 安装完成。"
systemctl status "$SERVICE" --no-pager || true
echo
echo "常用命令:"
echo "  systemctl status ${SERVICE}     查看状态"
echo "  journalctl -u ${SERVICE} -f     查看日志"
echo "  sudo bash $0 --restart          重启服务"
echo "  sudo bash $0 --uninstall        卸载服务"
