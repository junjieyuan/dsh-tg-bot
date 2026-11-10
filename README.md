# Telegram Bot（@local/dsh-tg-bot）

将 Telegram Bot 接入 DeepSeek Harness。当前版本（v1）只支持**私聊**，提供：

- 通过长轮询（long polling）连接 Telegram Bot API；
- **配对流程**：陌生用户向机器人发送配对命令 → 生成待批准的配对请求 → 你在 Web 界面批准后记入白名单；
- 白名单用户的消息会收到确认回复，并写入有界的消息记录（v1 不转发给 Agent，那是 v2 的范围）；
- 群组、频道消息被完全忽略。

## 接入步骤

1. 在 Telegram 中找 **@BotFather**，执行 `/newbot` 创建机器人，拿到 bot token。
2. 打开 Harness Web 的 **设置 → Telegram 机器人**，把 token 粘贴进「Bot token」，点 **保存并连接**。
   token 以凭据（credentials）形式保存，不会写入任何配置文件。
3. 状态点变绿（Connected — receiving private messages）即连接成功；
   连接失败（token 无效、网络不通）会显示错误原因。

## 配对流程

1. 让用户在与机器人的**私聊**里发送 `pair`（或 `/pair`）。
2. 机器人回复「配对请求已提交，等待管理员批准」。
3. 在 Web 的 **设置 → Telegram 机器人 → 配对请求** 里点 **批准**（或 **拒绝**）。
4. 批准后该用户进入**白名单**；此后其消息会收到确认回复并出现在**最近消息**里。
   白名单用户可用 **移除** 移出（会收到通知，之后需重新配对）。

## 配置项（均可选）

插件行 `dsh-tg-bot`（profile 的 `cordis.patch.yml`）支持 `config` 块：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiBase` | `https://api.telegram.org` | Bot API 基地址（协议 + 主机，无尾斜杠）。在无法直连 api.telegram.org 的网络（如中国大陆）下，改为可用的 Bot API 反向代理地址。 |
| `pairingCommand` | `pair` | 配对命令，大小写不敏感。 |
| `pollTimeoutSeconds` | `25` | 长轮询超时秒数（5–50）。 |
| `activityLimit` | `200` | 最近消息条数上限（10–1000）。 |

例如：

```yaml
- insert:
    - id: dsh-tg-bot
      name: '@local/dsh-tg-bot'
      config:
        apiBase: 'https://your-tg-relay.example'
```

## 限制（v1）

- 仅私聊：不处理群组/频道；不做 Agent 路由、不创建会话。
- 配对命令只在与机器人的私聊中生效。
- 最近消息只保存文本（截断至 2000 字符），不保存媒体。

## 开发（TypeScript）

源码为 `src/index.ts`（宿主端）与 `src/client.ts`（浏览器端），用 TypeScript 编写；
运行时的入口 `index.js` / `client.js` 是编译产物，已随仓库提交（DSH runtime 直接加载这两个文件）。

- `pnpm build` — 编译并输出到包根的 `index.js` / `client.js`；
- `pnpm typecheck` — 只做类型检查，不产出文件。

修改 `src/*.ts` 后必须重新 `pnpm build`，否则 runtime 仍在运行旧的编译产物。
注意：`client.js` 在浏览器里以普通脚本（非 ES module）加载，因此 `src/client.ts`
不能出现真正的 import/export 语法，输出里也不能有模块标记。
