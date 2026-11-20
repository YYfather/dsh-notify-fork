# dsh-notify-fork

本地 fork，基于 `dsh-notify-plugin` 1.5.4，加了两件事：

1. **按工作区分层推送**（`lib/routes.js` 新增 + `lib/service.js` 分发改造）
2. **`/detail` 命令**：在企业微信/微信/Telegram 里拉取当前会话最近一轮详情

> ⚠️ 只改了 `lib/*.js`（运行时），`src/*.ts` 未同步。上游更新时要重新对齐，
> 或把这里的改动回灌到 src。测试覆盖在 `test/`（`node --test test/*.test.mjs`）。

## 配置：`<DSH_HOME>/notify/routes.json`

Windows 上是 `C:\Users\<你>\.dsh\notify\routes.json`。没有这个文件时行为与原版完全一致
（单个智能机器人、全量详情），所以可以先部署再慢慢配。

```jsonc
{
  "aibots": [
    { "id": "main",  "botId": "aib...", "secret": "...", "toChatIds": [] },
    { "id": "paper", "botId": "aib...", "secret": "...", "toChatIds": [] }
  ],
  "workspaceRoutes": {
    "*":                     { "mode": "status" },              // 默认：只报状态
    "D:\\paper":             { "mode": "full", "bot": "paper" }, // 重要工作区：独立机器人 + 详情
    "E:\\code\\api":         { "mode": "off" }                 // 静音
  }
}
```

字段：

- `mode`：`status`（只报状态：步数/工具数/耗时 + 会话标题）/ `full`（原样：💬 + 🤖）/ `off`（不推）
- `bot`：哪个 `aibots` 条目接收。缺省 `main`
- 匹配顺序：**完整路径** → **目录名** → `*`

行为：

- 独立机器人只收自己工作区的消息，按它配置的 mode 渲染
- 主机器人在被独立机器人接管的工作区上只发一行 `↗ 已完成，详情见「paper」机器人`
- 系统通知 / webhook / 微信 / Telegram 不受路由影响，仍收全量

## 部署

```bash
bash scripts/deploy.sh
```

把本目录整体覆盖到 `~/.dsh/profiles/desktop/node_modules/dsh-notify-plugin`，
首次覆盖前会把原版备份到 `~/.dsh/backups/dsh-notify-plugin-<时间戳>`。**改完要重启 DSH 生效。**

## 回滚

```bash
rm -rf ~/.dsh/profiles/desktop/node_modules/dsh-notify-plugin
cp -r ~/.dsh/backups/dsh-notify-plugin-<时间戳> ~/.dsh/profiles/desktop/node_modules/dsh-notify-plugin
```
或直接 `npm i dsh-notify-plugin@1.5.4` 重装。

## 附带的两个修复

- `basenameOf()` 兼容 Windows 反斜杠：原来 `cwd.split('/')` 在 Windows 上会把整条路径
  当成目录名，标题变成 `✅ [E:\studywork\DSHwork] 对话完成`
- `details.cwd` 进了 metadata，路由可以按完整路径精确匹配
## 工作区推送开关（两层）

### A. 聊天命令 `/push`

```
/push                     → 列出所有工作区 + 当前级别
/push 2 off               → 关掉 2 号工作区的推送
/push 2 status            → 只报状态
/push 2 full              → 完整详情
/push 2 default           → 删掉覆盖，回到 "*" 默认
/push * off               → 全部关掉
```

写入 `<DSH_HOME>/notify/routes.json`，**下一条通知立即生效**（发送路径按文件 mtime 缓存重读，不用重启）。

### B. 设置页「工作区推送」

DSH 设置 → 通知，第二块就是：每个工作区一行，下拉选 `只报状态 / 完整详情 / 不推送 / 恢复默认`。
和 A 写的是同一个文件；改完即时生效、不需要点保存。

RPC：`notify.workspace-routes.get` / `notify.workspace-routes.set`（`lib/notify-rpc.js` ↔ `src/client/rpc.ts` 两处常量必须同步）。

### 构建说明

npm 包不含 `tsc/tsdown` 配置与 `scripts/normalize-client-banner.mjs`，所以 client 重建是：
把上游仓库（`btboys/dsh-notify`）的 `tsconfig*.json`、`tsdown.config.ts`、`scripts/normalize-client-banner.mjs` 借过来，
在本目录 `npm install` 后跑 `npm run build:client`。
**不要跑 `npm run build:host`** —— 那会用未同步的 `src/*.ts` 覆盖手工改过的 `lib/*.js`。
## Server酱（微信服务号）通道

配置在 `routes.json` 里，不进设置页（密钥和路由表放一起，避免两处配置）：

```jsonc
"serverchan": { "enabled": true, "sendKey": "SCT...", "channel": "" }
```

也可以用环境变量 `DSH_SERVERCHAN_SENDKEY` 给 key（`enabled: false` 时仍会读它）。

- 发的是 `POST https://sctapi.ftqq.com/<SendKey>.send`，form 编码，`title` 单行（换行会被压成空格、上限 100 字）、`desp` 放 Markdown 正文
- 免费版只显示 title，会员才能展开 desp；所以 `status` 模式对它是刚需
- `channel` 填控制台「消息通道」的通道编号（企业微信群机器人、自建应用消息等），留空走默认通道

按工作区选通道（`via`）：

```jsonc
"workspaceRoutes": {
  "*":          { "mode": "status" },                          // 走所有已配置渠道
  "D:\\paper":  { "mode": "status", "via": "serverchan" },       // 只发微信服务号
  "E:\\code\\api": { "mode": "full", "via": "wecom" }             // 只发企业微信
}
```

`via` 缺省 = 所有已配置渠道都发（原行为）。
### 卡片标题格式

Server酱 的标题由模板渲染，默认 **设备名 · 工作区 · 会话名**：

```jsonc
"serverchan": {
  "enabled": true,
  "sendKey": "SCT…",
  "device": "",                                              // 留空=取本机 hostname
  "titleTemplate": "{device} · {workspace} · {title}"         // 可改顺序/加状态
}
```

占位符：`{device}` 设备名、`{workspace}` 工作区目录名、`{title}` 会话标题、
`{status}` 完成/失败/暂停/需要授权/需要回答/TODO 进度、`{time}` 当前时间。

例：

```jsonc
"titleTemplate": "{status} · {device} · {workspace} · {title}"
→ 完成 · DESKTOP-ABC · DSHwork · 修通知插件
```

标题里的换行会被压成空格（Server酱 不接受多行标题），超长截到 100 字。
### Server酱 正文详细度（`detail`）

| 值 | 正文 |
|---|---|
| `brief`（默认） | `📊 12 步 / 4 类工具 / 2 分 14 秒` + `💬 会话：…` + `🗒 最后一轮做了什么（≤120 字）` |
| `status` | 只有 📊 计数和会话名，没有摘要 |
| `full` | 原样：`💬 用户问题` + `🤖 回复摘要（≤500 字）` |

```jsonc
"serverchan": { "enabled": true, "sendKey": "SCT…", "detail": "brief" }
```

摘要取的是本轮回复的前 120 字，没有回复时回退到用户提问。
