# WebRTC 手工连接 · 文件直传

两个浏览器页面通过**人工复制连接信息（SDP）**建立 WebRTC DataChannel，点对点传输
**一个不超过 5 MiB 的文件**。没有信令服务器、没有应用服务器、文件不经过任何中间机器。

> 两个页面可以是同一台机器上的两个标签页，也可以分处两地 —— 连接信息通过你信任的
> 任意带外渠道（聊天、U 盘、纸条……）复制即可。仅配置了一个公共 STUN 用于 NAT 打洞，
> STUN 只协助发现地址，不转发文件内容。

## 使用

任选一种方式打开页面（需通过 http 提供，`file://` 下 ES Module 可能受限）：

```bash
npm start                 # http://127.0.0.1:8080
# 或任意静态服务器，例如： python3 -m http.server 8080
```

1. 页面 A 选择「发起方」→ 点 **生成连接信息** → 复制文本框内容发给页面 B。
2. 页面 B 选择「应答方」→ 粘贴连接信息 → 点 **生成应答信息** → 复制应答文本发回 A。
3. 页面 A 粘贴应答 → 点 **接受应答**，两端状态都变为「已连接」。
4. A 选择文件（≤ 5 MiB）点 **发送**；B 在进度到 100% 且 SHA-256 校验通过后，
   才会出现 **下载** 链接。任一方都可在传输中点取消。

无法连接（错误 SDP、ICE 失败、对端长时间无响应）或传输失败（通道断开、坏块、哈希不符）
都会**明确显示失败原因**，不会出现“看着成功了其实没传完”的情况。

## 协议

控制消息走 DataChannel 文本通道（JSON），文件数据走二进制通道，同一通道严格有序：

| 消息 | 方向 | 内容 |
| --- | --- | ---|
| `meta` | 发 → 收 | `{ kind:'meta', id, name, size, chunks, hash }` 开始 |
| 数据块 | 发 → 收 | 二进制：4 字节大端序号 + 载荷（载荷 ≤ 16 KiB）|
| `end` | 发 → 收 | `{ kind:'end', id, hash }` 结束 |
| `cancel` | 双向 | `{ kind:'cancel', id }` 取消 |

- 块大小 `16 KiB`，单文件上限 `5 MiB`（见 `src/protocol.js`）。
- 序号从 0 连续递增；接收方校验：块序号完整、每块大小与位置自洽、总字节数等于 `size`、
  拼接后 SHA-256 等于 `meta.hash`（`end.hash` 也必须一致）。**任何一项不符都判失败**。

### 背压

发送方（`FileSender`）在每次 `send()` 后检查 `bufferedAmount`，达到高水位
（`bufferedAmountLowThreshold` 的 4 倍，默认阈值 64 KiB）即暂停读取文件并等待
`bufferedamountlow` 事件，不会一次性把文件塞进发送缓冲；剩余块留在文件中，不占内存。

### 取消、关闭、重连与“迟到事件”

每次传输有随机 `id`，收发双方各自维护一个内部 `generation` 代际令牌：

- 取消 / 通道关闭 / 出错 / 新的 `meta` 都会推进代际并**丢弃半成品**；
- 进行中的读块、等缓冲、异步 SHA-256 回来时先比对代际，过期结果一律作废；
- 旧传输迟到的 `end`、`cancel`、数据块按 id/序号判定，**不能完成或打坏新传输**。

## 代码结构

```
index.html              页面
src/protocol.js         常量、消息编解码、块打包、SHA-256
src/transfer.js         FileSender（背压/取消）与 FileReceiver（校验/丢弃）
src/signaling.js        手工 offer/answer（非 trickle，一段文本即完整 SDP）
src/fake-channel.js     可替换 DataChannel 的测试替身（背压/断开/篡改）
tests/unit/             node:test 单元测试（协议 + 全部传输竞争场景）
tests/page/             Playwright 双页面真实 WebRTC 端到端测试
```

## 测试

```bash
npm test                 # 单元测试（无需浏览器）
npm run test:e2e         # 页面测试：两个真实页面走完整连接+传输流程
npm start                # 手动体验
```

单元测试（`tests/unit/transfer.test.js`）覆盖：

- 正常传输（含空文件、非块对齐文件）逐字节一致；超 5 MiB 直接失败且不写通道；
- **缓冲回落**：慢链路 + 低高水位下反复暂停/恢复，缓冲不无界增长；
- **断开**：传输中途通道关闭，双方明确失败而非伪装完成；之后重连可正常传输；
- **坏块**：块头损坏、块大小不符、内容被改导致哈希不符，均失败且不提供下载；
- **取消竞争**：背压等待中取消不挂起、双方丢弃半成品；接收方拒收会让发送方停下；
- **重连/迟到事件**：新 `meta` 清空旧块，旧 id 的迟到块/`end`/`cancel` 不影响新传输。

页面测试（`tests/page/transfer.page.test.js`）打开两个 Chromium 页面，人工式复制
offer/answer 建立真实 DataChannel，发送一个多块文件并在接收页面触发真实下载，
独立复算大小与 SHA-256；另含传输中取消用例。查询参数 `?ice=host` 只用本地 host 候选，
`?chunkDelay=ms` 为发送每块增加延迟以制造可取消窗口（仅测试用）。

> 在没有 root 的环境里，页面测试需要的 Chromium 动态库可解压到用户目录，
> 由 `tests/page/browser-env.js` 通过 `LD_LIBRARY_PATH` 注入。
