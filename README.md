# 知言 · 边写边聊

在 DSH 输入框里写想法时，DeepSeek Pro 提前给出意见、反问或温和吐槽。JEV 只判断讨论时机；正式任务由用户按 Enter 或点击发送后交给 DSH。插件不自动提交半句话，不改写草稿，也不提供 Tab 续写。

例如输入 `我想把聊天、日历和社区都放进第一版，一个周末上线，我还想`，稍作停顿即可获得范围取舍等意见，整份草稿留在输入框中。

## 0.3.0：只填两个官方 API Key

打开 **DSH 设置 → 模型 → 知言 · 边写边聊**，分别填入并保存：

| 输入项 | 固定服务与模型 | 用途 |
|---|---|---|
| DeepSeek 官方 API Key | `api.deepseek.com` · `deepseek-v4-pro` · **Off** | 生成全部意见、建议、反问和吐槽 |
| JEV 官方 API Key | `api.typesafe.ai/v1/systemone` · `jev-latest` | 选择 `wait` 或 `suggest`，不生成回答 |

[DeepSeek API Key](https://platform.deepseek.com/api_keys)；[JEV / TypeSafe 官方文档](https://docs.typesafe.ai/api/system-one)。JEV 使用 TypeSafe 官方服务，不使用名称相似的第三方中转站。

只有两个密码输入框，模型、地址、推理等级、超时与限频均由插件固定，无需填写。保存后下次请求生效，不需要重启；保存只是记录密钥，不调用模型或验证余额。页面支持替换和移除密钥，已有值不回显。密钥存入 DSH 本机凭据库，不写入插件配置或 Git；默认本机凭据文件仅当前系统用户可读。

**升级变化：** 移除百炼依赖、旧 `decisionCredential` / 超时配置及 `DSH_KEYBOARD_MAIN_MODEL` 覆盖。旧 Token Plan Key 不会迁移或发送给官方服务，需在上述界面填写两个官方 Key。辅助意见独立于聊天窗口选择的模型，仍继承当前 DSH 会话的人设。正式对话的模型选择保持 DSH 原生逻辑。

## 从 GitHub 安装

仓库：[Matcha-Eason/dsh-zhiyan](https://github.com/Matcha-Eason/dsh-zhiyan)。需要 Git、Node.js 22.19+ 或 24+、pnpm；SDK 适配基于 DSH `0.2.1-rc.2` 源码提交 `687f282e8625c6b8d11ff58211a90524be2e4317`。

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
./quick-test.command
```

已有 checkout 更新后也执行安装、链接和快速测试三步，以取得新增的 DSH 原生 DeepSeek 适配器和模型设置扩展类型。无需修改 DSH 核心或应用前句补丁。

## 快速测试与启动

macOS Finder 双击 `quick-test.command`，或在任意终端运行：

```bash
/Users/gyc/Desktop/TECH-playground/dsh/dsh-keyboard-duplex/quick-test.command
```

脚本先执行类型检查、测试和构建，再启动 DSH 并打开浏览器，终端显示四个测试场景。首次启动在设置里保存两个 Key，再开启输入框旁的“边写边聊”。脚本不要求 `.env` 密钥，也不读取相邻语音项目的密钥。真实讨论会产生模型用量。

仅启动、不自动打开浏览器：

```bash
cd /Users/gyc/Desktop/TECH-playground/dsh/dsh-keyboard-duplex
npm run dev:dsh
```

默认端口 **3082**，按 **Ctrl+C** 停止。修改源码后执行 `npm run check`，重启并刷新页面。

开发实例使用 `.local/dsh` 独立 profile，默认读取 `../deepseek-harness` 的构建。可通过 `DSH_SOURCE_ROOT`、`DSH_KEYBOARD_PORT` 改路径和端口；可选 `.env.local` 仅用于这些启动设置。启动器为新会话设置“DeepSeek Pro · 知言 / Off”，使用知言里保存的 DeepSeek Key；已有会话的显式模型选择保留。插件接入其他 DSH 实例时不改变宿主默认模型。

## 判断与生成

| 动作 | 行为 |
|---|---|
| `wait` | 意图不足、纯执行请求或没有新意见时保持安静 |
| `suggest` | DeepSeek Pro 给一条具体意见、建议、反问或温和吐槽 |

主模型只输出必填的 `advice`。句子没写完，只要已有讨论价值就可给意见；“先别执行”也不阻止讨论。意见以助手口吻沿用 DSH 身份、人设和语言设定，禁用工具。失败显示错误，不切换备用模型或第三方服务。

主模型复用 DSH 原生 DeepSeek Messages 适配器，请求固定发往 `https://api.deepseek.com/anthropic/v1/messages`，显式 `thinking: { type: "disabled" }`。辅助输出上限 1,200 tokens、temperature 0.7、总超时 30 秒；JEV 超时 4 秒。两路都不自动重试。可供正式聊天选择的知言 provider 默认输出上限为 8,192 tokens，仅提供 Pro / Off。

草稿会传给 JEV 和 DeepSeek 官方分析。辅助上下文只取最近 6 条正式正文，每条最多 1,200 字，不含工具日志或隐藏推理；草稿最多 8,000 字，意见最多 600 字。

## 界面与快捷键

- 默认关闭，按浏览器内会话启用，刷新后需重新开启。开启后提示框常驻：空闲无文案、判断中 👀、意见 💡、错误 ⚠️、暂不可用 ⏸️。耗时在悬浮提示中。
- **Tab / Shift+Tab** 保持原生行为，插件不拦截、不插入文字。
- **Enter / 原生发送按钮** 发送完整草稿；**Shift+Enter** 换行。输入法和原生菜单优先。
- **Esc / ×** 清意见，保留提示框；清空草稿另清状态与耗时并取消在途请求。
- 退格、会话上下文变化使旧结果失效；只追加文字可保留较早意见。更换或移除 Key 取消在途预览，继续编辑后重新请求。
- 正式任务运行时暂停讨论，用户仍可手动追加任务或改向。

附件、引用、斜杠交互和子会话不参与讨论。无焦点、光标不在末尾、有选区或正在组词时不发起新预览。

## 建议怎么试

1. 输入 `我想把聊天、日历和社区都放进第一版，一个周末上线，我还想`，不回车，观察 💡 意见与完整草稿。
2. 清空后输入 `我想知道当前工作区的位置，然后`，停顿不发送，按 Enter 后才执行。
3. 意见出现后按 Tab / Shift+Tab，检查没有插入插件文字或发送。
4. 意见生成途中清空输入，检查迟到意见不会复活。

## 调度与边界

普通停顿约 800 ms；标点前稳定片段至少八字符时，可在 300 ms 后评估。每会话只保留一个在途请求和最新快照，同一草稿不轮询。JEV 请求最短间隔 750 ms、每分钟最多 40 次；主模型意见最短间隔 5 秒、每分钟最多 6 次。被限频后继续编辑再评估。

辅助意见不写入正式对话，发送时提交完整草稿。无前句去重或 KV 接续，不承诺节省总 token。JEV 用量未纳入 DSH 底部原生统计。当前仅适配本机 DSH Web，语音项目独立维护。

## 文档与验证

- [技术方案](docs/TECHNICAL_DESIGN.md)：架构、判断逻辑、提示词原文与探索方向。
- [双工场景案例库](docs/DUPLEX_SCENARIOS.md)：38 条语音、键盘和探索案例。
- [验证记录](VALIDATION.md)：当前检查及标注版本的历史实测。

`npm run check` 执行类型检查、行为/Host 测试与构建。构建产物、密钥、日志和截图均不提交 Git。
