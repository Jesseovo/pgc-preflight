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

## 非 HTTP 正反对照

`scripts/harness-egress-probe-worker.ts` 是另一个独立研究入口。它没有生产 D1、模型网关或浏览器绑定，只接受研究 Secret 和固定镜像摘要。三次顺序运行分别为 `POST /positive-before`、`POST /blocked`、`POST /positive-after`；`GET /status` 返回检查记录。每次运行销毁容器并确认后才能进入下一项，同项不能重新提交。结果未知时只查询状态，持久 Alarm 处理清理。

三项使用相同镜像和 HTTP 拒绝策略，只改变 `enableInternet` 为 true、false、true。固定探针使用 Node 原生 socket，测试 Cloudflare 公共 [DNS over TLS](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-tls/) 的 TCP 853 和 [NTP](https://developers.cloudflare.com/time-services/ntp/usage/) 的 UDP 123，各含 IPv4 和 IPv6。请求只含固定的 `example.com` DNS 问题或 NTP 随机关联标识，不接收自定义目标、请求体、游戏、提示词或模型凭据。它绕开 CCB 的进程内 socket 限制，专门核验 Cloudflare 原生网络边界。

仅在同一协议和地址族的前后正向控制都取得匹配响应、禁网项无法连接或响应、且三次容器清理均确认后，该项才标为 true。禁网项连通为 false；正向服务不可达、响应不合格、清理或执行状态不明都保留 null。局部 true 只代表这些固定端点的 TCP 建连或 UDP 请求响应在本次配置下被阻断；UDP 无回包不能排除单向数据包已送达，须独立受控接收端才能验证这一点。不能据此证明所有协议或任意恶意 JavaScript 的操作系统沙箱，也不能代替实际模型和质量对照。IPv6 无正向可达证据时不可算通过。回执始终 `releaseReady:false`。

Cloudflare 文档说明 `enableInternet:false` 会拒绝非 HTTP 外联，HTTP/HTTPS 拦截器本身不覆盖其他端口；该声明与实际探针记录分别保存。[出站网络规则](https://developers.cloudflare.com/containers/configuration/outbound-traffic/#non-http-traffic)

## 独立的真实渠道研究 broker

`server/harness-provider-research.ts` 是单独的服务端模块，默认 Worker 和上述合成流探针均不加载它。候选服务必须绑定独立研究 D1 及现有生产容量库，通过服务端读取现行配置，使用独立的 256 位 HMAC Secret。容器只收到该研究任务的租约。研究账本和遥测留在研究库，只有既有模型限流及槽位操作使用生产容量库。

可信研究 Runner 以签名 `GET /api/__harness-provider-research/plan` 取得固定任务的注册计划，在研究库注册原样的 snapshot 和已锁模型。每次 `POST /api/__harness-provider-research/model` 以相同 HMAC 协议签署路径、方法、任务、代次、请求 ID、时间、原始请求字节哈希及租约。研究配置中的 matcher 必须校验冻结的系统文本、用户文本、图像字节及完整工具定义。Anthropic 工具续轮还须校验对应的模型历史摘要与工具结果。摘要表由 `scripts/harness-provider-research-ledger.sql` 在研究库创建。宽松 matcher 不具备部署条件。即使合成夹具通过，也须独立完成发布验收。
