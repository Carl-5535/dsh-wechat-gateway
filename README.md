# dsh-wechat-gateway

[![CI](https://github.com/Carl-5535/dsh-wechat-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/Carl-5535/dsh-wechat-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-07c160.svg)](https://github.com/Carl-5535/dsh-wechat-gateway/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](https://nodejs.org/)

把个人微信变成 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) Agent 的远程入口——手机微信发消息，本机 Agent 干活，回复送回微信。

插件以 Cordis 插件形式运行在 DSH Host 进程内，每个微信聊天对应一个持久会话，可在 Web UI 同时查看和接管。

<p align="center"><img src="assets/weixin_login.png" alt="在 DSH 侧边栏扫码连接微信" width="360"></p>

## 特性

- **扫码即用** — 侧边栏内直接扫码，全程不离开主页
- **持久会话** — 每个聊天对应一个 DSH 会话，重启自动 resume，`/new` 随时重开
- **文件双向** — 微信附件落盘到工作区并喂给模型；Agent 用 `[[send-file:路径]]` 回发，正文提及的工作区文件自动回发（realpath 防越界，单条最多 5 个）
- **工作目录** — 侧边栏弹窗内置目录选择器，可视化浏览并切换 Agent 工作目录，运行时立即生效并持久化
- **微信审批** — 越权操作审批直达微信，回复「同意/拒绝」即可，回复「网页」转交 Web UI 面板
- **权限模式** — `/permission` 切换预设（`workspace-write` ↔ `danger-full-access`），立即生效
- **主动推送** — `wechat_notify` 工具让任何 DSH 会话都能主动推送消息到你的微信
- **可靠投递** — 回复经持久化发件箱分块发送，超长切分、失败重试、重启续发
- **安全默认** — 默认拒绝一切来源，未配置白名单时仅响应登录账号本人

## 快速开始

```shell
# 1. 安装
npm i -g @deepseek-ai/dsh
dsh plugin --profile web add "github:Carl-5535/dsh-wechat-gateway#main"

# 2. 启动（默认 http://127.0.0.1:3080）
dsh web

# 3. 侧边栏底部「微信」入口 → 手机微信扫码
# 4. 用你自己的微信给机器人账号发消息即可
```

> **pnpm ≥ 10** 需要显式允许 git 插件构建脚本。安装报 `ERR_PNPM_GIT_DEPARE_NOT_ALLOWED` 时，在 profile 目录（默认 `~/.dsh/profiles/web/`）的 `pnpm-workspace.yaml` 添加 `onlyBuiltDependencies: [dsh-wechat-gateway]` 后重试。

> **Windows** 本地开发用反斜杠绝对路径（`D:\path\to\dsh-wechat-gateway`），不要写 `file:D:/...`。macOS / Linux 用 `file:/绝对路径`。

也支持不装全局 CLI：把 `dsh` 换成 `npx @deepseek-ai/dsh`。

## 微信命令

| 命令 | 作用 |
| --- | --- |
| `/help` `/帮助` | 查看说明 |
| `/status` `/状态` | 查看会话状态 |
| `/stop` `/停止` | 中止当前任务 |
| `/new` `/新会话` | 丢弃上下文，开启新会话 |
| `/model` `/模型` | 查看/切换模型（序号、模型 id 或 `provider/model`，仅当前聊天生效） |
| `/permission` `/权限` | 查看/切换权限模式（序号、名称或中文别名，立即生效） |

其余消息作为用户输入交给 Agent 处理。凭据约 24 小时过期（腾讯策略），到期后侧边栏入口变灰，重新扫码即可。

## 审批与权限

Agent 在 `workspace-write` 模式下越界操作时触发审批：

- 审批问题先只送达微信，回复认可词（同意/允许/yes）放行当次操作，拒绝词（拒绝/no）驳回
- 回复「网页」转交 Web UI 审批面板（面板待审批项只能由浏览器响应或任务中止清除，不会两侧同时挂起）
- 通道失效或任务中止时自动转交/撤销，不会无人应答
- 待审批期间发送其他消息照常处理，附带待办提醒

`/permission` 使用 DSH 官方 `permissionPresets` 服务：

- **workspace-write**：工作区可写，越界需审批（默认）
- **danger-full-access**：完全访问，不弹审批

切换写入会话事件日志，立即生效，Web UI 同步显示；`/new` 后回到默认。

## 主动推送

扫码登录后 `wechat_notify` 工具对所有 Agent 会话可用，推送目标为扫码账号：

- 编译/测试跑完通知结果、定时任务推送日报、长任务关键节点汇报
- 未登录时返回明确错误；超长自动分块、带重试、60 秒超时
- 微信会话内正常回复自动送达，无需此工具

## 安全模型

**任何能给登录账号发微信消息的人，都在向你的 Agent 下达指令。** 因此默认拒绝一切来源：

- 未配置白名单时仅响应登录账号本人（扫码凭据自动进白名单）
- Agent 默认 `workspace-write`（越界需审批），出站文件 realpath 校验锁定在工作区内
- 凭据与状态文件 600 权限落盘，登录路由仅限本机回环
- 微信通道条款禁止营销、客服、高频群发用途

## 配置

所有配置均可通过环境变量覆盖：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WECHAT_BOT_TOKEN` | — | 直接注入 token（优先于凭据文件） |
| `WECHAT_CREDENTIAL_PATH` | `$DSH_HOME/wechat-gateway/account.json` | 凭据文件 |
| `WECHAT_STATE_PATH` | `$DSH_HOME/wechat-gateway/state.json` | 网关状态文件 |
| `WECHAT_WORKSPACE` | 用户主目录 | Agent 工作区（cwd + 文件边界） |
| `WECHAT_ALLOWED_USERS` | 登录账号本人 | 用户白名单，逗号分隔 |
| `WECHAT_MEDIA_DIR` | `$WORKSPACE/.wechat-gateway/inbox` | 入站媒体目录 |
| `WECHAT_BOT_API_BASE` | `https://ilinkai.weixin.qq.com` | iLink API 入口 |
| `WECHAT_CDN_BASE` | `https://novac2c.cdn.weixin.qq.com/c2c` | 媒体 CDN |
| `WECHAT_MAX_MESSAGE_CHARS` | `3500` | 单条回复最大字符数 |
| `WECHAT_MAX_MEDIA_BYTES` | `104857600` | 单个媒体大小上限 |
| `WECHAT_AUTO_SEND_FILES` | `true` | 正文提及的工作区文件自动回发（`0/false` 关闭） |

## 架构

```
手机微信 ⇄ iLink Bot API ⇄ ┌─ dsh web (Host 进程) ─────────────┐
                            │  wechat-gateway 插件 (Cordis)      │
                            │   ├─ ILinkClient  长轮询/发送/媒体  │
                            │   ├─ WechatGateway 会话映射+投递    │
                            │   ├─ wechat_notify 主动推送         │
                            │   └─ 登录路由 + 侧边栏 UI           │
                            │  agents.create/resume → DSH Agent  │
                            └────────────────────────────────────┘
```

入站 `getupdates` 长轮询 → 去重 → 白名单 → 命令解析或 `agent.followup()`。出站 `turn/end` → 提取文本 → 持久化 outbox → 分块投递。chatId→sessionId 映射、轮询游标、去重表、发件箱断点全部落盘可续跑。

## 开发

```shell
npm install
npm run typecheck   # 类型检查
npm test            # 65 个单元测试
npm run build       # 产出 lib/（含客户端 bundle）
```

## 已知限制

- 凭据有效期约 24 小时（腾讯策略），到期需重新扫码
- 腾讯可能随时调整协议端点；微信条款禁止营销、客服、高频群发
- 每个聊天内消息串行处理，多聊天之间并行

## 致谢与许可

[MIT License](https://github.com/Carl-5535/dsh-wechat-gateway/blob/main/LICENSE) 开源。独立实现，部分设计衍生自社区 MIT 实现：iLink 协议层与投递队列参考 [dsh-weixin](https://github.com/xiaoshihou514/dsh-weixin)，协议细节与 [dsh-wechat-bridge](https://github.com/gtaifu/dsh-wechat-bridge) 及官方 SDK 交叉验证。完整第三方声明见 [LICENSE](https://github.com/Carl-5535/dsh-wechat-gateway/blob/main/LICENSE#third-party-notices)。
