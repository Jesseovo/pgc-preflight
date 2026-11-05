# CCB Harness 研究镜像与发布准备

[研究工作流](../.github/workflows/ccb-research-image.yml) 接受手动 `workflow_dispatch`，并在 `codex/ccb-harness-integration` 分支的相关文件变更时运行。它在 GitHub Linux x64 运行器执行合成运行时、网关、账本、宿主恢复和评估回归，按 `harness/Dockerfile` 构建 CCB `963e0013184ecc1521289a0fc7d5da4bb6e45356` 的 Linux amd64 镜像。在 `--network none` 下验证镜像内的 CCB CLI 和带鉴权的容器健康接口，并检查运行用户。普通分支构建的镜像留在该次运行器内；手动指定 `publish_image=true` 时，使用专用 `CLOUDFLARE_API_TOKEN` Secret 推送私有 Cloudflare Registry，保存镜像摘要回执。手动触发要求工作流已经存在于默认分支。[GitHub 手动触发说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)

镜像上传仅限上述手动选项；本流程不执行远程迁移、Worker 发布或生产灰度。仓库工作流只使用只读仓库权限，checkout 不保留凭据。构建和协议回归无法证明真实供应商兼容性、Cloudflare 出站拦截效果、生产使用权或对照质量。

## 准备发布前的证据

- 由负责人确认固定 CCB 修订及其依赖允许预期生产使用和必要的私有镜像发布。研究试构建不构成生产授权。
- 记录从批准的 Linux 镜像运行的真实供应商兼容证据。分别按实际模型契约摘要锁定 Anthropic/OpenAI 协议、实际配置和流式结果，检查模型能力、思考设置、结构化输出及任务实际需要的视觉能力。配置摘要使用服务端任务锁定的 `modelContractHash`，与评估清单中脱敏配置文件的字节摘要各自独立。
- 在受控环境验证同一镜像的真实 Cloudflare Native Container 接线、非 root、默认关闭直连外部网络、容器与子进程的凭据分离、跨任务拒绝和终止清理。必须能够重现私有网关允许调用，以及外部目的地和其他任务访问被拒绝。
- 按[离线对照协议](ccb-harness-evaluation.md)完成六题双臂制作和审核，并归档独立盲评。质量判定必须为 `passed`，评估记录必须已确认生产使用权及真实供应商兼容性。
- 本次计划已授权研究镜像入库和 Cloudflare 隔离验证。使用仅供 CI 的 Cloudflare 专用账户 API Token，按职责区分镜像上传和 Worker/D1 发布权限，禁止复用个人 OAuth。凭据只从受保护的部署环境注入，禁止出现在参数、构建参数、日志或产物。Cloudflare 命名镜像要求同账户托管 Registry 中的完整 digest URI。正式发布步骤尚未配置。真实隔离研究须使用独立数据集，不能借研究配置更改生产流量。[Cloudflare 镜像管理与 CI](https://developers.cloudflare.com/containers/guides/image-management/#push-images-with-ci)

## 生成关闭态配置

从实际完成评估的干净 PGC 提交执行。生成器重算评估门槛，核对同一个 PGC 提交、CCB 修订、镜像摘要及私有文件哈希。它只新建 `artifacts/<发布准备目录>/wrangler.harness.jsonc`，保持默认 `wrangler.jsonc`。证据或配置不可用时命令退出，禁止用合成值填报发布前置条件。

```sh
npx tsx scripts/prepare-harness-release.ts \
  --evaluation artifacts/ccb-harness-evaluation \
  --evidence artifacts/ccb-harness-evidence/release.json \
  --out artifacts/ccb-harness-release
```

`release.json` 的必需字段如下。

- `engineCommit`、`implementationCommit`、`manifestSha256` 与实际冻结评估一致。`image` 为同 Cloudflare 账户 Registry 中的 `registry.cloudflare.com/<ACCOUNT>/<REPOSITORY>@sha256:<DIGEST>`。
- `isolationChecks` 包含 `linuxImage`、`nonRoot`、`nativeGateway`、`directEgressDenied`、`secretsIsolated`、`crossTaskDenied`、`terminalCleanup`，七项均须有实际证据后填 true。`isolationEvidence` 为非空证据文件引用数组。
- `compatibleModels` 各项含 `contractSha256` 和 `evidence`。证据文件为兼容性回执 JSON，字段为 `contractSha256`、`engineCommit`、`implementationCommit`、`image`、`streamingVerified: true` 和 `providerVerification` 实际验证文件引用。兼容性回执的摘要必须已被评估的 `providerCompatibilityVerified` 前置记录引用。
- 该发布证据的文件引用一律使用 `{"path":"相对 artifacts/ 的路径","sha256":"原始字节摘要"}`。如同一个回执被评估前置记录引用，在评估记录中按其协议使用 `inputs/...` 相对路径，摘要保持一致。

生成配置保留现有 Worker 名称、自定义域、D1、Queues、Cron、Browser Rendering、静态资源和现有变量。入口为 `server/harness-worker.ts`，SQLite 迁移追加 `v4-ccb-harness`，绑定为 `HARNESS_RUNNER`，容器类为 `HarnessRunner`。命名镜像为 `images.ccb`，使用 `durable_object` 调度，实例规格由 Runner 启动时指定。 `HarnessOutbound` 通过 `ctx.exports` 的私有绑定处理容器请求。容器日志关闭，`HARNESS_ROLLOUT` 固定为 `off`，发布配置锁定镜像 URI、证据摘要和已验证模型契约。每个 Harness 任务保存其镜像摘要。切换镜像后，旧任务可继续读取已完成的当前阶段；需要启动新容器的旧阶段遇到不同摘要会失败，不能用新镜像重跑。配置依据 Wrangler 4.151 系列 schema 和仓库锁定的 4.152.0 契约。[Wrangler 容器配置](https://developers.cloudflare.com/containers/configuration/wrangler/) [Native API](https://developers.cloudflare.com/containers/api/durable-object-container/) [出站拦截](https://developers.cloudflare.com/containers/configuration/outbound-traffic/)

## 发布顺序

生成配置后，先运行构建和使用该私有配置的 Wrangler dry-run，确认入口、DO 绑定、已有资源与相对路径。实际对照与全部验收通过后，依本轮授权备份 D1，核对并应用待迁移的 `0033` 和 `0034`，使用该配置及 `--keep-vars` 发布关闭态。核对实际 Worker 部署版本、SQLite DO 迁移、镜像摘要和已有业务访问。依已确认计划开启已登记灰测范围，使用已验证模型配置；全量开放不在本轮范围内。撤回先关闭新任务灰度，并按已锁任务处理规则检查进行中的运行。生产应用 `v4-ccb-harness` 后，后续发布与回退配置都需保留已迁移的 DO 定义，避免默认配置缺失迁移标签。未完成任一环节时按实际状态记录。

本说明与代码提供构建和配置准备路径。GitHub Linux 工作流、Cloudflare 镜像入库、Native Container 生产验证及 Worker 发布均以对应运行记录为准。
