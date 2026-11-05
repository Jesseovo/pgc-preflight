# CCB Native Container 研究探针

本入口用于隔离研究。它无 D1、Browser Run、生产任务、模型凭据或供应商外呼。它在已上传的同账户 Registry 摘要上启动实际镜像和 CCB CLI，使用 Worker 私有合成流。回执固定 `releaseReady: false`，不能作为生产发布记录。

使用独立 Worker 名称、独立 SQLite Durable Object 和容器应用。保留默认 `wrangler.jsonc`。配置放在 ignored 的 `artifacts/` 目录，按所在路径调整入口与 schema 的相对路径。

```jsonc
{
  "name": "pgc-ccb-native-research-20261105",
  "account_id": "<PGC Cloudflare account>",
  "main": "<relative path>/scripts/harness-native-probe-worker.ts",
  "compatibility_date": "2026-10-23",
  "compatibility_flags": ["nodejs_compat", "enable_ctx_exports"],
  "workers_dev": true,
  "preview_urls": false,
  "limits": { "cpu_ms": 30000 },
  "durable_objects": {
    "bindings": [{ "name": "NATIVE_PROBE", "class_name": "NativeProbeRunner" }]
  },
  "migrations": [{ "tag": "v1-native-probe", "new_sqlite_classes": ["NativeProbeRunner"] }],
  "vars": { "RESEARCH_IMAGE": "<digest-pinned research image URI>" },
  "containers": [{
    "class_name": "NativeProbeRunner",
    "scheduling_policy": "durable_object",
    "images": { "ccb": { "image": "<same digest-pinned research image URI>" } },
    "observability": { "logs": { "enabled": false } }
  }],
  "observability": { "enabled": false }
}
```

先对该配置执行 Wrangler `deploy --dry-run --config <研究配置路径>`。实际部署和调用由操作者在研究资源内执行。仅向这个 Worker 配置新生成的 256 位随机 Secret `HARNESS_RESEARCH_TOKEN`，以 64 位小写十六进制编码。用 Wrangler Secret 的标准输入或 Cloudflare 控制台录入；不可放进配置、命令参数、日志或报告。可另外用 Cloudflare Access 保护研究域名。入口在 Secret 或镜像绑定缺失时拒绝请求。

部署完成后可运行本地控制脚本。它只接受该独立入口的配置和对应 `workers.dev` 地址，在内存中生成研究凭据，经标准输入配置 Secret，再依次运行固定探针；报告写入私有 `artifacts/` 目录。脚本不重发结果未知的启动请求，只读取原运行状态。只有确认第一项容器已销毁，才运行 Alarm 清理项目。

```sh
node scripts/run-harness-native-probe.mjs \
  --config artifacts/<研究目录>/wrangler-native.jsonc \
  --url https://pgc-ccb-native-research-<编号>.<账户子域>.workers.dev \
  --out artifacts/<研究目录>/results
```

控制脚本保存 `native-probe-run.json`，其 `overallIsolationAccepted` 固定为 false。退出码为零只表示已收到回执并确认两次容器清理，仍须逐项核对失败和未知项。研究 Secret 不能恢复为本地明文；后续独立研究重新生成凭据和资源。

请求都使用相同研究 Secret 的 Bearer 鉴权。三条允许的路由不接收请求体或查询参数。写入 Secret 后只用状态 GET 等待最多 60 秒。仅收到已认证的 `idle` 才提交 `/run`，已有活动或结束回执时停止。固定版本响应标记可区分入口未配置、未收到认证头、凭据不匹配。只有明确标记为转发前鉴权拒绝的提交可以重试，每次重试前重新读取对应状态，最多三次提交，重试窗口为 60 秒。提交结果未知时只查询状态。私有回执保存每次明确拒绝的原因、固定版本和方法，以及响应可用时的边缘机房代码。

| 路由 | 验证 |
| --- | --- |
| `POST /run` | 单次启动镜像并检查健康接口、实际镜像摘要、私有出站绑定、HTTP/HTTPS 拦截、伪造任务/代次/凭据拒绝。启动 CCB 接收合成流，检查实际父子进程的 UID、Linux capability 和关键环境变量隔离，等待运行时超时并确认工作区与实例清理。 |
| `POST /arm-timeout` | 另一次独立启动，返回 202 后保留运行中的实例。持久 Alarm 在五秒后清理。回执区分 Alarm 到达前是否仍在运行，以及是否实际调用销毁。 |
| `GET /status` | 返回最近一次研究回执。请在启动下一项前保存上一项回执。 |

`/run` 返回 502 时仍应保存回执。每个项目为 true、false 或 null，分别表示满足、观测不符或证据不足。HTTP/HTTPS 仅认私有拦截器返回的固定标记。TLS 或连接失败保留 null。当前探针没有独立的非 HTTP 外网 canary，`nonHttpEgressDenied` 保留 null。无真实供应商请求，不能证明模型兼容性。非零 UID 与 capability 位分开判定。Cloudflare 对 `durable_object` 调度下的进程能力有单独限制说明。[Native Container API](https://developers.cloudflare.com/containers/api/durable-object-container/) · [出站规则](https://developers.cloudflare.com/containers/configuration/outbound-traffic/)

只保存必要的研究回执和镜像摘要。确认实例和 Alarm 已清理后撤销研究 Secret、关闭研究路由并删除临时 Worker。不要将本回执用于 `HARNESS_RELEASE`。
