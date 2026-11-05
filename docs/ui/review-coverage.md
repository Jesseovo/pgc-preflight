# Looseleaf 审核与游戏广场

此文档记录独立 React 预览中审核和广场入口的行为与接口对应关系。

## 成员审核

| 行为 | 接口与界面 |
| --- | --- |
| 近期任务、原任务聚焦、恢复 | `GET /api/forge/review/jobs` 一次读取当前成员的任务批次。通过 `?task=<id>` 聚焦，列表未覆盖的明确任务链接按原编号查询 `GET /api/forge/review/jobs/:id`。 |
| 更新频率 | 有平台正在执行或成员设备近期正在采集时每 10 秒读取，等待 Agent 回传或尚无任务时每 60 秒读取。隐藏页暂停，恢复可见或联网时重新读取，失败按 15、30、60 秒退避。读取失败停止滚动计时，已取得的列表保留并标明状态暂不可用。 |
| 报告完成数与进度 | 批次使用真实的已完成数量，运行中的任务使用不定进度和提交后的墙钟时间。React 与旧工作台复用 `public/forge/progress.js` 的进度状态和耗时格式化。旧托盘与样式按旧界面实际使用时初始化。 |
| 继续原任务 | 任务等待采集、初评或复核时可复制含原任务 ID 的继续指令。失败显示原因，若需重做由成员明确请 Agent 发起。 |
| 批量及单项移除 | `DELETE /api/forge/review/jobs/:id`，只对已结束任务展示，批量移除汇报部分成功，已发布报告仍在历史。 |
| 历史与报告 | `GET /api/forge/reviews` 按名称与结果筛选已返回的记录，`GET /api/forge/reviews/:id` 按需打开报告或导出。支持 `?report=<id>`，当前筛选随链接保存。报告和修复指令支持复制，分别可下载 Markdown 与纯文本。批量导出仅收录实际成功读取的报告。 |
| 移除个人报告 | `DELETE /api/forge/reviews/:id`，确认后从个人记录移除，由服务端保留管理员原始记录并处理关联任务。 |
| 接入与撤销 | `GET /api/forge/review/worker-status`，`POST /api/forge/review/device/pairing` 与 `POST /api/forge/review/device/revoke`。配对码只存在当前界面内存，按返回的有效期倒计时，已配对、过期或离开界面时移除。 |
| 角色与路由 | 普通成员使用 `/` 的 `tab=tasks\|history\|devices`，Star 使用 `/forge/?tab=review` 的 `reviewTab=tasks\|history\|devices`。成员页面提供 Agent 指令与授权管理。HTML 提交与报告回传仍由 Agent 完成。 |

## 共用报告

`ReportView` 接收服务器授权返回的完整报告。历史 v1 和规则锁定的 v2 均展示原始评分。v2 中的数值 0 保留，null 显示「待判断」，未完成评估显示「待复核」。AI 模拟审核与 Agent 回填的组长预审、真人终审分别呈现。v2 的已证实缺陷、体验评价、待验证问题与可选优化分区展示。可点开可识别的截图引用，查看原图与已有采集元数据。报告来源、规则、采集方式和时间来自实际记录，增强试玩的运行时间与暂停墙钟时间分开。管理员可展开授权接口返回的原始采集元数据。显示与导出均将内容按文本处理。

## 游戏广场

| 行为 | 接口与界面 |
| --- | --- |
| 浏览、搜索、翻页 | `GET /api/square/games?q=…&page=…`，搜索标题或作者，URL 保留查询和页码。仅显示服务端当前可见的投稿版本。 |
| 试玩 | 打开作品时重新请求 `GET /api/square/games/:id`，再用 `HEAD /api/square/games/:id/preview` 核对文件可用性。共享 9:16 播放器以 `sandbox="allow-scripts"` 加载服务器隔离预览，关闭和离开页面时卸载 iframe。 |
| 管理员下架和取消下架 | 仅管理员可以切换 `scope=manage` 并向 `POST /api/square/games/:id/visibility` 提交 `hidden`。重新公开仍依赖服务端当前终审结论。 |

广场界面展示标题、作者、真人终审分数和通过时间。供成员试玩的播放器使用服务端原有的禁网 CSP，并保留现有身份与可见性校验。


## 本地浏览器验证

运行 `npm run test:ui`。使用本地 Chromium 与 Playwright WebKit，针对合成 SQLite 资料验证主要路由、窄屏与横屏、200% 文字放大，以及审核与试玩交互。检查只读导航请求、浏览器异常和模型调度。结果与截图写入忽略的 `artifacts/looseleaf-verification/`。可使用 `PGC_CHROME_PATH` 指定 Chromium。
