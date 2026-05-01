# RosettaX-Property

RosettaX-Property 是独立账号处理服务, 专门消费 RosettaX 主服务投递到 Redis Stream 的账号登录、2FA、relogin 与查询上下文初始化任务。

主服务 RosettaX 只负责业务查询和任务投递; 本服务负责慢链路账号处理, 并把账号池与已初始化 session 写回同一份 Redis/MySQL 状态。

## 启动

```bash
npm install
npm run start:prod
```

服务启动后不会监听 HTTP 端口, 只会创建 Nest application context 并加入 Redis Stream consumer group `rosettax-property`。

## 关键环境变量

- `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_DB`, `REDIS_PASSWORD`
- `PROXY_PROVIDER`
- `ACCOUNT_SESSION_WARMUP_TARGETS`
