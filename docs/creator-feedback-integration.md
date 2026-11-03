# Creator Hub 专用反馈集成

本次只完成本地实现与验证，未执行生产迁移、Secret 配置、部署或启用。`wrangler.jsonc` 中 `CREATOR_FEEDBACK_ENABLED` 默认是字符串 `"false"`。此文档描述当前代码及后续发布步骤，不代表服务已经上线。

## 授权与数据用途

服务端只访问固定入口 `https://creator-hub-7mi.pages.dev/api/integrations/feedback/v1`，使用管理员在来源站创建的专用集成凭据。凭据通过服务端 Secret `CREATOR_FEEDBACK_TOKEN` 提供，与成员个人 Creator Hub 登录令牌、创作授权、模型 Key 和 PGC Agent 设备凭据相互独立。不得收集成员个人登录令牌，也不代成员登录来源站。

来源授权决定可读范围：全站普通游戏或明确的作者白名单，排除委托游戏。全站范围中的匿名作者、作品、版本、审核修订和留言是脱敏研究资料，不等于已识别团队成员的完整业务明细。匿名标识在该集成内稳定，不能按标题、作者匿名 ID 或分数猜测团队身份和投稿关联。自由文本仍可能包含未识别的身份线索，发布校准案例前需要人工复核。

本阶段只读取反馈与候选规则。没有管理员页面 UI，只有管理员查询与关联 API。集成不调用模型、不下载 HTML/ZIP 或文件元数据、不推导已复现缺陷、不自动发布规则或校准案例，也不向成员开放这些研究资料。原 AI 报告、`review_human_reviews`、广场记录及发布流程均不被此集成改写。

成员 Agent 的既有 `human-review` 回填继续使用成员当前授权会话，遵守原设备租约、准确投稿关联和终审要求。服务端专用反馈缓存是独立流程，不替代该回填，也不触发广场入场。

## 保存与同步

`0026_creator_feedback.sql` 新建独立的状态、游戏索引、分片、事件和关联表，表名统一为 `creator_feedback_*`。服务端只保存凭据摘要用于轮换识别，不在这些表中存放明文 Secret。游戏与规则分片保存来源白名单数据；文件字段只保留已登记字节数，不保留存储路径、下载地址或文件凭据。

同步由单例 `CreatorFeedbackRunner` Durable Object 执行，绑定名为 `CREATOR_FEEDBACK_RUNNER`，DO 迁移标签为 `v3-creator-feedback`。两分钟 cron 仅唤醒此单例，原每小时维护路径保持独立。DO 按持久 `nextRunAt` 恢复；正常增量间隔为 120 秒，连续分页至少间隔 5 秒。唤醒不缩短已有退避 alarm。这里没有浏览器跨标签锁、模型调用或普通 Queue 长任务。

首次同步先持久化 UUID 幂等键，再创建一致性快照；网络恢复沿用同一键。按原 `nextAfter` 完成快照分页后，从快照原始 `scopeRevision:sequence` 游标进入增量。游标水位线与快照必须一致，空事件页也保存响应游标。事件序号全局递增但允许间隔，不能用返回条数计算下一游标。

增量事件携带查询时的当前作品状态，不是事件发生时的冻结整份作品。缓存以作品 ID 更新，保留实际收到的审核 ID 与修订号历史；历史列表不能冒充完整事件时间线。页内数据、去重记录及游标原子提交。generation、凭据摘要、租约和到期检查阻止旧响应在清理、轮换或失去租约后重新写入。管理员读取返回前也检查 generation；分页列表是当前缓存，不是冻结评估导出，`complete=false` 表示全量尚未完成。

## 原始语义

- `0`、`null`、空分数数组、空意见和原总分分别保留；`updateNote=null` 不改成空字符串。不补零、不修复总分、不从总分推导通过结论。
- `pre_review` 与 `decision_review` 是来源审核阶段。`decision_review` 可能包含组长退回或管理员审核，不能等同于真人终审或终审通过。
- `historicalBaseline=true` 的接入前资料可能无法确认更早修订及当时审核角色；`reviewerRole=null` 保持未知。未知 `ruleVersion`、历史规则覆盖和无时区历史时间同样不补造。
- 规则 ID 与版本的 `ruleVersion` 可以为数字，保留原类型；详情接口的单层 `{game: ...}` 包装单独解析，不将包装中的其他字段并入作品。
- 审核的 `effective`、`deleted`、`revoked`、`reopened` 及作品的 `archived`、`deleted` 按原值保留。归档和删除是独立标志；来源 `operation=removed` 触发本地授权副本清除。留言可包含 `workId`，`versionId=null` 不能归到某个投稿版本；来源未提供 `deleted` 时省略，不补 `false`。
- 规则返回值只是候选，管理员接口明确返回 `published:false`。只有现有规则导入、差异核对与显式发布流程可以改变活动审核规则；已锁定任务和历史报告不随候选更新而改变。

## 管理员 API

前缀为 `/api/admin/creator-feedback`。全部接口要求有效超级管理员 Cookie；匿名、成员 Cookie、任何 `Authorization` 请求头均被拒绝，即使同时携带管理员 Cookie。POST 必须提供与请求 URL 同源的 `Origin`。响应使用 `Cache-Control: no-store`。状态不回传 Secret、凭据摘要、上游错误正文或研究原文。

| 方法与路径 | 当前能力 |
| --- | --- |
| `GET /status`（或前缀根路径） | 启用/配置状态、同步阶段、完成标志、游标范围版本、时间及脱敏错误码 |
| `GET /contract` | 读取已缓存的授权契约，返回 `{generation,contract:{contract,fetchedAt,source}}`；不发起新的上游请求 |
| `POST /sync` | 唤醒持久同步；返回 `scheduled`，不表示已经完成，不绕过退避或撤销状态 |
| `GET /games?after=game_...&limit=20` | 当前缓存 ID、序号与下一页；默认 20，范围 1–50；不返回游戏正文 |
| `GET /game?id=game_...` | 指定匿名作品、当前状态及实际收到的审核修订历史 |
| `GET /rules` | 已同步的候选规则与历史覆盖；首次规则刷新前可能为空，不发布 |
| `POST /link` | 核验并保存原 AI 任务与准确作品、投稿版本的关联 |
| `GET /job?jobId=...` | 读取已关联准确版本的来源审核、修订历史，以及原 AI 分数/维度；两种独立判断并列呈现 |

`/link` 只接受最多 4096 字节的 JSON 对象及以下四个字段；以下为合成示例：

```json
{
  "jobId": "synthetic-existing-task",
  "workId": "synthetic-known-work",
  "versionId": "synthetic-known-submission",
  "matchedBy": "published-record"
}
```

`matchedBy` 只允许 `published-record` 或 `user-confirmed`。`workId`、`versionId` 是调用方已有的准确作品和投稿版本编号，不按同名猜测。接口先查原任务，从任务读取 `owner_id`，不接受调用方指定所有者；已有旧真人回填关联冲突时拒绝换绑。

核验依次检查来源 contract 的 scopeRevision、`identity(knownSubmissionId)` 与 `game(knownWorkId)`，确认返回的匿名版本确实属于该匿名作品，且该准确版本已经存在本地授权缓存，再写入关联。关联一旦建立不能换绑；重复同一关联不会覆盖。写入和返回受 generation、凭据、当前授权作品存在性约束，防止撤销或 removed 事件期间产生失效关联。

## 删除、错误与恢复

| 情况 | 本地行为 |
| --- | --- |
| 来源 `removed` | 删除该作品的当前副本、收到的审核修订和关联；事件仅保留去重 ID，清除作品关联 |
| 来源 401 | 清除私有缓存与关联，进入 `auth_revoked` 并停止 alarm；反复唤醒或关闭再开启不能恢复，需更换有效专用凭据 |
| contract 范围版本变化或来源 409 | 清除旧授权缓存与关联，重建全量快照；旧准确关联需重新核验 |
| 来源 410 | 清除过期快照相关缓存与关联，重建快照 |
| 来源 429 | 至少等待 60 秒，并遵守更长的 `Retry-After`，保留同步检查点 |
| 来源 5xx、格式/网络/大小错误 | 保留已提交检查点，持久指数退避；不能当空结果推进游标 |
| 专用凭据轮换 | 检测摘要变化、递增 generation、清除旧缓存与关联，重新建立快照 |
| 关闭功能或缺少/空白 Secret | 管理员资料读取被拒绝；已有 Runner 在下一次唤醒或 alarm 清理缓存并停止；清理失败保留两分钟恢复 alarm |
| 数据库临时失败 | 页提交原子回滚，游标不提前推进；Runner 保留安全恢复 alarm，不记录私有正文 |

客户端固定来源、拒绝重定向、按流限制响应字节，并将超时覆盖到响应体读取完成；即使传输忽略 signal 也结束调用并取消可取消的流。错误使用固定消息，不回显响应正文、请求头或 Secret。客户端不自动重试；重试由持久同步状态管理。

当前没有公开的清库、重置或删除 API。需要主动维护时，由获授权的运维代码调用 `purgeFeedbackData`，必要时携带 `expectedGeneration` 防止旧操作清除新授权数据；不要手工删除游标后保留旧研究正文。停用并不代表来源原始记录被删除。PGC 缓存恢复必须通过仍有效授权重新读取，不恢复已撤销的私有副本。

## 本地真实接口验证

`scripts/verify-creator-feedback-local.ts` 使用真实客户端与同步核心、本地 SQLite 适配器完成快照分页和增量衔接。专用凭据只从标准输入读取，由 Agent 通过子进程 stdin 提供，不放入 argv、环境变量、脚本、终端历史或文件。脚本只允许 contract、snapshots、games、changes、rules 五类上游路径；不请求文件或模型。

输出目录默认为被 Git 忽略的 `artifacts/creator-feedback-local/`，可通过第一个参数指定本地私有路径。目录权限为 0700，文件为 0600。保留 `feedback.sqlite` 检查点可断点续跑；输出 `verification.json`（覆盖量和边界）、`contract.json`（来源契约）及 `feedback-export.json`（来源判断与规则，包含完成状态）。数据不提交仓库，不向成员共享。未完成时 `complete=false`，不能将已缓存部分宣称为全量。

本地 SQLite 适配器验证不能替代实际 D1/DO 部署验证；测试期间不修改来源业务记录，因此增量修改、撤销、乱序等主要通过合成回归验证。来源意见也不能直接当作缺陷复现答案。

## 后续发布步骤（本次未执行）

1. 取得单独的发布与启用指令，确认来源专用集成范围。不要上传成员个人令牌；凭据不进入命令参数、日志、代码或仓库。
2. 备份生产 D1，核对原成员、设置、AI 报告、真人回填和广场数据的基线。先应用 `0026_creator_feedback.sql`，确认不会改变既有表数据。
3. 完成本地回归、类型检查、构建及部署 dry-run。发布时保留原变量和 Secret，应用 `v3-creator-feedback` DO 迁移、绑定和两分钟 cron；先保持 `CREATOR_FEEDBACK_ENABLED="false"`，核实生产实际值，不能只根据本地配置推断。
4. 通过安全 Secret 输入配置 `CREATOR_FEEDBACK_TOKEN`，在明确授权启用后才将开关设为字符串 `"true"`。由管理员 Cookie 调用状态/唤醒接口，核对真实部署资源、绑定与全量→增量完成状态。
5. 线上验证权限拒绝、来源限流/撤销处理、准确版本关联与既有数据不变；只记录脱敏操作证据。确认没有模型请求、文件下载、自动规则/案例发布或广场写入。实际时效取决于来源与重试，不能把两分钟调度宣称为保证送达时间。

本地合成测试只能证明协议、权限和恢复行为，不能证明真实审核意见准确、缺陷已经复现、模型质量改善或生产已经完成发布。上线证据需在实际迁移、部署、启用和线上验证之后另行记录。
