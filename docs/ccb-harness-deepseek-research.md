# CCB DeepSeek 审核渠道兼容研究

`ccb-deepseek-review-tool-v1` 锁定脱敏配置记录中的审核模型合同。指定模型是官方 Chat Completions 的 `deepseek-flash`，视觉开启，实际思考强度 low。合同变化时停在研究计划校验。每轮输出上限 8,192 Token，累计 16,384，最多两个请求，重试上限为零。

夹具首轮传两张固定合成 PNG，要求读取一份固定工作区文本。第二轮原样带回图片，并携带第一次流中实际收到的 `reasoning_content`、工具调用及本地工具结果。显式空 `reasoning_content` 的回传只证明字段保留。网关依锁定夹具设置 JSON mode、thinking 和 effort。研究账本保存一次性关联、用量和供应商助理消息摘要。结构、图片、工具回执或摘要变化会在付费转发前拒绝。完整流结束、用量结算、最终 JSON 和容器销毁都需要确认。

两次请求验证一次工具往返和结构化结果。独立初评与同模型复核需要两个分离的会话和锁定审核证据，留待另一项验证。此夹具只检查两张合成图的颜色和工具回执，审核准确度和真实审核流程验收另行记录。

本地用固定 CCB 构建和 Node 24.16 运行 `scripts/capture-harness-deepseek-fixture.ts <artifacts 中的 cli-node.js> --check-only`。脚本只连本机回环网关，使用脚本 SSE，重新核对两轮原生请求哈希。合成回执记录两轮和 20 个脚本输出 Token，保存在私有 `artifacts/ccb-harness-deepseek-fixture/ccb-deepseek-review-tool-v1/`。Vitest 另用本地容器替身、带签名的 broker 和独立 SQLite 账本验证两轮、拒绝第三次请求及清理。这些本地检查没有真实模型调用。 [DeepSeek 图片输入](https://api-docs.deepseek.com/guides/vision/) · [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)

2026-11-06 首次真实隔离测试发出一次请求，上游返回 HTTP 401，账本为 `provider_rejected`。没有第二轮、自动重试或可用模型结果，供应商 Token 用量保持 null；内部已结算输出计数为 0 不能证明供应商计费为零。代码核查显示请求使用锁定审核配置的服务端解密值构造 Bearer 认证，目的地与原审核路径一致；未发现漏传认证、错组选取或内部租约替代 Key 的实现问题。401 只能确认上游拒绝认证，不能据此确定凭据失效的具体原因。

管理员更新审核凭据后，同日 `run-deepseek-r4` 完成真实两轮验证。两次请求各转发一次，均返回 HTTP 200，分别以 `tool_calls` 和 `stop` 结束；输入 Token 为 1,176 与 1,344，输出为 66 与 25，合计 91，供应商报告其中思考 Token 为 17 与 0。首轮实际助手消息的摘要约束第二轮续传，Native Runner 校验了最终颜色与文件标记 JSON，运行账本完成结算，容器销毁确认。没有自动重试，兼容研究累计请求达到已批准的 9 次上限。此次通过只证明该固定图像与工具夹具的渠道兼容，不代表正式审核质量或完整初评、复核已经验收。

凭据更新后、成功复测前，还遇到管理 API 的 503、只读查询的 429 和候选路由就绪超时；这些尝试未发出模型请求。研究操作器现在对候选路由最多等待 120 秒，并重新核对精确版本及 A100/B0 比例；管理读取遇到 429 时，最多重试两次，至少等待 60 秒并尊重更长的 `Retry-After`，单次读取总期限 180 秒。只有 GET 与指定数据库的 SELECT 读取适用，生产变更和模型请求不自动重试。历史失败回执单独保留。

研究结束后恢复原版全部常规流量，清理容器应用、Worker、DO 命名空间及 D1；研究候选仅保留在非活动上传历史中。原始失败、零调用中断、成功复测及各次独立读回分别保存在私有 `artifacts/ccb-harness-20261106-hardening/` 的对应运行目录，不覆盖旧状态。原版继续运行，灰测尚未切换。

## 后续真实渠道验证的部署边界

只有取得新增付费额度及对应部署授权后，才可按[研究操作手册](ccb-harness-provider-research.md)执行。打包脚本追加 `--deepseek-review`，使用独立候选输出目录。Native Runner 入口使用 `scripts/harness-provider-deepseek-native-worker.ts`，绑定独立研究 D1、独立 Runner、独立短期控制与签名 Secret，核对候选版本和实际绑定后才允许发起。生产配置仅供读取锁定审核模型，容量和限流沿用生产协调表，其他研究记录写入独立 D1。官方 DeepSeek 路径当前未启用 Riffle 名额或共享等待。明确 429 会写冷却记录并停止研究请求。

Opus v2 的夹具、回执和验证范围独立。DeepSeek 路径不改变镜像文件，真实验证仍须使用经批准的固定镜像摘要。
