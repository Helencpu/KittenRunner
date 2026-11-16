# Kitten Runner · 编程猫作品运行器

把 Kitten4 / KittenN 作品拖进窗口就能跑，积木报错也不中断，还能粘贴作品 ID 在线播放。
参考项目：[Demgden/kitten4_player_pro](https://github.com/Demgden/kitten4_player_pro)（本项目未直接复用其 Electron 外壳，而是自己实现了一套零依赖的本地运行时）。

## 快速开始

1. **不需要安装 Node.js** —— 项目自带 `runtime\node.exe`（v22.23.2）。
2. 双击 **启动.bat**：后台起本地服务，并用 Edge 的「应用窗口」模式打开界面（无地址栏、无标签页）。
3. 把 `.bcm4` / `.bcmkn` 文件直接拖进窗口 —— 自动开始播放。

启动脚本查找运行时的顺序：`runtime\node.exe` → 系统 PATH 里的 `node` → `%ProgramFiles%\nodejs\node.exe`。若 7788 端口已在监听，则跳过启动直接开窗口。

手动起（调试用）：

```
.\runtime\node.exe server.js
# 浏览器打开 http://127.0.0.1:7788/
```

## 三种打开方式

| 方式 | 说明 |
| --- | --- |
| 拖拽文件 | 把作品文件拖进首页，自动识别类型并播放 |
| 选择文件 | 点「选择作品文件」浏览本地文件 |
| 粘贴作品号 | 输入纯数字作品 ID，或粘贴作品/作品集链接，在线拉取后本地播放 |

支持格式：`.bcm4`（Kitten4）、`.bcmkn` / `.bcmknk` / `.bcmknh` / `.bcm`（KittenN）。

## 错误隔离：积木报错不会中断作品

图形化运行时的每一帧由 `requestAnimationFrame` 和事件回调驱动。运行器在页面里注入 `patches/resilience.js`：

- 包装 `requestAnimationFrame`、`EventTarget.prototype.addEventListener`、全局 `error` 兜底；
- 单块积木抛异常时**就地吞掉并上报**，调度链继续往下跑 —— 相当于「这块坏了，别的照跑」；
- 异常按「消息 + 来源」去重累计，通过 `sendBeacon`/`fetch` 回传服务端 `/k4p/report-error`；
- 外壳工具栏显示实时错误计数，底部提示「已隔离 N 次，作品仍在运行」，点「错误」可展开抽屉看详情。

刻意**没有**包装 `setTimeout` / `setInterval`：官方 SDK 和本地预编译器对定时器时序很敏感，包装后 K4 的编译器轮询会静默失效（实测舞台直接白屏）。积木的执行本身走帧循环与事件回调，覆盖这两类入口已经足够。

## 性能

- **零转发损耗**：作品数据由本地服务直接返回，官方静态资源全部本地镜像，请求不出网（在线作品只在首次拉取时联网）。
- **K4 编译预置**：本地 `.bcm4` 是编辑器工作区格式，不是运行时格式。运行器在页面侧调用内核自带的 `JSONEntityCompiler` 预编译，把结果回传服务端拼装成完整作品再 reload，播放阶段走官方原生路径，避免了运行时逐块编译。
- **IR 编译缓存（1 号优化）**：编译结果按「文件内容 SHA1」写到 `.cache/ir/<sha1>.json`，同一个文件再次打开直接读盘，**零编译、零 reload**。实测：首次打开（未命中）页面要 reload 一次、`navCount=2`；再次打开（命中）`navCount=1`、日志只有「已有 compile_result，跳过」。缓存保留最近 120 份，按最近使用时间淘汰；文件改一个字符哈希就变，不会读到过期编译结果。首页右上角徽标显示「编译缓存 N 份 · 命中 M」。
- **素材本地化（2 号优化）**：作品 JSON 里的 bcmcdn 素材 URL 在返回给播放器之前，统一改写成 `/asset/<sha1>`。打开作品的同时后台并发预取全部素材落盘到 `.cache/assets/`，播放器加载素材时直接读本地文件、不走网络，返回头带 `Cache-Control: immutable`。实测 florr 在线作品：预取 95 个素材，播放期间本地命中 153 次，只剩少数运行时动态引用的素材需要补拉一次。拉不到时自动 302 回源，行为与原版一致。
- **代码生成器补丁**：注入 `k4/compile.js` 改写 optifun 源码（空块/空表达式内联、折叠死代码、帧字段提为局部变量），让热路径少一层调用。
- **官方性能面板可用**：作品自带的 fps / 每帧用时统计照常工作（截图里 florr 作品显示 fps 6.2，那是该作品本身的计算量，不是运行器开销）。

## 目录结构

```
KittenRunner\           当前目录，整个文件夹即完整程序，可随意搬动
  server.js             零依赖本地服务（单端口伪装官网）
  shell\index.html      运行器外壳：首页 / 拖拽 / 播放 iframe / 工具栏 / 错误抽屉
  k4\                   官方 player_v2 静态资源 + 本地预编译器
  kn\                   官方 KittenN 运行时（neko）本地镜像 + 宿主页
  patches\              页面注入补丁：错误隔离、网络同源改写
  runtime\node.exe      内置 Node 运行时（不需要另装 Node）
  samples\              测试作品（可直接拖进去验证）
  启动.bat              双击即用
```

首次运行会自动生成 `.cache\`（作品副本、编译缓存、素材缓存），可以随时整个删掉，下次重新积累。

## 实现要点

- **单端口伪装**：`/kn/build/*` 托管官方资源；`/new/client_config.json` 把 creation/api 接口全指向本地；`/new/<token>` 一个路径兼「播放器宿主页」与「作品 JSON」，靠 `Sec-Fetch-Dest` 与 `Accept` 区分。
- **本地 .bcm4 归一化**：按 `scene.group_order` + `theatre.groups[id].actors` 展平并反转，补场景角色层（原文件里 `actors` 为空数组，直接喂给播放器是致命错误）。
- **KittenN 走官方运行时**：伪造 `work-detail` 响应把 `work_url` 指向本地；页面侧改写 `XMLHttpRequest` / `fetch`，把 `api-creation.codemao.cn` 等域名转成本地同源路径，由服务端 https 反向代理转发（绕开 CORS，SDK 才能初始化）。
- **双标识**：Kitten4 用 16 位 hex token；KittenN 播放器会把 workId 当数字解析，因此额外分配 15 位纯数字 id（首位非 0，避免前导零被吃掉），两套索引并行。

## 已知限制

- 外壳是浏览器应用窗口，不是独立的 Electron EXE；想做 EXE 需要额外打包（当前零依赖方案不依赖 Electron）。
- 在线播放依赖官方接口可用；作品被下架/私有会拉取失败。
- 错误隔离能保证调度链不断，但**单块积木自身状态残留**（比如循环里改了变量又报错）不会回滚，属于兜底而非事务。
- KittenN 侧尚未单独做代码生成器补丁（其内核与 K4 同为 cdc-ir，理论可复用，未验证）。
