# PGC 游戏审核 · Agent 接入

用户把这个地址交给 Agent 即可： https://pgc.ovoxin.top/agent.md 。不需要用户下载软件、解压、配置模型或手动上传游戏。以下准备与提交均由 Agent 自动完成。

## 给 Agent 的执行指令

1. 检查 Node.js 22+ 和 Chrome/Edge。优先使用已有环境；缺少时先向用户说明需要的本机环境，由 Agent 准备，不能静默修改系统代理或电源设置。
2. 获取公开的自包含客户端 https://pgc.ovoxin.top/agent/review-agent.mjs ，存到自己的工具缓存或临时目录。它已包含浏览器控制依赖，不需要 npm install。不需要 Windows 常驻助手、插件或计划任务。
3. 若尚未连接，引导用户在已登录的 PGC 审核页展开「Agent 接入」、生成一次性配对码；有已授权浏览器控制能力的 Agent 可协助操作。用本机安全输入或当前进程的 `PGC_PAIR_CODE` 传入配对码，执行 `node review-agent.mjs pair`。不要将密码、配对码或设备令牌发到公共日志、Git 或聊天记录中。配对码 5 分钟一次有效；设备凭据 30 天有效，绑定本人账号，可在网页撤销。Windows 凭据用当前用户 DPAPI 保存，其他系统存于本人目录、权限 0600。
4. 游戏完成后执行 `node review-agent.mjs review /absolute/game.html --out /absolute/reviews`。客户端提交原始 HTML，用独立的无界面 Chromium 采集三种手机比例的四张完整视口图，上传后云端完成模型初评与同证据复核。客户端不持有模型 Key，不运行评分提示词，不替代模型评分。
5. stdout 为 JSON Lines。`submitted` 给出 job ID，`capture` / `progress` 给出真实阶段，`report` 给出模型报告。根据报告向用户说明修改项；用户明确要求修改后再修改游戏。错误写 stderr、退出码 1；不得在未知状态时换 request ID 重发。

```sh
node review-agent.mjs pair
node review-agent.mjs review /absolute/game.html --out /absolute/reviews
node review-agent.mjs review /absolute/a.html /absolute/b.html --out /absolute/reviews
node review-agent.mjs status JOB_UUID
node review-agent.mjs report JOB_UUID --out /absolute/reviews
node review-agent.mjs wait JOB_UUID --out /absolute/reviews
node review-agent.mjs jobs
node review-agent.mjs capture JOB_UUID
```

`review` 会提交、采集并等待报告；`submit` 只提交，`capture` 继续未完成的本机采集。网站上传后，Agent 也可用 `jobs` 找到本人排队任务再执行 `capture`。无需常驻进程。每台设备一次采集一款，上传完即可采集下一款，模型在云端并行运行。关闭 Agent 会停止尚未完成的本地采集，但已上传证据的云端审核继续。等待最多 30 分钟，退出等待不取消云端任务。

同一路径、相同内容在 24 小时内重复命令复用本地 request ID，避免响应丢失后重复扣次。24 小时后会先查询旧任务：终态任务可新建，仍在进行则继续等待。主动发起新一轮审核可用 `--request-id 新UUID`（单文件）；修改内容再提交自然创建新任务。每批 1–20 款，单款 8 MB，本人最多 50 个未完成任务。每日默认 50 次，管理员可调，北京零点重置；初评和复核合计一次，模型启动前的平台失败退次。

## 无 CLI 的 Agent：HTTP 契约

以上客户端为推荐路径，用于保证完整视口证据。有自带浏览器执行环境的 Agent 也可实现以下协议，但必须遵守相同取证方法，不能把最大 Canvas 截图当作完整画面。

所有接口：`POST https://pgc.ovoxin.top/api/review-device/{action}`，JSON；配对后使用 `Authorization: Bearer <device-token>`。这个令牌只访问当前成员自己的任务，不是模型 Key。

| action | body | response |
| --- | --- | --- |
| pair | `{code, deviceId: UUID, token: 64位随机hex, name}` | 设备有效期；同设备同码重试幂等 |
| submit | `{request_id: UUID, filename, title, html}` | 本人 job；同 ID 幂等 |
| jobs | `{}` | 本人最近 24 小时任务 |
| job | `{id: UUID}` | status、stage、error、result_id |
| claim | `{claimId: UUID, id?: JOB_UUID}` | `{id, lease, title, html}` 或 null；仅本人 |
| heartbeat | `{version, freeMemoryMB, job?: {id, lease}}` | 采集期间每 20 秒续租 |
| evidence | `{id, lease, probe, shots}` | 四张 JPEG 完整视口图；证据提交后锁定 |
| fail | `{id, lease, message}` | 只允许模型前本机采集失败 |
| report | `{id: UUID}` | 完成报告；未完成 409、他人任务 404 |

`status`：queued/running/done/error。`stage`：capture/review/verify/done。`probe.captureMethod` 必须为 `browser-viewport-v1`，`shots` 为四个 `{label,data: 'data:image/jpeg;base64,...'}`；取证实现见客户端。服务端始终重新检查账号权限、本人任务租约和额度，忽略客户端模型配置与评分。证据来自成员本机，用于预审，最终人工审核保留。

Cloudflare 免费额度和模型服务商限流仍然适用；不要无限制并发、重复付费请求或把失败当作通过。
