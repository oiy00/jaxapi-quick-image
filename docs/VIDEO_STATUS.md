# 视频协议与计费

本文件记录已核实的限制。它不授权修改生产库，不授权重建 Sub2API，也不授权打开菜单。

## 已核实，并且决定了实现

- 视频上游是 SuperGPT `https://api.supergpt.dev/v1`：`POST /videos`、`GET /videos/{id}`、`GET /videos/{id}/content`。不要走 Sub2API `/v1/videos`，openai 平台上它是 404。
- 分组 11 的按秒价和 1–15 秒钳制不能表达媒体台绝对售价。详见 [VIDEO_BILLING.md](VIDEO_BILLING.md)。
- 客户售价就是 `lib/video-models.ts`。不要再乘 1.5 或 2。探测标价不是已核实的扣费。
- 已完成的上游记录只有 `muse-video` 10 秒和 `minimax-h3-base-fast` 10 秒。768p 必须发送 `1344x768`。`video-ray` 没有完成过，不能因为价表里有它就放行。
- 已找回成功请求体。`POST /v1/videos` 的 JSON 是 `model`、`prompt`、`seconds`（数字）、`size`，没有 `duration`。muse 10 秒是 `1280x720`，并返回 202 后完成。minimax-h3-base-fast 10 秒是 `1344x768`。标价仍然不是已核实的扣费。
- 生产前端没有卷、没有数据库。任务文件必须挂到持久目录。Caddy 已经把 `/image*` 转到 `127.0.0.1:43123`，读超时 10 分钟，这次不改 Caddy。
- 侧栏目前只有充值入口。恢复菜单是运维的事：旧的「快速生图」标签应写成「媒体台」，并保留「充值中心」。本仓库不恢复菜单。

## 请求体

成功探针里的 muse 请求是 `{"model":"muse-video","prompt":"...","seconds":10,"size":"1280x720"}`。程序按这个形状发送用户自己的提示词。其他未完成档位仍然拒绝。

2k 的 `2560x1440` 仍只是配置值，对应档位不会提交。

## 应用行为

`/api/videos` 在扣费适配器关闭时返回 503，不调用上游。模拟路由返回 410，生成错误不会改播样片。

同一幂等键不重复扣费、不重复 POST。扣的是 `users.balance`，不写 `frozen_balance`；可用金额仍要扣掉其他产品已经冻住的部分。明确失败按账本原金额退回一次。超时和重定向保持已扣状态，不自动退款，也不自动重试。别人不能读任务或内容。上游响应里的 URL 不会被跟随。
