# DSH Keyboard Duplex · 边写边聊

在 DSH 输入框里打字时，System 1 判断该等待、提意见、发送完整前句，还是向正在执行的任务插话。意见、可选 Tab 续写和正式回答都由当前会话选中的主模型生成。

输入 `我想知道当前工作区的位置，然后`，停顿后，前面的查询会自动进入 DSH，输入框留下 `然后`，光标停在后面。DSH 使用真实会话上下文和工具回答；继续打字并按 Enter 时，只递交剩余内容。

## 从 GitHub 安装

仓库：<https://github.com/Matcha-Eason/dsh-zhiyan>。当前插件需要配套的 DSH 原生前句提交接口，补丁已随仓库提供；包含实现、原生输入测试和对应文档。补丁基于 DSH 提交 `687f282e8625c6b8d11ff58211a90524be2e4317`，后续上游版本可能需要重新适配。

在同一个父目录下准备两个仓库（需要 Git、Node.js 22.19+ 或 24+、pnpm）：

```bash
git clone git@github.com:Matcha-Eason/dsh-zhiyan.git
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout 687f282e8625c6b8d11ff58211a90524be2e4317
git apply --check ../dsh-zhiyan/patches/dsh-submit-prefix.patch
git apply ../dsh-zhiyan/patches/dsh-submit-prefix.patch
pnpm install
pnpm run build
cd ../dsh-zhiyan
npm ci --ignore-scripts --legacy-peer-deps
npm run dev:link-dsh
npm run check
cp .env.example .env.local
```

在 `.env.local` 中填写自己的 `BAILIAN_TOKEN_PLAN_API_KEY`，然后执行 `npm run dev:dsh`，打开终端打印的链接。不要重复应用已经安装的补丁。密钥和本机运行数据不包含在仓库中。

## 本机启动

```bash
cd /Users/gyc/Desktop/TECH-playground/dsh/dsh-keyboard-duplex
DSH_ENV_FILE=../dsh-realtime-voice-WITHsystem1/.env.local npm run dev:dsh
```

打开终端打印的本地链接，默认端口 **3082**。在输入框旁开启“边写边聊”；默认关闭，按浏览器内的会话启用，刷新后需重新开启。终端按 **Ctrl+C** 停止服务。

这是独立的开发实例，使用 `.local/dsh` profile。密钥只由 Host 从环境读取，`.env.local` 和 `.local/` 不随插件发布。当前适配本机 DSH Web，使用相邻的 `../deepseek-harness` 源码构建。

**本版需要修改过的 DSH composer**：它提供 `inputActions.submitPrefix()`，统一管理前缀提交、接纳期间的 Enter、失败恢复和撤销边界。本机已完成修改与构建；只有插件代码而没有这项接口的旧 DSH 会显示 ⏸️，不会用模拟按键或覆盖整份草稿替代。完整改动见 [配套补丁](patches/dsh-submit-prefix.patch)。

首次安装依赖或修改源码后：

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm run dev:link-dsh
npm run check
```

更换 DSH 源码位置可设置 `DSH_SOURCE_ROOT`。若修改原生输入层，先在对应 DSH 目录执行 `pnpm run build`，再重建本插件、重启开发实例并刷新页面。Node.js 需要 22+。

## 四个动作

| 动作 | 行为 |
|---|---|
| `wait` | 等待更多内容，不产生主模型意见，也不发送正式消息 |
| `suggest` | 当前主模型给出具体意见、建议或温和吐槽；自然续写可选 |
| `submit_prefix` | 原文前句通过 DSH 原生提交；空闲时执行，忙碌时排队 |
| `steer` | 用户对运行中任务作出完整、明确的纠正时，通过原生插话改变方向 |

意见分支必须有 `advice`，不允许只续写。位置查询等正式任务正常回答事实。System 1 不生成给用户的回答，不调用工具；正式任务沿用 DSH 的模型选择、工具和权限设置。

插件所有由模型生成、用户可见的内容都沿用当前会话生效的 DSH 人设：包括意见、建议、反问、吐槽和可选续写。Host 通过原生提示词服务读取身份及人设前后缀，保留会话 preset 覆盖和变量插值；不再另设“思考伙伴”角色。Tab 续写仍使用用户口吻，JSON 格式、必填意见和不调用工具是该辅助任务的输出要求。人设只在生成意见时读取，不增加 `wait` 或正式提交的辅助调用。

候选使用原始文本的 UTF-16 范围；排除引号、括号和代码中的内部标点，去掉“然后”等未完成连接词结尾的候选，取最长的剩余前缀交给 System 1 判断。模型看到完整草稿、候选后缀和近期正式正文，只在固定四个动作中选择。结尾是“是否”“不对”等明显未完成表达，或出现“先别执行”等明确撤回时，先在本地等待。

自动提交要求决策模型返回至少 **0.9** 的置信度，且草稿、修订、光标、会话上下文和主模型仍匹配。这个值用于抑制低置信度自动发送，不代表经校准的准确率；语义判断仍可能出错。实际提示词在 `src/host/preview.ts`，候选边界在 `src/candidates.ts`。

## 界面和快捷键

- 开启功能后提示框常驻，空闲时保留空框，不显示等待文案；判断中用 👀。
- 清空输入框（包括只剩空白）会清掉状态、意见、续写和悬浮记录，保留提示框，取消未完成的辅助请求；迟到的结果不会恢复旧标记。开关保持原设置，已经进入 DSH 的正式任务继续执行。
- 意见就绪 **💡**；前句已接纳 **✅**；已排队 **⬆️**；递交中 ↗️。
- emoji 的含义、最近递交的前句和耗时放在悬浮提示里，并提供无障碍标签。
- **Tab** 只插入可选续写，不发送；采纳本身不立即触发自动发送。光标须在末尾、无选区、候选仍然有效。**Shift+Tab** 保持原生行为。
- **Enter** 发送当前剩余内容并取消辅助判断；**Shift+Enter** 换行。前句接纳期间的纯文本 Enter 会等待前句结果，避免重复递交。
- **Esc / ×** 清除当前意见，提示框保留；关闭“边写边聊”后隐藏提示框。输入法组词和原生菜单优先。
- 已接纳前句留在正式消息里，Cmd/Ctrl+Z 不会把它恢复成待发送草稿。未发送内容继续正常编辑。

附件、引用、斜杠交互和子会话暂不参与自动判断。原生手动提交仍可用。Agent 忙碌时暂停辅助意见，但仍可自动排队和插话。已经递交的任务由 DSH 管理；关闭开关只停止后续自动判断，不撤销已发生的操作。

递交失败时保留文字并关闭自动发送，显示 ⚠️；展开错误详情后，可检查原生会话状态，再手动发送或重新开启。连接错误可能发生在 Host 接纳之后，不自动重试。

## 建议怎么试

1. 开启功能，输入 `我想知道当前工作区的位置，然后` 并停顿。检查前句进入正式会话、输入框只剩 `然后`。
2. 接着输入 `只回复“收到”，不用执行其他操作。` 并立即 Enter。第二条用户消息应只有 `然后只回复……`。
3. 输入 `我想知道当前工作区的位置是否`，应等待，不发送。
4. 输入 `我想把第一版做成聊天、日历、社区和支付一体的应用，`，应出现 💡 意见；续写可以没有。
5. DSH 正在搜索时，输入 `等等，只查 src 目录，` 并停顿，测试原生插话。插话不能撤销已经执行过的工具操作。

## 触发与成本

普通停顿约 800 ms，标点前缀稳定约 300 ms 后可提前判断。同一草稿不定时重复询问；每会话保留一个在途判断和最新待处理快照。

System 1 最短间隔 750 ms、每分钟最多 40 次；辅助主模型意见保持最短间隔 5 秒、每分钟最多 6 次。客户端和 Host 同时限频。正式 DSH 执行不受意见频率限制，接纳顺序由原生提交层管理。

最多读取 8,000 字草稿和近期 6 条正式消息正文（每条最多 1,200 字），不把工具日志和隐藏推理加入辅助请求。意见硬上限 600 字、续写 400 字，辅助输出预算 1,200 tokens。性能详情保留在状态悬浮提示和 Host 指标日志中；不记录完整未发送草稿。

Host 配置：`decisionCredential` 默认 `BAILIAN_TOKEN_PLAN_API_KEY`；`decisionTimeoutMs` 默认 4,000；`mainTimeoutMs` 默认 20,000；`submissionConfidence` 默认 0.9。主模型始终跟随 DSH 会话选择。开发实例默认主模型为 `deepseek-v4.1-flash`，System 1 为 `decision-model-preview`；可用 `DSH_KEYBOARD_MAIN_MODEL` 和 `DSH_KEYBOARD_PORT` 覆盖开发默认值。

Token Plan provider 的 `compat` 需要 `thinkingFormat: qwen` 和 `supportsDeveloperRole: false`，开发启动器已经包含；不要改成固定备用模型规避兼容问题。

“只发剩余内容”减少的是重复用户消息。正式请求仍包含 DSH 需要的历史上下文，是否节省缓存或总 token 取决于供应商；本版不迁移 KV，也不把辅助意见冒充正式回复。

## 验证与设计

`npm run check` 包含类型检查、行为/Host 测试和构建。实测与限制见 [VALIDATION.md](VALIDATION.md)，设计演进见 [四动作修改计划](docs/SYSTEM1_ACTIONS_PLAN.md)。
