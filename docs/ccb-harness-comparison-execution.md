# CCB 对照执行与恢复

六题正式对照已获独立额度授权并完成云端零模型联验。首题两臂制作的长流都在收到响应头后约 182 秒中断，尚无完整成品；后续任务停止放行。四次正式请求中，两次短工具调用完成，两次付费结果未知，不能自动重放。完整审核和质量验收尚未完成，不能据此切换默认流程或宣称效果改善。实际部署、账本、导出及撤场状态以本地私有 JSON 回执为准。

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

下表记录执行入口需要的绑定。首轮正式部署已完成初始化和独立读回，实际资源标识与回执仅存私有目录。A/B 的模型流保留请求取消，私有 Worker 包明确启用 `nodejs_compat` 和 `enable_request_signal`。候选沿用原生产兼容配置并单独验证请求取消能力。

| 部署单元 | 入口和绑定 |
| --- | --- |
| A 归档执行器 | `A.js` 的命名入口 `ComparisonTaskControl`；`COMPARISON_TASKS` 指向本脚本的 SQLite `ComparisonTaskRunner`，`DB` 指向 A 研究库，`BROWSER` 供制作采集。绑定 authority 的 `ComparisonBaselineAuthority`；`COMPARISON_SERVICE_CONTEXT` 固定为 A，`COMPARISON_SERVICE_AUTH` 仅为比较服务签名 Secret。按候选 UUID 签名访问固定基线转发路径。 |
| B CCB 执行器 | `B.js` 的命名入口 `ComparisonTaskControl`；`COMPARISON_TASKS` 指向 B 自己的 SQLite `ComparisonTaskRunner`，`DB` 指向 B 研究库，`BROWSER` 供制作采集。另将 `HARNESS_RUNNER` 绑定到容器类 `HarnessRunner`，使用计划冻结的镜像 digest。启动前由原子 D1 槽位限制最多两个活动任务，并独立监测实际实例；DO 托管策略不支持应用级 `max_instances`。`HarnessOutbound` 拦截 HTTP/HTTPS，工具走本地 Host，模型走 `COMPARISON_CANDIDATE_BROKER` 私有 Fetcher。该 Fetcher 指向 relay 的 `ComparisonCandidateRelay`；`COMPARISON_AUTHORITY` 指向 `ComparisonAuthority`。 |
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

首轮正式启动门槛的实测情况如下。

- **版本初始化。** 实际候选及五个研究 Worker 已按两阶段 bootstrap 独立读回并锁定模块、绑定和版本。不能把上传后 UUID 回填进同一 Worker 重新生成版本。完整配置封存在独立部署行，避免超出单变量大小限制。 [Cloudflare Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)
- **接线联验。** 11 项零模型联验通过，包括准确签名 profile、禁用授权、错误版本／臂、nonce 重放、错误放行摘要和 A/B 未放行转发的拒绝。前后均核对零放行、零派发和零模型启动。私有 authority 的正向调用在首次合法放行中完成，先于任务绑定和调度。
- **操作编排。** 已实测独立部署、全量暂停入队、首题双臂放行、未知付费结果停止和失败记录导出。完整成品采集及逐题审核因首题中断尚未实测，不能用本地演练代替。审核槽位继续晚绑定，缺少 B 成品时保持未入队。撤场必须按实际回执独立验证，不能只检查脚本退出码。

用户已单独批准正式对照最多 **246 次真实模型请求、3,840,000 个输出 Token**，包含供应商计入输出的思考 Token。先前九次合成兼容测试额度独立且已耗尽。总账本按请求上限预留，未知结果保留完整预留，不能把预留当作实际用量。首题中断后保留四次请求及全部 24 个槽位；未执行的任务不得按成功计入。模型请求额度之外的容器、浏览器与 Workers 用量按实际服务记录。

## 长流中断诊断

研究适配层新增独立 `comparison_dispatch_stream_diagnostics`，记录传输层返回的 HTTP 状态、响应头和最后收包／完整帧时间、字节与帧计数，以及传输打开失败、HTTP 拒绝、上游 EOF、原生错误事件、帧或用量不合格、本地期限、请求取消和下游取消等类别。传输层也可能返回本地权限拒绝或限流状态，因此 HTTP 状态和传输打开失败都无法证明请求已发往供应商。原生错误类型和代码只保留明确允许的枚举；不保存正文、思考、请求头或密钥。诊断写入失败不改变流字节、结算、未知状态或重试政策。

该记录是后续请求的观测能力，不能补造首题缺失的流事件。两臂中断时长相近只表明共用链路值得排查；目前不能断言具体供应商或 Cloudflare 层存在 180 秒上限。先用独立、无供应商请求的长流夹具检查静默、心跳和缺失终止帧，保留真实墙钟时长及环境。合成链路通过也不能代替实际渠道或成品质量验证。

`syntheticKeepalive` 仅允许 `rehearsal` 授权显式启用：在首个完整原生帧之后、下游正在等待读取时，每 10 秒插入固定 SSE 注释；一个源读取和一个定时器，不延长绝对期限。原生诊断不计本地保活，终止帧仍等待结算。正式授权拒绝此选项。旧 A 读取器会把任意数据块视为活动，后续若采用正式保活，必须先在传输接收端隔离本地标记，避免将其冒充模型进度或供应商活动。

独立云端合成实验中，无心跳的两个响应约 60 秒被下游取消；原生心跳及显式开启的合成保活均维持到 195 秒完整结束。合成保活下，源在 183 秒缺少终止帧直接结束时仍正确记为未知，实际输出用量保持空值。原生字节摘要与计数独立于本地保活。实验未经过真实供应商、生产候选转发或 CCB 容器，因此不解释正式请求约 182 秒的中断，也不构成已修复证明。临时实验 Worker、DO 和本地签名凭据均须独立验证清理。

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
