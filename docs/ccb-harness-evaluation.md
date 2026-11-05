# CCB Harness 离线对照

六个新合成策划涵盖节拍点击、连续拖动、策略取舍、碰撞反馈、难度与重开、小屏密集布局。每个策划有独立的完整简报、SVG 样板、内联绘制素材和预登记试玩清单。准备工具复制并冻结原字节及 SHA-256。基线 A 固定线上发布提交 `8afbf81c85c785f5d2d071dda9ecedba510b42ab`。B 固定 Cloudflare 托管镜像的完整摘要 URI、PGC 实现提交和 CCB 上游 `963e0013184ecc1521289a0fc7d5da4bb6e45356`。两组使用同一创作模型配置及相同材料。B 预登记 adaptive/high、每请求最多 64,000 输出 Token、每任务最多 256,000 输出 Token、40 分钟、24 次模型轮、2 次修复。该设计比较两套不同预算的工作流，无法分离 Harness 本身的因果效果。

十二个制作槽位均保留。审核对照固定使用六个 B 成品的原始字节。每题只采集一次正式基础证据，原后台审核与新后台审核分别对同一 HTML、四张原始完整视口图及探测记录执行初评与同模型复核。任何缺失的 B 成品均保留在分母，禁止替补。六个合成样本无法估计真实审核准确率或证明 80% 目标。此文件记录评估协议，真实运行结果由后续私有记录提供。

## 操作

```sh
RUN=artifacts/ccb-harness-evaluation
mkdir -m 700 -p "$RUN/inputs"
npx tsx scripts/harness-evaluation.ts prepare --out "$RUN" --settings "$RUN/inputs/settings.json"
npx tsx scripts/harness-evaluation.ts import creation --out "$RUN" --input "$RUN/inputs/creation-record.json"
npx tsx scripts/harness-evaluation.ts packet creation tap-rhythm B --out "$RUN"
npx tsx scripts/harness-evaluation.ts import creation-judgment --out "$RUN" --input "$RUN/inputs/creation-judgment.json"
npx tsx scripts/harness-evaluation.ts import review-input --out "$RUN" --input "$RUN/inputs/review-input.json"
npx tsx scripts/harness-evaluation.ts import review --out "$RUN" --input "$RUN/inputs/review-record.json"
npx tsx scripts/harness-evaluation.ts packet review tap-rhythm B --out "$RUN"
npx tsx scripts/harness-evaluation.ts import review-judgment --out "$RUN" --input "$RUN/inputs/review-judgment.json"
npx tsx scripts/harness-evaluation.ts report --out "$RUN" --save evaluation.json
```

去掉 `--settings` 可预演清单并查看空结果。实际运行前应以另一个新目录冻结正式设置。脚本只组织材料和导入记录，不调用模型、浏览器、上游或生产。前置的生产使用权与供应商兼容性初始均为 false。若取得真实证据，使用 `import prerequisite` 分别确认。授权记录须明确涵盖生产使用，兼容性记录须来自所选供应商和配置的真实核验。两项状态与质量判定分开。

评估协调员保管 `manifest.json`、`registration.json`、`mapping.private.json`、全部执行记录和原始材料。制作执行者按私有清单获得两组各自的任务。独立观察员只接收一个 `blind/<随机编号>/` 目录及本协议的裁决方法，使用新的独立上下文，避免读取同一题目另一结果、私有映射、历史、Creator 自检、作者身份和模型记录。包内原始游戏标题属于可观察内容。协调员在导入时核对 HTML、正式截图、探测记录、报告和关键问题证据无实验身份或自检泄漏后才声明 `blindSafe`。若原始 HTML 自带这些信息，保留原文件和失败状态，不能修改字节后宣称原版本通过盲评。盲包复制已核验文件，原文件名被替换。文件哈希保护一致性，独立性、测试真实性和披露范围由流程保证。同一系统用户可越过目录约定，目录本身不构成安全沙箱。

游戏用项目已有的隔离浏览器、可信触摸与禁外部网络策略试玩，关闭试玩后退出浏览器。观察员先实际读取截图，再在后续调用写观察。仅有动画变化不足以证明输入响应。盲评覆盖开始、有效与无效操作、成功、失败、重开以及三种预登记手机尺寸。验收需要操作和画面证据，可按实际需要补源码行段；任意缺陷不由文字关键字或字段位置自动裁决。审核关键问题目录由独立观察员在看到两组预测前锁定，针对同一 B 成品并记录复现证据。目录和裁决不得作为审核模型材料。

## 私有记录结构

所有 `import` JSON 都要包含 `manifestSha256`。任何文件引用都是 `{"path":"inputs/名称.ext","sha256":"原始字节摘要"}`，仅允许本次运行目录内的普通文件。程序再次核对字节，导入槽位和盲包只写一次。已有错误记录保留，复跑用新的清单与目录，揭盲后用于调整的样本归入回归。

- **设置。** `creationModel` 与 `reviewModel` 各含 `name` 和 `config` 脱敏配置快照文件引用，独立于两臂自身的预算。另填完整 `harnessCommit`、`harnessImage` 摘要 URI、`rulesVersion`、`rules` 和 `calibration` 文件引用。文件不得记录模型 Key、登录凭据、设备租约或思考正文。
- **通用执行字段。** `caseId`、`arm`、`implementationCommit`、`status`、`startedAt`、`finishedAt`、`failure`。状态为 `completed`、`failed`、`missing`。开始和结束用实际 ISO 时间，未执行或未知的两项同时填 null。完成的 `failure` 为 null，失败或缺失需给脱敏代码。缺失槽位也可保留为空。B 的每份制作和审核记录填写冻结的 `image` 摘要 URI，A 省略此字段。
- **阶段。** `phase`、`status`、`startedAt`、`finishedAt`、`failure`、`inputTokens`、`outputTokens`、`usageEvidence`。每次实际模型请求均保留记录，截断或失败同样保留。Token 从脱敏用量凭据填写，输出须含供应商计入输出的思考 Token，未知填 null，零仅用于确证为零。请求与执行结果可另附脱敏记录。
- **制作。** 通用执行字段外填 `materialSha256`、`modelConfigSha256`、`stages`、`html`、`blindSafe`、`attachments`、`controllerUsage`。完成需最终交付原始 HTML 引用。无交付填 null，私有附件数组可为空。B 的 `controllerUsage` 用 `turns`、`repairs`、`evidence` 引用实际控制器计数。A 或未知填 null。阶段用量或 B 控制器计数缺失会阻止通过预算验收。
- **审核输入。** 填 `caseId`、`htmlSha256`、`probe`、顺序固定的四个 `shots`、`evidenceSha256`、`blindSafe: true`。证据摘要为 `JSON.stringify({html,probe,shots},null,2) + "\n"` 的 SHA-256，其中 html、probe 是字节摘要，shots 是摘要数组。另填独立声明、`catalogExhaustive: true`、`catalogEvidence`、`catalog`、`disputes`。目录每项有 `id`、`observation` 和至少一份 `evidence`，证据限已脱敏 PNG、JPEG、文本或 JSON。无关键问题时目录可为空，仍须有覆盖证据。先导入锁定，再启动两路正式审核。
- **审核。** 通用执行字段外填 `initial`、`verify`、`initialReport`、`finalReport`、`blindSafe`、`attachments`。未到达的阶段和报告填 null，报告引用完整 v2 JSON。两个阶段都带 `htmlSha256`、`evidenceSha256`、`modelConfigSha256`、`rulesSha256` 和 `calibrationSha256`。B 的初评与复核阶段各带同一 `image` 摘要 URI。复核另带本次初稿的 `initialReportSha256`。报告盲包只提供终稿，初稿和请求记录保留于私有目录。A 与 B 的正式审核使用同一锁定审核模型配置。
- **独立声明和裁决。** 独立声明填 `independent: true`、`observerType` 为 `human` 或 `independent-agent`、`observerId` 为无个人信息编号。盲包裁决另填 `packetId`、`packetSha256`、`blind: true`、`coverageComplete: true`、非空 `coverageEvidence`、`disputes`。制作裁决提供 `checks`、`criticalDefects` 和 `unapprovedCoreChanges`。审核裁决提供 `mandatoryRemediations` 和 `criticalHits`。每项都填 `id`、`observation`、`state`、`evidence`。确定裁决需至少一个证据文件。
- **裁决语义。** `checks` 中 verified 表示实测符合，failed 表示有证据证实未达标。缺陷和核心变更项中 verified 表示已确认存在，failed 表示核查后排除。审核员按原子声明覆盖终稿全部字段，逐条登记所有强制整改并引用报告文字和原始证据。verified 表示强制整改有已确认依据，failed 表示无依据。关键命中按独立目录逐项登记，verified 表示终稿实际命中，failed 表示遗漏。所有类型都允许 unknown 和 disputed，未知与未决均阻止验收。
- **前置条件。** `name` 为 `rightsConfirmed` 或 `providerCompatibilityVerified`，另有 `confirmed: true`、`observerId`、`confirmedAt` 和非空 `evidence`。

## 判定

每组报告制作和审核各六条，区分完成、失败、缺失，保留实际耗时、逐阶段用量、原始证据和裁决引用。B 六款全部完成并且所有核心要求获独立证据确认，才进入可通过状态。已确认关键缺陷数、未批准核心改动数、无依据强制整改数不得增加，已确认关键问题命中数不得下降。预登记的操作、反馈和布局三指标至少一项改善，其余不得下降。基线已达所有指标上限时，登记为 `controlCeiling`，不能宣称质量改善。没有关键问题时该项分母为零，不形成召回率结论。缺失配对、未知或待决裁决计为 `not-ready`。质量结论与生产前置条件都有证据时，报告才返回 `releaseReady`。真实上线仍走项目的明确授权和发布流程。
