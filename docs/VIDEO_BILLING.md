# 视频账本：冻结、结算、解除冻结

这篇给运维审查。云端不会执行生产 SQL，也不会用管理员账号连接数据库。

## 为什么不用现成的扣费入口

生图是 Sub2API 在 `/v1/images/*` 里自己扣 `users.balance`。视频不能走 `/v1/videos`，也不能走分组里的美元/秒价。0.2.24 的 `DeductBalance` 先按 `balance >= amount` 扣，失败后再无条件把余额减成负数，而且不看 `frozen_balance`。所以视频不调用它，也不写 `usage_logs`：那张表要求 `account_id`，视频分辨率注释只覆盖 480p/720p/1080p，写入还会触发分组用量汇总。`billing_usage_entries` 和 `idempotency_records` 也不是钱包流水。`batch_image_jobs` 的冻结字段没有用户外键，幂等键也不唯一，不能拿来用。

## 本应用的三步

可用金额是 `balance - frozen_balance`。同一事务里 `SELECT ... FOR UPDATE` 锁住用户行，再按条件更新，避免和 Sub2API 的余额更新互相覆盖。只改 `balance`、`frozen_balance`、`updated_at`。0.2.24 的 `enqueue_user_auth_cache_invalidation()` 会在每次用户更新时执行，但 status、role、deleted_at 都没变时直接返回，不会写 outbox。

1. 冻结。`frozen_balance` 增加售价，条件是可用金额足够，并且账户有分组 11「媒体台」的有效密钥。`balance` 不变。
2. 结算。上游确认完成后，`balance` 和 `frozen_balance` 同时减少同一金额。余额不会增加。
3. 解除冻结。上游明确失败、且这笔还没结算时，只减少 `frozen_balance`。这不是余额退款，也没有 `balance = balance + 金额`。

结果不明的提交保持冻结，不结算，不解除，也不再 POST。账本行还在，所以这不是一笔被藏起来的余额扣费，但可用金额会一直少着，直到另一次明确许可后再处理。程序里没有把余额加回去的语句。`VIDEO_BILLING_ADAPTER` 默认 `off`。

## 部署

库在现有网络 `sub2api-local_sub2api-network` 里，别名 `postgres` 或 `sub2api-postgres`，端口 5432 不映射到宿主机。前端 compose 只加入这个外部网络，不重建 Sub2API。运行时使用 `media_video_billing`，密码不要写进仓库。语句在 [deploy/sql/001_media_video_holds.sql](../deploy/sql/001_media_video_holds.sql)。回滚说明在 `001_rollback.sql`：关掉适配器，不要对 `users.balance` 做手工退款。

任务文件仍要挂到 `/data`。没有卷、没有审查过的角色之前，不要把适配器改成 `postgres`。

## 现有账户扣费

生图已经能扣 jaxapi 余额：浏览器持有登录令牌，服务端用该用户的媒体台 API 密钥调用 `POST /v1/images/generations` 或 `/v1/images/edits`。Sub2API 在自己的请求路径里扣余额。这里没有另一套生图扣费 SQL。

登录是同源的 `/api/v1/auth/*`。令牌在 `auth_token`、`refresh_token`、`auth_user`、`token_expires_at`，其次才是 `jax.image.session.v1`。地址栏里的 `token` 和 `user_id` 继续忽略。

## 为什么不能走现成的视频计费

分组 11 的 `video_model_prices` 是美元/秒，而且只覆盖 480p、720p、1080p。运行中的 0.2.24 会把时长夹到 1–15 秒。因此：

- muse 20/30/60 秒、seedance 30 秒、JL 的 10 秒和 15 秒同价 6 美元、768p 和 2k，都不能交给这条路径。
- `POST /v1/videos` 在 openai 平台上是 404，不能当成入口。
- 管理接口改余额是盲改，本应用不调用。
- 不允许为了视频去重建或升级 Sub2API。线上二进制是 0.2.24，compose 标签仍是 0.2.18。

探测里看到的 muse 10 秒 0.60、minimax-base-fast 10 秒 0.30、ray 10 秒 0.30 是标价记录，`cost_verified` 为假。不能据此再乘 1.5 或再乘 2，也不能说毛利已经核实。客户售价只用 `lib/video-models.ts` 里的绝对价。

## 本应用实际怎么做

1. 用登录令牌向 jaxapi 读 `/api/v1/auth/me` 和密钥，确认是分组 **11**、名称「媒体台」的有效密钥。分组 7 直接拒绝，也不会把新密钥建到分组 7。
2. 售价只查价表。客户端传来的价格被忽略。
3. 只有两条已完成的上游记录可以提交：`muse-video` 10 秒，`minimax-h3-base-fast` 10 秒。后者尺寸必须是 `1344x768`。`video-ray` 没有完成过，其他已标价档位也先不提交。
4. 上游是 `https://api.supergpt.dev/v1` 的 `POST /videos`、`GET /videos/{id}`、`GET /videos/{id}/content`。User-Agent 固定 `curl/8.5.0`。POST 不跟随重定向，失败不自动再 POST。响应里的 URL 不会被拿去再请求。
5. 任务写在 `VIDEO_JOB_STORE` 指向的文件里。生产前端目前没有卷，部署时必须把宿主机目录挂到 `/data`，否则重启后任务和扣费状态一起丢。
6. `VIDEO_BILLING_ADAPTER` 默认 `off`。`sql`、`database`、`sub2api`、`admin` 一律拒绝。未接上扣费时，接口返回 503，不会调用 SuperGPT。

扣费端口的应用规则（测试用内存账本覆盖，生产尚未接上）：

- 同一用户、同一幂等键只对应一个任务。
- 扣费键是任务 id。重复扣费返回原结果，不减第二次。
- 余额不足不建上游任务。
- 上游明确拒绝时，按原金额退回一次；再查询不再退。
- POST 超时、5xx 或重定向：钱保持扣住，状态留在可对账，不退、不重试。
- 轮询超时或仍在生成：不退款。慢不等于失败。
- 退款结果如果也不明，标记后停止，不自动再退。

## 尚未接上的余额写入

当前没有一个已核实的接口可以「若余额足够则按绝对售价原子扣减，并以幂等键只扣一次」。所以不能宣称视频已经在扣真实账户余额。

如果以后要做数据库扣费，必须先单独确认表结构，再用只含该语句权限的账号，而不是管理员账号：

- 只允许对指定用户做带条件的余额减少和等额增加。
- 扣费：`余额 >= 售价` 时才更新，并写入只属于本应用的幂等键。
- 退款：同一幂等键只增加一次，金额必须等于原扣费。
- 不开放任意 `SET balance`。
- 本仓库现在不包含这条 SQL，也不读取生产连接串。在结构被核对并得到另一次明确许可之前，不要执行。

`http` 适配器留给运维自己的扣费服务。它必须实现上面的原子性和幂等，并且返回 200 或 402，不能 30x。本应用不会跟随 POST 重定向。在那个服务存在之前，保持 `VIDEO_BILLING_ADAPTER=off`。

## 回滚

1. 把 `VIDEO_BILLING_ADAPTER` 设回 `off` 并重启前端。新的提交会在调用上游之前拒绝。
2. 不要删除 `/opt/jaxapi-quick-image/data/video-jobs.json`，里面有未完成和结果不明的任务。
3. 不要对 jaxapi 用户表执行退款 SQL。结果不明的单留在文件里对账。
4. 回滚前端镜像不会退回已经通过外部扣费服务扣掉的钱；那要由该服务自己的幂等退款处理。
5. 不要为了回滚去重建 Sub2API。
