#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"

# Prefer this checkout's configuration; reuse the existing local voice setup otherwise.
if [[ -z "${DSH_ENV_FILE:-}" && -z "${BAILIAN_TOKEN_PLAN_API_KEY:-}" ]]; then
  if [[ -f .env.local ]]; then
    export DSH_ENV_FILE="$PWD/.env.local"
  elif [[ -f ../dsh-realtime-voice-WITHsystem1/.env.local ]]; then
    export DSH_ENV_FILE="$PWD/../dsh-realtime-voice-WITHsystem1/.env.local"
  else
    printf '%s\n' '请先复制 .env.example 为 .env.local，填入 BAILIAN_TOKEN_PLAN_API_KEY 后重试。'
    exit 1
  fi
fi

printf '%s\n' '正在检查并构建知言…'
npm run check

cat <<'GUIDE'

检查通过，即将启动 DSH 并打开浏览器。
默认主模型：DeepSeek Pro（deepseek-v4-pro），思考关闭（Off）。
环境变量可覆盖模型；已有会话请在模型选择器确认 Pro / Off，或新建会话。
在页面中新建会话，点击输入框旁的「边写边聊」开启，然后测试：

1. 输入以下半句话，停顿几秒，不按 Enter：
   我想把聊天、日历和社区都放进第一版，一个周末上线，我还想
   预期：出现 💡 意见或吐槽，草稿保持原样，没有续写按钮。

2. 全选清空输入框。
   预期：意见和状态清空，空提示框保留。

3. 输入：我想知道当前工作区的位置，然后
   预期：停顿不会发送任务；只有按 Enter 才正式发送。

4. 有意见时按 Tab / Shift+Tab。
   预期：保持 DSH 原生行为，不插入插件文字、不发送草稿。

真实讨论会调用配置的模型并产生用量。终端按 Ctrl+C 停止服务。
GUIDE

export DSH_KEYBOARD_OPEN=1
exec node scripts/dev-dsh.mjs "$@"
