# 部署

这次提交只准备源码。不要部署，不要改 Caddy，不要恢复菜单，不要重建或升级 Sub2API。线上 Sub2API 二进制是 0.2.24，compose 标签仍写着 0.2.18，重建会把进程换掉。

Caddy 已经把 `/image*` 转到 `127.0.0.1:43123`，读超时 10 分钟。侧栏目前只有充值入口。以后若恢复菜单，旧标签「快速生图」写成「媒体台」，并保留「充值中心」。那一步由运维做，不在这次应用变更里。

视频任务必须有持久目录。生产前端现在没有卷。把宿主机目录挂到容器 `/data`，并设置 `VIDEO_JOB_STORE=/data/video-jobs.json`。没有这块盘之前，不要打开扣费开关。

`VIDEO_BILLING_ADAPTER` 保持 `off`。不要把它指到 Sub2API 的按秒视频价，也不要填生产数据库连接串。扣费缺口见 [docs/VIDEO_BILLING.md](docs/VIDEO_BILLING.md)。

这个仓库不改 jaxapi.top 的支付、邮件或 CDK。分组 7 不会被这个应用挂上新密钥。

## DNS

把 `image.jaxapi.top` 指到托管这套前端的机器或静态站点。证书用现有的通配符或单独签一张。应用本身不签发证书。

## 运行方式

生产 API 默认是 `https://jaxapi.top`，用环境变量 `JAXAPI_BASE_URL` 覆盖。浏览器只请求本站的 `/api/jax/...`，由 Node 转发到上游。这样在 CORS 放行之前也能用。

```bash
npm ci
npm run build
JAXAPI_BASE_URL=https://jaxapi.top npm run start
```

进程监听 `0.0.0.0:43123`。前面用 Caddy 或 Nginx 终结 TLS，并把 `image.jaxapi.top` 反代到该端口。生图可能接近三分钟，反代的读超时不要短于 180 秒，请求体至少 20MB：

```nginx
client_max_body_size 20m;
proxy_read_timeout 180s;
proxy_send_timeout 180s;
```

不要在访问日志里记录 `Authorization` 或请求体。

## 纯静态站点

`next build` 的默认产物依赖 Node 上的 `/api/jax` 转发。如果改成纯静态托管，需要在同一域名上用反代代替这个转发，例如：

```nginx
location /api/jax/ {
  proxy_pass https://jaxapi.top/;
  proxy_ssl_server_name on;
  proxy_set_header Host jaxapi.top;
  proxy_read_timeout 180s;
  proxy_send_timeout 180s;
  client_max_body_size 20m;
  proxy_set_header Authorization $http_authorization;
  proxy_pass_request_body on;
}
```

`/api/jax/v1/images/generations` 会落到 `https://jaxapi.top/v1/images/generations`，`/api/jax/api/v1/auth/login` 会落到登录接口。静态资源仍由站点自己提供。同样不要记录授权头和正文。

## CORS

2026-11-21 实测：从 `Origin: https://image.jaxapi.top` 发起到 `https://jaxapi.top/api/v1/auth/login` 和 `/v1/images/generations` 的预检 `OPTIONS` 返回 **403**，响应里没有 `Access-Control-Allow-Origin`。这和 Sub2API 0.2.24 的行为一致：`cors.allowed_origins` 为空或未包含该来源时，跨域预检直接拒绝。带 `Origin` 的登录响应同样没有放行头。

因此浏览器不能直接调用 `jaxapi.top`。当前页面通过同源 `/api/jax` 避开这个问题。

如果以后要让浏览器直连中转站，在 **jaxapi.top 的 Sub2API 配置**里把来源加进允许列表，然后重载服务。示例（`deploy/config.example.yaml` 的字段）：

```yaml
cors:
  allowed_origins:
    - https://jaxapi.top
    - https://image.jaxapi.top
  allow_credentials: true
```

不要把 `allowed_origins` 设成 `*`，那会和 `allow_credentials: true` 冲突。本地调试若也要直连，再临时加入 `http://127.0.0.1:43123`。这一步要在生产服务器上改，不要从这个前端仓库操作。

改完后可以用预检确认，期望状态是 `204`，并且 `Access-Control-Allow-Origin` 等于 `https://image.jaxapi.top`：

```bash
curl -D - -o /dev/null -X OPTIONS https://jaxapi.top/v1/images/generations \
  -H "Origin: https://image.jaxapi.top" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type"
```

## 还需要上游配合的情况

- 登录验证码一旦打开，本页不能代用户完成，只能回主站登录。
- 同步生图若持续在约 120 秒被 jaxapi.top 前面的代理切断，需要把该代理的 `proxy_read_timeout` 提到 180 秒以上，或改用 Sub2API 已有的异步生图任务，并把成图放到对象存储。前端这一期只做同步和明确的超时提示。
