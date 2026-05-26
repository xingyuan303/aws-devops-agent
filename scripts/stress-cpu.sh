#!/bin/bash
#
# 在 EC2 实例上压测 CPU，把 CPU 利用率打到 ~95%
# 适用于 Amazon Linux 2/2023、Ubuntu、其他主流发行版
#
# 用法（在目标 EC2 上执行）：
#   curl -fsSL https://your-bucket/stress-cpu.sh | bash
#   或
#   ./stress-cpu.sh                    # 默认运行 10 分钟
#   ./stress-cpu.sh 5                  # 运行 5 分钟
#   ./stress-cpu.sh 0                  # 一直运行（按 Ctrl+C 停止）
#
# 工作方式：
#   - 按 CPU 核心数启动相应数量的 stress 进程
#   - 如果系统未安装 stress，会尝试自动安装
#   - 如果无法安装，会用纯 bash 死循环作为 fallback
#
# English version: stress-cpu.en.sh 
#
 

set -e

DURATION_MIN="${1:-10}"
DURATION_SEC=$((DURATION_MIN * 60))
CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1)

G="\033[0;32m"
Y="\033[1;33m"
R="\033[0;31m"
N="\033[0m"

echo -e "${G}▶ EC2 CPU 压测脚本${N}"
echo "  CPU 核心数: ${CORES}"
if [ "${DURATION_MIN}" -eq 0 ]; then
  echo "  运行时长:   ∞ (按 Ctrl+C 停止)"
else
  echo "  运行时长:   ${DURATION_MIN} 分钟"
fi
echo

# 优雅退出处理
cleanup() {
  echo
  echo -e "${Y}收到停止信号，正在终止压测进程...${N}"
  pkill -P $$ 2>/dev/null || true
  echo -e "${G}已停止${N}"
  exit 0
}
trap cleanup INT TERM

# 检测/安装 stress 工具
install_stress() {
  if command -v stress >/dev/null 2>&1; then
    return 0
  fi

  echo -e "${Y}未检测到 stress 工具，尝试自动安装...${N}"

  if command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y stress-ng || sudo dnf install -y stress || return 1
  elif command -v yum >/dev/null 2>&1; then
    sudo amazon-linux-extras enable epel >/dev/null 2>&1 || true
    sudo yum install -y epel-release >/dev/null 2>&1 || true
    sudo yum install -y stress 2>/dev/null || sudo yum install -y stress-ng 2>/dev/null || return 1
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y >/dev/null
    sudo apt-get install -y stress 2>/dev/null || sudo apt-get install -y stress-ng 2>/dev/null || return 1
  else
    return 1
  fi

  return 0
}

# 用 stress / stress-ng 压测
run_stress() {
  local timeout_arg=""
  if [ "${DURATION_SEC}" -gt 0 ]; then
    timeout_arg="--timeout ${DURATION_SEC}s"
  fi

  if command -v stress >/dev/null 2>&1; then
    echo -e "${G}▶ 使用 stress 压测 ${CORES} 个核心${N}"
    if [ "${DURATION_SEC}" -gt 0 ]; then
      stress --cpu "${CORES}" --timeout "${DURATION_SEC}s"
    else
      stress --cpu "${CORES}"
    fi
  elif command -v stress-ng >/dev/null 2>&1; then
    echo -e "${G}▶ 使用 stress-ng 压测 ${CORES} 个核心${N}"
    if [ "${DURATION_SEC}" -gt 0 ]; then
      stress-ng --cpu "${CORES}" --cpu-load 95 --timeout "${DURATION_SEC}s"
    else
      stress-ng --cpu "${CORES}" --cpu-load 95
    fi
  else
    return 1
  fi
}

# Fallback: 纯 bash 死循环（无需安装任何包）
run_bash_loop() {
  echo -e "${Y}▶ Fallback: 用纯 bash 启动 ${CORES} 个 CPU 密集进程${N}"

  for i in $(seq 1 "${CORES}"); do
    (
      # busy loop
      while :; do
        : $((1+1))
      done
    ) &
  done

  if [ "${DURATION_SEC}" -gt 0 ]; then
    echo -e "${G}已启动，将在 ${DURATION_MIN} 分钟后自动结束${N}"
    sleep "${DURATION_SEC}"
    pkill -P $$ 2>/dev/null || true
  else
    echo -e "${G}已启动，按 Ctrl+C 停止${N}"
    wait
  fi
}

# 主流程
if install_stress && run_stress; then
  echo -e "${G}✅ 压测完成${N}"
else
  echo -e "${Y}stress 工具不可用，使用 bash 循环${N}"
  run_bash_loop
  echo -e "${G}✅ 压测完成${N}"
fi

echo
echo -e "${G}请观察以下内容：${N}"
echo "  • 在 EC2 控制台看 CPU 利用率指标（应该接近 95%）"
echo "  • 等待你配置的 CPU 告警进入 ALARM 状态"
echo "  • 飞书群组收到 RCA 卡片（约 30 秒 - 2 分钟）"
