# 知言 · 边写边聊

在 DSH 输入框里写想法时，主模型提前给出意见、反问或温和吐槽。System 1 只判断是否适合讨论；正式任务由用户按 Enter 或点击发送后交给 DSH。

例如输入 `我想把聊天、日历和社区都放进第一版，一个周末上线，我还想`，稍作停顿即可获得收缩范围等意见，整份草稿留在输入框中。输入 `我想知道当前工作区的位置，然后` 也不会自动发送前句。

## 0.2.1 当前行为

- 移除前句自动提交、自动排队和运行中自动改向；没有保留自动发送开关。
- 0.2.1 移除续写生成、Tab 采纳及采纳按钮；Tab / Shift+Tab 保持原生行为。
- 保留必填意见、DSH 人设继承、常驻提示框和清空取消。
- 不再依赖 `submitPrefix()` 或 DSH 原生前句补丁，仓库停止分发该补丁。已经安装补丁的 DSH 也可使用，插件不会调用其接口。
- 旧 `submissionConfidence` 配置已移除。更新插件后重建并重启 Host、刷新页面，确保客户端也加载新版。

## 从 GitHub 安装

仓库：[Matcha-Eason/dsh-zhiyan](https://github.com/Matcha-Eason/dsh-zhiyan)。需要 Git、Node.js 22.19+ 或 24+、pnpm；当前 SDK 适配基于 DSH `0.2.1-rc.2` 源码提交 `687f282e8625c6b8d11ff58211a90524be2e4317`。

```bash
git clone git@github.com:Matcha-Eason/dsh-zhiyan.git
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout 687f282e8625c6b8d11ff58211a90524be2e4317
pnpm install
pnpm run build
cd ../dsh-zhiyan
npm ci --ignore-scripts --legacy-peer-deps
npm run dev:link-dsh
npm run check
cp .env.example .env.local
```

在 `.env.local` 中填写 `BAILIAN_TOKEN_PLAN_API_KEY`，然后运行 `npm run dev:dsh`，打开终端打印的链接。已有配置保留，不要覆盖密钥文件。当前版本无需执行 `git apply`。

## 本机启动

```bash
cd /Users/gyc/Desktop/TECH-playground/dsh/dsh-keyboard-duplex
DSH_ENV_FILE=../dsh-realtime-voice-WITHsystem1/.env.local npm run dev:dsh
```

默认端口 **3082**；开启输入框旁的“边写边聊”。默认关闭，按浏览器内会话启用，刷新后需重新开启。终端按 **Ctrl+C** 停止服务。修改源码后先执行 `npm run check`，再重启并刷新。

开发实例用 `.local/dsh` 保存独立 profile，默认读取相邻 `../deepseek-harness` 的构建。`DSH_SOURCE_ROOT`、`DSH_KEYBOARD_PORT`、`DSH_KEYBOARD_MAIN_MODEL` 可覆盖路径、端口和默认主模型。当前仅适配本机 DSH Web。

## 判断与生成

| 动作 | 行为 |
|---|---|
| `wait` | 意图不足、纯执行请求或没有新意见时保持安静 |
| `suggest` | 当前主模型给一条具体意见、建议、反问或温和吐槽 |

输出只包含必填的 `advice`，不生成续写。句子还没写完，只要已有讨论价值就可以给意见。“先别执行”也不阻止讨论已经表达的想法。

System 1 使用百炼 Token Plan `decision-model-preview`，不生成用户可见回答。辅助主模型沿用当前会话选择、推理等级和生效的 DSH 身份/人设，禁用工具。意见使用助手口吻。主模型格式错误或调用失败会显示错误，不切换备用模型。

草稿会传给 System 1 和选定模型服务分析；密钥仅由 Host 读取。辅助上下文为最近 6 条正式正文，每条最多 1,200 字，不含工具日志和隐藏推理。草稿最多 8,000 字，意见最多 600 字，辅助输出预算 1,200 tokens。

## 界面与快捷键

- 开启后提示框常驻；空闲无文案，判断中 👀，意见就绪 💡，错误 ⚠️，暂不可用 ⏸️。耗时在悬浮提示中。
- **Tab / Shift+Tab**：保持 DSH 原生行为，插件不拦截、不插入文字。
- **Enter / 原生发送按钮**：发送当前完整草稿，由 DSH 原生处理。**Shift+Enter** 换行；输入法和原生菜单优先。
- **Esc / ×**：清掉意见，保留提示框。清空草稿还会清除状态与耗时，取消在途辅助请求，迟到结果不会重新出现。
- 退格、会话切换、模型切换使相关旧结果失效。只追加文字时可以保留较早意见。关闭功能隐藏提示框。
- 正式任务运行中暂停讨论，不请求新的判断；用户仍可通过 DSH 原生方式手动追加任务或改向。

附件、引用、斜杠交互和子会话暂不参与自动讨论；没有焦点、光标不在末尾、有选区或正在组词时不发起新预览。

## 建议怎么试

1. 输入 `我想把第一版做成聊天、日历和社区一体的应用，一个周末上线，我还想`，不回车，观察 💡 意见，草稿保持原样。
2. 清空后输入 `我想知道当前工作区的位置，然后`，停顿几秒：全文仍在输入框，正式会话没有新增消息。按 Enter 后才执行。
3. 意见出现后按 Tab / Shift+Tab，检查保持原生行为，没有插入插件文字或发送草稿。
4. 意见生成途中清空输入，检查迟到意见不会复活。
5. 正式任务运行时输入 `等等，只查 src 目录，`，停顿不会改向；需要用户手动发送。

## 调度与配置

普通停顿约 800 ms；标点前的稳定片段至少八字符时，可在 300 ms 后提前评估。每会话只保留一个在途请求和最新快照，同一草稿不轮询。决策请求最短间隔 750 ms、每分钟最多 40 次；主模型意见最短间隔 5 秒、每分钟最多 6 次。被限频的草稿需继续编辑才会重新评估。

Host 配置：`decisionCredential` 默认 `BAILIAN_TOKEN_PLAN_API_KEY`；`decisionTimeoutMs` 默认 4,000；`mainTimeoutMs` 默认 20,000。开发实例默认主模型 `deepseek-v4.1-flash`，可在 DSH 里切换。Token Plan provider 的兼容项由启动器设置，辅助请求始终跟随会话模型。

辅助意见不写入正式对话；用户发送时仍提交完整草稿，本版不提供前句去重或 KV 接续，也不承诺节省总 token。System 1 用量未纳入 DSH 底部原生统计。

## 文档与验证

- [技术方案](docs/TECHNICAL_DESIGN.md)：架构、判断逻辑、提示词原文及探索方向。
- [双工场景案例库](docs/DUPLEX_SCENARIOS.md)：公开语音数据、MOSS-Live 参考、38 条语音/键盘/探索案例。
- [验证记录](VALIDATION.md)：当前检查及标注版本的历史实测。

`npm run check` 执行类型检查、行为/Host 测试与构建。构建产物、密钥、运行日志和截图均不提交 Git。
