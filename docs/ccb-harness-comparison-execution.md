# CCB 对照执行与恢复

六题对照目前处于本地准备阶段。正式制作、审核和质量验收均待执行。

## 固定材料与暂停入队

`harness-comparison-coordinator.ts` 从已冻结的材料索引、公开模型配置、规则及校准快照生成 24 个确定任务 ID。每题两次制作、两次完整审核；审核必须等待同题 B 成品和独立基础证据。不会用演练 HTML 或脚本模型结果替代正式结果。

`harness-comparison-admission.ts` 只接受新的独立数据库。它通过原任务入队函数锁定完整材料，并持久化排程意图；其 Runner 只能记意图，没有执行能力。先入队全部制作任务，再释放执行，防止先前完成的作品进入后续题目的历史上下文。重复或中断入队复用原 ID，不能重建已经丢失的暂停任务或重新认证已开始的任务。

A 的源代码来自 `8afbf81c85c785f5d2d071dda9ecedba510b42ab` 原始 Git 归档。`prepare-harness-comparison-baseline.ts` 保存不变归档及可独立复现的最小传输补丁，在生成副本注入任务级私有回调；不改变提示词、阶段流程、原供应商幂等键或原流式请求。副本只持有合成占位凭据。占位配置的解密材料按任务稳定，恢复时可解开之前的检查点，不接收真实供应商 Key。

B 使用固定 `630303565f44c061c7ed8ad7b992dcc4e9db8929` 运行时及已通过兼容验证的镜像摘要。新调度、代理和恢复适配代码属于单独的研究适配层，其版本仍需在实际执行时记录。

## 审核材料与恢复

Node 端 `harness-comparison-evidence.ts` 仅打包经过登记的 B 成品、探测记录和四张原始图片，不打包独立问题目录、自检或另一臂答案。Worker 端 `harness-comparison-evidence.ts` 复算包、文件和证据摘要，每次返回独立副本。

共享放行控制器 `harness-comparison-runner.ts` 在释放和每次 alarm 前验证任务所属、原计划、授权窗口、原材料、研究策略和冻结配置。B 另外核验可信代理返回的模型配置。A/B Worker 各自在本臂命名空间按确定任务 ID 绑定唯一 DO。恢复核对实际请求的源码、图片顺序和索引、规则及报告归属。只有同一任务、同一持久放行凭据才能继续。模型已开始而结果未知时停止付费执行。授权过期后保留已有检查点，封存终稿的独立恢复手续仍待验证。

## 共同账本和流式转发

`harness-comparison-ledger.ts` 由私有控制服务提供独立数据库、不可变正式授权、完整槽位和不同的对象能力。A/B 共用总请求数与输出 Token 预留。转发前先原子预留、再持久化转发状态；相同编号不能再次付费。调用结果未知则保留整笔预留并停止该任务的后续请求。用量超出预留会停止整个授权下的新请求。

`harness-comparison-stream.ts` 保留 Anthropic/OpenAI SSE 原始字节。普通数据即时转发；原生终止帧必须有明确结束状态、最终原生用量与完整 EOF，并等账本结算后放行。推理 Token 已包含在原生输出用量中，不重复相加。截断、拒绝、断流及未知结果分别保存，不能把 HTTP 200 当成任务完成。账本不保存模型正文、思考、请求原文或凭据。

私有凭据代理只在服务端读取当前配置、解密 Key，并使用生产共享并发与节流记录。每次实际转发前重查原配置和权限。研究记录写研究库；原始供应商 Key 不进入容器、研究输入、导出或日志。A 的原传输仍含合成占位 Key 的本地节流；正式比较耗时前必须处理或分别记录这层等待，不能把额外等待归因于 CCB。

`createComparisonBaselineBroker` 连接 A 的固定任务回调；`createComparisonHarnessBroker` 连接 B 的真实 `handleHarnessModelRequest`，保留 Gateway 的租约、逐次权限、模型配置和共享容量检查。B 不另获取第二份容量。两者仅接受正式授权，绑定时核对完整 grant 与 slot；每个槽位使用不同的 transport ID。代理不自行重试供应商请求，已知拒绝和未知结果分别入账。

## 私有部署接线

下表记录本地入口需要的绑定。正式部署清单、初始化和读回回执仍需补齐并验证。A/B 的模型流保留请求取消，私有 Worker 包明确启用 `nodejs_compat` 和 `enable_request_signal`。候选沿用原生产兼容配置并单独验证请求取消能力。

| 部署单元 | 入口和绑定 |
| --- | --- |
| A 归档执行器 | `A.js` 的命名入口 `ComparisonTaskControl`；`COMPARISON_TASKS` 指向本脚本的 SQLite `ComparisonTaskRunner`，`DB` 指向 A 研究库，`BROWSER` 供制作采集。绑定 authority 的 `ComparisonBaselineAuthority`；`COMPARISON_SERVICE_CONTEXT` 固定为 A，`COMPARISON_SERVICE_AUTH` 仅为比较服务签名 Secret。按候选 UUID 签名访问固定基线转发路径。 |
| B CCB 执行器 | `B.js` 的命名入口 `ComparisonTaskControl`；`COMPARISON_TASKS` 指向 B 自己的 SQLite `ComparisonTaskRunner`，`DB` 指向 B 研究库，`BROWSER` 供制作采集。另将 `HARNESS_RUNNER` 绑定到容器类 `HarnessRunner`，使用计划冻结的镜像 digest，整个研究容器应用最多两实例。`HarnessOutbound` 拦截 HTTP/HTTPS，工具走本地 Host，模型走 `COMPARISON_CANDIDATE_BROKER` 私有 Fetcher。该 Fetcher 指向 relay 的 `ComparisonCandidateRelay`；`COMPARISON_AUTHORITY` 指向 `ComparisonAuthority`。 |
| A/B 部署证明 | 两臂分别设置 `COMPARISON_DATABASE_ID`、`COMPARISON_DEPLOYED_RUNTIME` 和 `COMPARISON_WORKER_VERSION`（Cloudflare `version_metadata` 绑定）。Authority 返回的 Worker UUID、bundle SHA-256 与运行时源摘要必须与独立部署读回一致。B 另固定 `COMPARISON_CANDIDATE_VERSION`。 |
| 私有 authority | `authority.js` 导出 `ComparisonBaselineAuthority` 和 `ComparisonAuthority`。绑定 A/B 研究库、全局研究账本和独立 nonce 库，或明确将 nonce 与研究账本共用。只读冻结材料，核验任务、授权和 B 成品证明。 |
| B 私有 relay | `relay.js` 的命名 Fetcher `ComparisonCandidateRelay`，绑定 B 的 `COMPARISON_SERVICE_CONTEXT` 和签名 Secret `COMPARISON_SERVICE_AUTH_KEY`。按固定 URL、版本覆盖和签名访问候选，验证响应执行版本并传递流式取消。 |
| 零流量候选 | `candidate-entry.js` 包装原生产 `worker.js` 与 `candidate-handler.js`。绑定实际 `version_metadata` 为 `COMPARISON_CANDIDATE_VERSION`，继承原生产 `DB` 与 `SETTINGS_KEY`，另绑研究库、`COMPARISON_PROFILE_IDS` 和比较服务签名 Secret `COMPARISON_SERVICE_AUTH_KEY`。生产库用于读取现行模型配置和共用限流容量。候选只接受固定比较路径，A/B 任务和研究数据留在各自研究库。 |

Authority 与候选共用小型 `COMPARISON_BOOTSTRAP` 配置（`runId`、`planSha256`、`manifestSha256`、`authorizationSha256`、`ledgerDatabaseId`）及 `COMPARISON_DATABASE_IDS`。完整配置以实际版本读回为准，一次性写入 `comparison_service_deployments`，授权行必须绑定该配置的 SHA-256。研究数据绑定为 `COMPARISON_A_DB`、`COMPARISON_B_DB`、`COMPARISON_LEDGER_DB`，必要时另绑 `COMPARISON_NONCE_DB`。材料可绑定私有 `COMPARISON_MATERIALS`，或写入研究账本的 `comparison_material_blobs` / `comparison_material_chunks`。默认 HTTP 入口拒绝访问。释放操作只可由具有相应命名私有服务能力的控制入口调用。

B 的 `HarnessRunner` 对 `/start` 和 `/tools` 串行处理。工具执行前重查授权、任务阶段、租约、当前容器阶段与期限，避免上一阶段的请求落到新阶段。停用授权或切换阶段会阻止后续工具请求。已经开始的工具可能继续到其自身的执行上限，撤权不会即时取消它。

## 初始化与正式执行门槛

1. 在干净提交上打包并锁定适配层版本。独立读取当时生产部署，确认原版 100% 流量，并记录原版 UUID、模块字节摘要、资产、绑定和路由，以便逐项恢复。复核镜像 digest、两组公开模型配置、规则和校准快照，保持私有记录脱敏。
2. 以独立迁移建立 A/B 和全局研究库。核对数据库实际绑定 ID、臂标记和源版本。先上传缺少封存配置时拒绝服务的候选，独立读回候选版本，再为 A/B 配置该版本、上传并独立读回各自 UUID。A/B 可先绑定未启用的私有 authority 名称。把最终读回的 UUID、bundle 摘要、签名上下文及原计划写入全局研究库的不可变部署行，初始 `comparison_service_grants.enabled=0`。冻结材料以 `frozen/<sha256>` 存储并回读摘要。正式授权、模型限流和预算都必须独立核验。
3. 在任何制作前暂停入队全部 12 个制作任务并回读快照、所属、排程意图及零模型启动标记。计划在此之前就固定 24 个任务 ID，初始授权只预留审核槽位，审核的源码与证据摘要保持未绑定。每题 B 制作完成后，独立基础采集对同一成品做封存，验证四张原始视口图和探测记录。再按两臂各自预定审核任务 ID，写入同一封存包至 `evidence/<taskId>/<packSha256>`，用原入队流程分别锁定 A/B 审核，逐项读回校验。统一账本按 case 原子绑定同一源码及证据摘要。没有对应 B 成品或证据不完整的审核槽位保留未执行状态。
4. 独立读回候选、A/B 的实际版本 UUID、绑定和 bundle 字节，核对每臂签名上下文及候选响应证明。核验生产原版 100%、候选 0%，候选普通请求为 403，私有入口拒绝无签名、错误臂和错误版本。在已有明确正式授权且处于授权窗口时开启 grant，保持全部任务暂停。分别测试签名 profile 读取、私有 authority 读取及未放行的转发被拒。联验前后都独立确认放行行、Harness 租约、模型启动标记及派发账本记录为零。读回有偏差立即禁用 grant。联验通过后才按持久放行凭据逐项释放。未知模型结果保留在原任务中。

仍待完成的正式启动门槛包括以下三项。

- **版本初始化实测。** 候选 UUID 只能在上传后从 Cloudflare 读回。若把 UUID 回填进同一 Worker 的版本绑定，会生成新版本，破坏自身实际 UUID 等值校验。完整计划也可能超过 5 KB 单变量上限。两阶段初始化代码以固定小型 bootstrap 和上传后独立封存的部署行解决这两个问题，仍需在实际绑定上确认缺行、摘要不符或 UUID 不符时均拒绝服务。 [Cloudflare Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)
- **正式接线联验。** 禁用授权会拒绝 profile 与 authority 读取。通过明确授权开启 grant 后，接线检查仍需保持全部任务暂停，核对零放行、零派发和零模型启动。
- **操作编排。** 包内没有经过验证的部署、全量暂停入队、B 成品独立采集、逐题双臂审核放行、结果导出和清理操作流程。审核槽位必须保持晚绑定，不能为占齐 24 个授权槽位提前填入合成摘要。还需验证两容器上限、共享生产节流、A/B 实际流式取消、未知请求停止及终态恢复。

正式对照的待批准预算提案为最多 **246 次真实模型请求、3,840,000 个输出 Token**，包含供应商计入输出的思考 Token。这笔预算尚未授权。总账本预留以模型请求上限为准，结果未知保留完整预留，耗尽后停止新请求。正式对照须单独授权，先前九次合成兼容测试额度已耗尽。模型请求额度之外的容器、浏览器与 Workers 用量需按实际服务记录。

## 恢复与撤场

结束或触发停止条件时，先停新释放和代理转发，核对在途请求并保留未知状态。导出 24 个槽位、阶段结果、失败、未知用量及独立证据，回执保存摘要。A/B 的私有 `ComparisonTaskControl.readReviewArchive(taskId)` 按绑定任务导出初稿、复核终稿及各自的材料引用、封存时间和摘要。归档与对应阶段检查点同事务提交，任务清理或授权过期后仍可只读导出。对已封存结果的落库只允许按原任务幂等恢复。若授权已过期而尚未验证封存时刻，保留检查点与材料供独立恢复。

撤除研究候选流量分配，按启动前读回恢复原 Worker 单版本 100%。独立确认实际部署 UUID、普通登录与资产读取、原绑定和研究入口关闭；再确认任务 DO 和容器已停止，撤销比较签名 Secret，按研究保留规则清理临时 Worker、容器和研究存储。清理失败单列恢复回执并保留原记录。生产库及原服务绑定仍由原部署使用。

## 私有离线包

在仓库根目录使用已安装的本地依赖。输出父目录须为私有真实目录，输出目录须尚不存在并位于忽略的 `artifacts/` 下。

```sh
npx --no-install tsx scripts/prepare-harness-comparison-package.ts prepare \
  --registry 'artifacts/<私有材料登记目录>' \
  --comparison-index 'artifacts/<冻结对照索引.json>' \
  --baseline 'artifacts/<生产只读基线快照.json>' \
  --out 'artifacts/<私有父目录>/<新包目录>'
```

基线快照须引用同目录下独立保存的原生产模块，且匹配读回的单版本 100% 流量、字节数和 SHA-256。命令生成五个 Worker 模块、保留的生产模块、候选包装入口、各模块源文件摘要和 `package.json` 回执。回执固定 `activationAllowed:false`、`deployed:false`，仅证明本地打包。

实际版本读回后，可另行生成用于审阅的禁用态初始化参数。当前种子工具要求 nonce 与全局研究账本使用同一独立数据库。运行时也支持单独绑定 nonce 库，该拓扑的初始化需另行准备。

```sh
npx --no-install tsx scripts/prepare-harness-comparison-seed.ts \
  --deployment 'artifacts/<已核验的部署配置.json>' \
  --materials 'artifacts/<冻结材料清单.json>' \
  --out 'artifacts/<私有父目录>/<新的禁用态种子.json>'
```

命令只生成 `schemaVersion: 2` 的本地绑定参数清单。先核对目标确为独立研究账本，再原子应用 `bootstrapStatements`。每份材料按 `stage` 分批暂存，每片最多 96 KiB UTF-8。按 `readback` 分批读回全部有序分片，核对数量、字节数和 SHA-256，然后原子应用该材料的 `publish`，再次独立读回发布后的摘要。清单不包含激活语句。

## 本地排练

```sh
npx tsx scripts/harness-comparison-rehearsal.ts run --out artifacts/<新建的私有目录>
```

这会执行真实 A 归档流程及 B 平台阶段流程，但容器、CCB 和供应商响应均由脚本模拟。两臂审核共用 B 输出的同一文件、四张图、规则和模型配置，分别保存初稿及复核。回执包括 A 原归档、B 固定运行时文件的起止核验和每次实际派发的证据摘要。演练结果明确禁止导入正式质量评估。未知付费结果不重放；已保存终稿只能重试持久化。

正式报告保留全部 24 个槽位及其缺失状态。只有完整的真实模型、同证据复核和独立质量裁决才能形成质量验收结论。
