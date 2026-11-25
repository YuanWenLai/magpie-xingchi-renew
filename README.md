# magpie-xingchi-renew

星驰单会话续命插件 —— magpie 异步 gateway hook。[English](#english)

## 背景

星驰对每个会话有两个站方限制（2026-11-21 站方实测证实）：

- 单会话最多 **100 轮**模型回复，超了就报 400 `session_turn_limit_exceeded`；
- 单次请求 input 里最多 **10 轮**用户对话，超了同样 400。

100 轮的计数按会话内容走，不是按 key 或时间窗口：同一个 key，旧会话被封顶的同时，发一个全新小请求照样 200。

## 做法

在请求发往星驰之前，把它整形成一个“新会话”：截掉早期轮次、只留最近几轮加一条说明，同时改 `instructions`、`conversation`、`metadata`，`previous_response_id` 置空。任何一步出错都不改请求（fail-open）。

触发条件（任一）：

| 条件 | 默认值 |
| --- | --- |
| input 项数 | > 150 |
| 单次请求用户轮数 | > 9 |
| input 里 assistant 回复数 | ≥ 80 |
| 单会话请求计数 | ≥ 90 |
| 上一次请求失败 | 下一次续命 |

续命时保留最近 8 轮用户对话（加 1 轮说明 = 9 轮），并把续完的 input 硬上限到最近 80 项——单个巨型工具循环也可能占满整个 input，只按轮次截是不够的（v1.2 的教训）。当前任务的那轮对话会重新插回去（带标记），不丢任务本身。工具调用和它的输出永远不会被拆散。

## 安装

```bash
magpie plugin add github:YuanWenLai/magpie-xingchi-renew
```

或手动：clone 到本地，在 `~/.config/magpie/plugins.json` 里加：

```json
{ "plugins": [{ "spec": "/path/to/magpie-xingchi-renew" }] }
```

装完重启 magpie（加插件会触发 host 重启）。只对 `xingchiapi/*` 模型生效，其他站的请求直接放过。

## 配置

在 `plugins.json` 对应条目的 `options` 里改（括号内为默认值）：

```json
{
  "spec": "github:YuanWenLai/magpie-xingchi-renew",
  "options": {
    "renewAt": 90,
    "maxItems": 150,
    "maxUserTurns": 9,
    "maxAssistantMsgs": 80,
    "keepTurns": 8,
    "maxRenewedItems": 80
  }
}
```

## 运行记录

每次续命写一行到 `~/magpie-xingchi-renew/renewals.log`；每会话的计数和失败标记存在同目录 `state/` 下（host 重启不丢，6 小时不用的会话自动清理）。这两个都不进仓库（见 `.gitignore`）。

## 注意

- 续命会丢早期上下文，代价和 `/compact` 相近（但没有摘要）。模型只看得到最近几轮和当前任务。
- 这是在绕站方的单会话上限，站方有可能视作违规、封 key，自担风险。
- magpie 0.1.4701 的插件 host 装上 hook 后每几秒重启一次（无报错），插件不依赖 host 内存里的状态，照常工作。

## English

A magpie async gateway hook that renews Xingchi sessions before the station's per-session caps hit: at most **100 model turns per session** and at most **10 user turns per request** (both confirmed station-side, 2026-11-21). The 100-turn counter follows the conversation content, not the API key or a time window.

Before a request reaches Xingchi, the hook reshapes it into a "new session": it drops early turns (keeping the most recent ones plus a note), marks `instructions`, rotates `conversation`/`metadata`, and clears `previous_response_id`. Any error leaves the request untouched (fail-open).

It renews when any of these is true: input has more than 150 items, more than 9 user turns in one request, 80 or more assistant replies in the input, 90 requests in one session, or the previous request failed. On renewal it keeps the last 8 user turns (plus 1 note turn) and caps the renewed input at the most recent 80 items — a single giant tool loop can fill the whole input, so trimming by turns alone is not enough. The current task's user turn is re-inserted (marked), and tool calls are never split from their outputs.

Install with `magpie plugin add github:YuanWenLai/magpie-xingchi-renew`, or clone it and add the local path to `~/.config/magpie/plugins.json`. Only `xingchiapi/*` models are touched; other providers pass through untouched. Renewals are logged to `~/magpie-xingchi-renew/renewals.log`; per-session state lives in `state/` next to it.

Caveats: renewal drops early context (like `/compact` without a summary), and bypassing the station's cap may risk the key — use at your own risk.

## License

MIT
