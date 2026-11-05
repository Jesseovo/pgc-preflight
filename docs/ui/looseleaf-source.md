# Looseleaf 来源与本地适配

- 上游：<https://github.com/kevintngo/looseleaf>
- 固定提交：`4bdb647940e2fefb3cebb394f3bad25c766a27d2`
- 许可证：MIT，原文保存在 `src/ui/vendor/looseleaf/LICENSE`。
- 采用方式：源码导入，不依赖上游网站运行，不使用同名第三方 npm 包。

实际采用 Button、Input、Textarea、NativeSelect、Card/Paper、Dialog，以及它们依赖的笔触、种子、几何、缓存、SVG、Radix 交互实现。统一封装在 `src/ui/components/ui.tsx`，页面按角色和栏目延迟加载。

本地适配记录：

1. 中文正文、表单、数字使用系统字体；Kevin Sans 仅用于少量标记，woff2 由本站打包。移除未使用的 IBM Plex Mono 字体导入，字体使用 `swap`。
2. `ensureInkFonts()` 不再加载上游 CDN，所有字体来自本地构建资源。
3. Dialog 关闭按钮改成中文；应用封装补充 44px 触控区域、焦点返回、窄屏滚动及错误信息。
4. 两份纹理生成文件中的 PNG 从 Base64 字符串改成静态资源导入，保持原始 PNG 字节不变，便于浏览器缓存并减小 JavaScript 解析负担。
5. 按用户预览反馈取消大面积纸纹。白底、细边框和深灰表单文字通过 PGC 语义变量统一；手绘能力主要保留在按钮和少量边缘。
6. 文件输入使用应用级可访问封装，原生文件 input 负责实际选取，额外显示文件名和格式说明。
7. NativeSelect 补齐 `border-0`，防止不支持 `base-select` 的浏览器叠加原生边框。应用表单统一由一个 CSS 外框负责悬停、焦点、禁用与错误状态，隐藏重复的笔触外框和箭头分隔线，保留原生选择、键盘及移动端选项交互。

没有修改上游许可证，没有引用上游演示页面、第三方远程字体或远程素材。后续升级需重新固定提交、核对上述适配并执行浏览器回归。
