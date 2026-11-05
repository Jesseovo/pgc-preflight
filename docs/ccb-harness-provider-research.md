# CCB 真实渠道研究操作手册

这项研究用固定合成夹具验证 CCB 经 Anthropic 兼容渠道调用 Claude Opus 5.5 的过程。夹具包含 16 张合成 PNG、一次工具写入和一次同模型续轮，最多两个模型轮次、每轮最多 64,000 输出 Token、总计最多 128,000，修复轮次为零。隔离合成分流实测和本地候选打包均为 `modelCalls: 0`。渠道兼容、成品质量和发布验收仍待验证。

即使候选只接收 0% 常规流量，向 `pgc-preflight` 上传候选并改变活动部署列表也属于生产配置变更。既有发布计划把生产变更安排在验收之后，这次提前加入研究候选须单独确认，并安排在没有活跃平台付费任务的时段。真实模型兼容性测试已在原方案中获授权，无需重复索取模型 Key 或另行扩大模型调用范围。

## 准备

1. 读取生产活动部署和最新上传版本。两者须指向同一个基线 A，且活动部署只有 A 100%。冻结生产上传窗口，避免校验后有其他版本改变绑定或资产继承来源。记录 A 的模块哈希、绑定资源、DO 命名空间、迁移标签、兼容日期和标志、资产配置及触发器设置。发现漂移时停止并重新采集。
2. 本地运行 `scripts/prepare-harness-provider-candidate.ts --baseline <私有基线目录> --out <私有候选目录>`，两目录均位于 ignored 的 `artifacts/`。核对 `candidate-package.json` 和全部模块 SHA-256。原 `worker.js` 字节不变。新入口保留 `CreatorFeedbackRunner`、`ForgeRunner`、`ReviewControlPlane`、`ReviewRunner` 四个命名导出以及原 `scheduled`、`queue` 处理器，替换候选的默认 `fetch`。
3. 为研究 Runner 新建独立 D1，先用 `scripts/harness-provider-research-schema.ts` 生成并检查 schema，再只对该研究库应用。准备固定镜像摘要、任务 ID、代次、模型合同哈希及生效和过期时间。为 broker 和 Runner 配置同一个新生成的 256 位 HMAC Secret，Runner 控制端另用一把独立 Secret。凭据仅经内存或 Secret 输入管道传递，禁止进入配置、参数、日志和回执。
4. 核对研究配置中声明的两个 D1 ID，也从 Cloudflare 读回两处实际绑定资源 ID。候选 `DB` 须指向原生产 D1，候选 `HARNESS_RESEARCH_DB` 与 Runner `PROVIDER_RESEARCH_DB` 须指向同一个独立研究 D1。运行时无法通过配置中声明的 ID 确认实际绑定。研究账本、遥测和工具续轮摘要只写研究库。候选读取生产模型配置，真实请求通过生产 `model_throttle` 和 `model_slots` 协调同 Key 的容量，会写入这些表并使用共享额度。

## 上传与验证

1. 经已批准的 Cloudflare 管理凭据，把候选上传到 `POST /accounts/{account}/workers/scripts/pgc-preflight/versions?bindings_inherit=strict`，使用 multipart，逐一附上原始模块和新模块。元数据使用候选入口、A 的兼容配置、`keep_assets: true`、`assets.config` 原样值，以及所有原绑定按名称显式 `inherit`。加入独立 D1、候选专用 HMAC Secret、`PGC_RESEARCH_VERSION` 版本元数据绑定和固定 `PGC_RESEARCH_MANIFEST`。不得带 DO 迁移、触发器更新或全局设置更新。上传前再次确认 A 同时是活动及最新版本。隔离实测验证了这套继承方式。Beta 上传仅传 A 的资产配置、没有资产令牌时，API 返回 10305。
2. 按 B 的版本 UUID 读回模块、绑定、配置和资产路由。核对所有原模块字节、原绑定资源、实际 D1 ID、四个 DO 类及命名空间、迁移标签、兼容配置，并确认 A 仍独占活动流量。若上传结果未知，先按版本历史和候选哈希核对，勿重复上传。
3. 用 Deployments API 提交精确的 `strategy: "percentage"`，按顺序列出 A 100 和 B 0，省略 `force`。读回新活动部署的两个 UUID 和精确比例。隔离 Worker 实测接受 0，虽然 API schema 标注最小值 0.01。保留原生产配置和触发器，不使用整体 Wrangler 发布代替单次比例更新。 [部署 API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/)
4. 在发起付费调用前，确认常规请求仍走 A，版本覆盖无效时回落 A，原资产字节符合基线。外部请求也能指定 B，必须验证无签名请求无法进入研究。B 的 Worker `fetch` 只接受固定研究计划和模型路径；其他进入 Worker 的路径直接拒绝。Cloudflare 可能在运行 Worker 前先返回按原规则公开的静态资产。独立 Runner 使用新的 Service Binding 请求固定 B，并在模型请求前核对计划响应的 HMAC 和实际版本 ID。 [版本覆盖](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/)
5. 只在上述核对通过且获得真实模型调用授权后运行固定夹具。核对配置合同、图像与工具、两轮关联、Token 实际用量、受控错误和实例清理。遇到状态未知时保留账本和回执并查询原任务，不重发付费请求。只在私有记录中保存必要的脱敏数据。

## 回滚与清理

停止提交研究任务，先核对容器、研究账本和生产活跃任务。用同一 Deployments API 提交 A 100% 单版本部署，省略 `force`。读回 A-only，确认普通生产路径和资产可用，原 B 覆盖不再选中候选。若管理操作结果未知，先读取活动部署。隔离实测的原 Secret 在回滚后仍有效，候选 Secret 对 A 不可用。

DO 的实例标识在隔离测试的版本切换前后发生过变化，SQLite 数据仍在。采样无法区分部署重置与空闲回收。转发带版本覆盖头的原请求还曾让同一 DO 执行 B。候选因此不把普通请求转给原应用，维护窗口仍应避开活动付费任务。

待 Runner 完成或清理容器并保留脱敏回执后，撤销研究凭据，关闭研究入口，按已授权的范围删除独立 Runner、容器应用、DO 命名空间和研究 D1。核对资源删除状态。生产基线 A 和现有资源保留。
