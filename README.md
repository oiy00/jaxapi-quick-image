# JaxApi 媒体台

已有 jaxapi.top 账户的生图页面，以及一个尚未接通真实扣费的视频流程。生图仍走中转站。视频不会走 Sub2API `/v1/videos`。

## 本地运行

```bash
npm install
npm run dev
```

打开 [http://127.0.0.1:43123](http://127.0.0.1:43123)。`/preview` 不登录，也不会提交视频。

```bash
npm test
npx tsc --noEmit --incremental false
npm run build
```

## 生图

登录后自动使用分组 11「媒体台」、名称为「JaxApi 媒体台」的密钥。分组 7 不会被选中，也不会新建密钥。页面只列出 9 个生图模型，默认 `gpt-image-2.5-flare`，每次固定 1 张。预估是模型绝对售价，不再乘个人倍率。同步请求等待最多 10 分钟。参考图走 `/v1/images/edits`。

## 视频

视频区列出 17 个模型，售价是 `lib/video-models.ts` 里的绝对价，不再乘倍率，也不按标价重算。默认模型是 `muse-video`。

可以提交的只有已完成过的两档：`muse-video` 10 秒，`minimax-h3-base-fast` 10 秒（尺寸 `1344x768`）。其余档位显示售价，但按钮关闭。`/api/jax` 不转发视频路径。浏览器里的 `requestVideo()` 会拒绝。

真实提交使用 Postgres 里的冻结账本：先增加 `frozen_balance`，完成后再同时减少余额和冻结，明确失败只解除冻结，不会把余额加回去。适配器默认 `off`。审查并配置 `media_video_billing` 之后才改成 `postgres`。`/api/mock/videos` 返回 410。

限制和扣费缺口见 [docs/VIDEO_STATUS.md](docs/VIDEO_STATUS.md) 与 [docs/VIDEO_BILLING.md](docs/VIDEO_BILLING.md)。

密钥和登录令牌不写入界面、日志或模拟请求。
