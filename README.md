# JaxApi 媒体台

已有 jaxapi.top 账户的生图页面，加上一个标明的本地视频模拟。生图仍走中转站；视频不会发给 jaxapi.top 或 SuperGPT。

## 本地运行

```bash
npm install
npm run dev
```

打开 [http://127.0.0.1:43123](http://127.0.0.1:43123)。`/preview` 不登录，视频页也可以提交模拟任务。

```bash
npm test
npx tsc --noEmit --incremental false
npm run build
```

## 生图

登录后自动使用分组名为「媒体台」、名称为「JaxApi 媒体台」的密钥。选择按分组名，不写死分组编号。页面只列出 9 个生图模型，每次固定 1 张。预估是模型绝对售价，不再乘个人倍率。同步请求等待最多 10 分钟。参考图走 `/v1/images/edits`。

## 视频

视频区只列出 17 个模型，时长和分辨率来自价表，售价是成本×2 的绝对档位价，模拟账本忽略客户端传来的折扣。

公开的 SuperGPT 帮助只记录了 Chat Completions、Responses 和 Messages，没有视频 endpoint、字段或任务状态。Sub2API `5c2982a81b46e2142d0143d2f83c1ce9c4da1d24` 对 openai 平台的 `/v1/videos` 返回 404，计费时长又被限制在 1–15 秒，分辨率只有 480p/720p/1080p，单价是美元/秒。因此这里没有真实 adapter。`/api/jax` 不再转发任何视频路径。`requestVideo()` 会直接拒绝。

本地 `/api/mock/videos` 用内存账本演示提交、轮询、播放、下载、失败退款、超时不重提、同一幂等键不重复扣费，以及别人不能读取任务。页面上写明这是模拟，账户余额数字不会被改写。提示词里的 `[[fail]]` 和 `[[stall]]` 只影响模拟。

审查用的限制和尚未应用的后台要求见 [docs/VIDEO_STATUS.md](docs/VIDEO_STATUS.md)。

密钥和登录令牌不写入界面、日志或模拟请求。
