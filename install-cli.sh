#!/usr/bin/env bash
#
# errAnalyst CLI 安装脚本
# 用法:
#   ./install-cli.sh          安装 erranalyst 命令
#   ./install-cli.sh uninstall  卸载 erranalyst 命令
#
# 说明: VS Code 安装 VSIX 时不会把扩展的 bin 添加到 PATH。
# 本脚本会在 ~/.local/bin 生成一个动态 wrapper，
# 每次执行时自动定位最新安装的 errAnalyst 扩展目录，
# 因此扩展升级后无需重新运行本脚本。

set -euo pipefail

INSTALL_DIR="${ERRANALYST_INSTALL_DIR:-$HOME/.local/bin}"
WRAPPER="$INSTALL_DIR/erranalyst"
MARKER_BEGIN="# >>> errAnalyst CLI >>>"
MARKER_END="# <<< errAnalyst CLI <<<"

pick_rc() {
  case "${SHELL##*/}" in
    zsh) [ -f "$HOME/.zshrc" ] && echo "$HOME/.zshrc" || echo "$HOME/.zprofile" ;;
    bash) [ -f "$HOME/.bashrc" ] && echo "$HOME/.bashrc" || echo "$HOME/.bash_profile" ;;
    *) [ -f "$HOME/.zshrc" ] && echo "$HOME/.zshrc" || echo "$HOME/.bashrc" ;;
  esac
}

find_extension_dir() {
  local base cand
  for base in "$HOME/.vscode/extensions" "$HOME/.vscode-insiders/extensions" "$HOME/.cursor/extensions"; do
    cand="$(ls -dt "$base/errAnalyst.err-analyst-"*/ 2>/dev/null | head -1)"
    if [ -n "$cand" ]; then
      printf '%s' "$cand"
      return 0
    fi
  done
  return 1
}

write_wrapper() {
  cat > "$WRAPPER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
EXT_DIR=""
for base in "$HOME/.vscode/extensions" "$HOME/.vscode-insiders/extensions" "$HOME/.cursor/extensions"; do
  cand="$(ls -dt "$base/errAnalyst.err-analyst-"*/ 2>/dev/null | head -1)"
  if [ -n "$cand" ]; then EXT_DIR="$cand"; break; fi
done
if [ -z "$EXT_DIR" ]; then
  echo "errAnalyst: 未找到已安装的扩展，请先在 VS Code 中安装 err-analyst-*.vsix" >&2
  exit 1
fi
exec node "${EXT_DIR}bin/erranalyst" "$@"
EOF
  chmod +x "$WRAPPER"
}

add_to_path() {
  local rc="$1"
  if grep -qF "$MARKER_BEGIN" "$rc" 2>/dev/null; then
    return 0
  fi
  {
    echo ""
    echo "$MARKER_BEGIN"
    echo "export PATH=\"$INSTALL_DIR:\$PATH\""
    echo "$MARKER_END"
  } >> "$rc"
  printf '已将 PATH 配置写入 %s，新开终端后生效（当前终端可先执行: source %s）\n' "$rc" "$rc"
}

remove_from_path() {
  local rc="$1"
  if [ -f "$rc" ]; then
    sed -i.bak "/^$MARKER_BEGIN\$/,/^$MARKER_END\$/d" "$rc" && rm -f "$rc.bak"
  fi
}

cmd_install() {
  if ! find_extension_dir >/dev/null 2>&1; then
    echo "警告: 未检测到已安装的 errAnalyst 扩展，建议先安装 VSIX 再运行本脚本。" >&2
  fi
  mkdir -p "$INSTALL_DIR"
  write_wrapper
  echo "已安装 CLI 到 $WRAPPER"
  add_to_path "$(pick_rc)"
  echo "安装完成，运行: erranalyst help"
}

cmd_uninstall() {
  rm -f "$WRAPPER"
  remove_from_path "$(pick_rc)"
  echo "已卸载 erranalyst 命令（扩展本体不受影响）。"
}

case "${1:-install}" in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  *) echo "用法: $0 [install|uninstall]" >&2; exit 1 ;;
esac
