# Cloudflare 浏览器会话关闭探针

探针用于验证实际 Browser Run 绑定能按准确会话编号查询和关闭 Harness 浏览器。独立 Worker 只绑定 Browser Run 和一个 SQLite Durable Object。它启动一个空白浏览器，通过固定编号连接并查询版本，随后调用与 Harness 相同的关闭确认逻辑。探针没有游戏输入、截图、模型或生产数据库。返回值只含状态分类，不含会话编号、浏览器原始响应或认证凭据。

使用单独的研究 Worker 名称和 SQLite 命名空间。若把配置放在 `artifacts/ccb-browser-close-probe/wrangler.jsonc`，最小配置为以下内容。账号和兼容设置须与目标运行环境一致。

```jsonc
{
  "name": "pgc-ccb-browser-close-probe",
  "main": "../../scripts/harness-browser-close-probe-worker.ts",
  "compatibility_date": "2026-10-23",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,
  "preview_urls": false,
  "browser": { "binding": "BROWSER" },
  "durable_objects": {
    "bindings": [{ "name": "BROWSER_CLOSE_PROBE", "class_name": "BrowserCloseProbe" }]
  },
  "migrations": [{ "tag": "v1-browser-close-probe", "new_sqlite_classes": ["BrowserCloseProbe"] }]
}
```

在研究 Worker 设置独立 `HARNESS_RESEARCH_TOKEN` Secret，使用 64 个小写十六进制字符的随机值。凭据只通过安全的标准输入或既有 Secret 管理路径设置，不记录在配置、请求回执或日志。可用路由为认证后的空请求 `POST /run`、只读 `GET /status` 和固定恢复请求 `POST /recheck`。每个研究实例只准入一次 `POST /run`，响应未知时只轮询 `GET /status`。空闲期限为 30 秒，申请结果未知时保留登记。若已知原编号，alarm 只对原编号做有界清理，默认最多六次。六次均未确认后，可对同一命名空间的原记录请求一次空 `POST /recheck`，总上限增加到八次。并发或重复请求共用同一次授权，缺原编号的记录拒绝复查。复查响应未知时继续只轮询状态。

通过回执要求 `before=active`、`connected=true`，绑定返回已识别的 `closeStatus`，且 `cleanupConfirmed=true`。`after=ended-number` 表示同一编号的记录含数值结束时间，`after=absent` 表示按该编号查询返回 null 或明确查无该会话。查询失败的脱敏诊断只保存有限错误名、数字状态和是否明确查无该会话。普通异常保持未知。`releaseReady` 始终为 false。状态与资源清理需实际远程核验。确认关闭并保留脱敏回执后，清理研究 Worker、Secret 和独立命名空间。

[Cloudflare Browser Run 绑定](https://developers.cloudflare.com/browser-run/reference/browser-binding-api/) · [Cloudflare 会话 API 类型](https://developers.cloudflare.com/api/resources/browser_rendering/subresources/devtools/subresources/session/)
