# CCB DeepSeek 审核渠道兼容研究

`ccb-deepseek-review-tool-v1` 锁定脱敏配置记录中的审核模型合同。指定模型是官方 Chat Completions 的 `deepseek-flash`，视觉开启，实际思考强度 low。合同变化时停在研究计划校验。每轮输出上限 8,192 Token，累计 16,384，最多两个请求，重试上限为零。

夹具首轮传两张固定合成 PNG，要求读取一份固定工作区文本。第二轮原样带回图片，并携带第一次流中实际收到的 `reasoning_content`、工具调用及本地工具结果。显式空 `reasoning_content` 的回传只证明字段保留。网关依锁定夹具设置 JSON mode、thinking 和 effort。研究账本保存一次性关联、用量和供应商助理消息摘要。结构、图片、工具回执或摘要变化会在付费转发前拒绝。完整流结束、用量结算、最终 JSON 和容器销毁都需要确认。

两次请求验证一次工具往返和结构化结果。独立初评与同模型复核需要两个分离的会话和锁定审核证据，留待另一项验证。此夹具只检查两张合成图的颜色和工具回执，审核准确度和真实审核流程验收另行记录。

本地用固定 CCB 构建和 Node 24.16 运行 `scripts/capture-harness-deepseek-fixture.ts <artifacts 中的 cli-node.js> --check-only`。脚本只连本机回环网关，使用脚本 SSE，重新核对两轮原生请求哈希。合成回执记录两轮和 20 个脚本输出 Token，保存在私有 `artifacts/ccb-harness-deepseek-fixture/ccb-deepseek-review-tool-v1/`。Vitest 另用本地容器替身、带签名的 broker 和独立 SQLite 账本验证两轮、拒绝第三次请求及清理。真实模型调用为零，真实供应商对图片、工具与 JSON mode 组合的响应仍待验证。 [DeepSeek 图片输入](https://api-docs.deepseek.com/guides/vision/) · [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)

## 后续真实渠道验证的部署边界

只有取得新增付费额度及对应部署授权后，才可按[研究操作手册](ccb-harness-provider-research.md)执行。打包脚本追加 `--deepseek-review`，使用独立候选输出目录。Native Runner 入口使用 `scripts/harness-provider-deepseek-native-worker.ts`，绑定独立研究 D1、独立 Runner、独立短期控制与签名 Secret，核对候选版本和实际绑定后才允许发起。生产配置仅供读取锁定审核模型，容量和限流沿用生产协调表，其他研究记录写入独立 D1。官方 DeepSeek 路径当前未启用 Riffle 名额或共享等待。明确 429 会写冷却记录并停止研究请求。

Opus v2 的夹具、回执和验证范围独立。DeepSeek 路径不改变镜像文件，真实验证仍须使用经批准的固定镜像摘要。
