# PGC 内嵌 CCB：验证与发布

本实现把固定 CCB `963e0013184ecc1521289a0fc7d5da4bb6e45356` 的非流式工具执行路径移植到现有 Worker。页面任务仍由 `ForgeRunner` / `ReviewRunner` 的 alarm 执行；不需要容器、镜像、Linux 主机、额外执行服务或成员 Key。移植范围及差异见 [核心兼容清单](ccb-embedded-core.md) 和 [来源记录](ccb-embedded-core-provenance.json)。

## 执行与数据

- 新任务只有通过发布门槛且命中灰测范围时才锁定 v2 `ccb-embedded` 策略。默认配置未启用新引擎；旧策略、旧任务及成员自己的 Agent 保持原执行来源。
- 制作使用锁定的 Opus adaptive/high，单次最多 64,000、累计最多 256,000 输出 Token（含思考）、24 次模型请求、40 分钟总运行时间。每个模型阶段最多 12 分钟。上下文压缩计入同一账本。后台等待名额不发起模型。
- 文件工具仅访问本任务完整材料和输出。局部修改须校验原文件哈希；修改和浏览器工具串行，只读工具可并发。保存完整 HTML 及结构化自检，正式审核不读取创作自检或同版本真人答案。
- 必须先结束完整原生模型响应才能执行工具。思考/签名只在内存中传给后续模型，不保存到报告、日志、DO 检查点或 D1。
- 已封存输出只恢复原结果。未封存、已付费但结果未知的调用停止，不重放、不改模型、不借用另一任务浏览器。
- 需要新增 D1 迁移 `0035_embedded_harness.sql`；它依赖已有 Harness 账本迁移。保存阶段、工具哈希、临时私有文件修订和受控流诊断。正式成品继续由原不可覆盖版本库保存。临时内容到期清理，浏览器清理身份与作品内容分开保留。

## 本地验证

```sh
npm test
npm run build
npx wrangler deploy --dry-run
npx tsx scripts/verify-embedded-harness.ts
PGC_EMBEDDED_BROWSER_TEST=1 npx vitest run tests/harness-embedded-forge-browser.test.ts
```

`verify-embedded-harness.ts` 在本地 Workerd 检查原生模型协议、工具和 D1 账本，模型和浏览器响应为合成数据。`verify-embedded-forge-browser.ts` 使用原 Forge/Review Runner、真实本机 Chromium、三种比例四张完整视口截图，以及脚本模型响应，验证制作、局部修改、版本保存和独立审核链。两者均不调用真实供应商、不修改线上、不能证明模型质量。

真实模型验证须单独记录引擎/代码/完整材料哈希、实际执行 Worker 版本、逐请求结束状态、Token、浏览器证据、失败及停止原因。一款完整制作和独立审核先通过，再冻结六题方案；一款失败先定位，不自动扩大到六题或重放未知请求。沿用已批准累计测试额度，旧容器失败/未知记录仍计账且不覆写。

## 六题与灰测门槛

`scripts/harness-evaluation.ts` 支持单独冻结 `engine: ccb-embedded`、`coreVersion`、`coreBundleSha256`。内嵌记录须逐条绑定该身份；旧镜像记录不能混入新评估。原容器对照脚本从固定的旧 Git 源码运行，只用于复现旧实验。

实际核验通过后，准备普通 Worker 配置：

```sh
npx tsx scripts/prepare-embedded-harness-release.ts \
  --evaluation artifacts/PRIVATE_EVALUATION \
  --evidence artifacts/PRIVATE_EVALUATION/inputs/release-evidence.json \
  --out artifacts/PRIVATE_RELEASE
```

该工具要求干净且准确的代码提交、完整六题裁决、真实创作与审核通道回执、相同 Worker 的隔离证据及原核心对照证据。缺失或失败即拒绝生成；不会把本地合成测试填为质量通过。输出保持现有 Worker/DO 绑定，`HARNESS_ROLLOUT` 初始为 `off`。

正常发布继续使用 GitHub `origin/main`，先备份 D1、检查活动付费任务、应用迁移，再按项目约定使用 `--keep-vars` 部署。只在准确版本验证和验收完成后开启 `pilot`。四位成员的 Star 权限由管理员自行设置。

回退只影响后续新任务：关闭 `HARNESS_ROLLOUT` 即恢复原流程入队。在途已付费任务不换引擎重跑，旧版本及真实模型未知结果保持原记录。部署前应记录可恢复的原 Worker 版本，不能用旧测试时期的版本号覆盖之后的其他发布。

当前实现和本地测试不代表已经完成真实 Opus 成品验证、六题效果验收、灰测上线或 80% 结论准确率验证。约三分钟真实断流也必须用新实际请求诊断，不能由合成测试或去掉容器推断已解决。
