# FriendsShip Node

基于原 `friends-ship` Windows 服务业务逻辑重新实现的中文考勤管理控制台，可以在 Linux Docker 中运行。使用 Node.js 24+ 内置 HTTP、SQLite、加密与测试模块，无第三方运行时依赖。

## 功能

- 首次创建管理员、登录和退出、修改密码、会话撤销。
- 管理员创建管理员或普通成员，启用或停用成员；每个用户的考勤配置、计划、日志和执行记录独立。
- 配置公司标识、考勤账号密码、OpenID、source、接口地址、打卡位置。
- 每天在上午和下午的时间范围内分别随机选择一分钟，按配置时区执行。
- 支持周一至周五、中国节假日接口识别调休、指定日期覆盖、节假日接口故障回退。
- 默认任务关闭、模拟模式开启；提供模拟打卡、考勤登录测试和确认后手动真实打卡。
- SQLite 持久化每日计划与执行状态；同一天同一时段的定时任务只提交一次。
- 执行记录分页和运行日志，保留最近 90 天。
- 导入旧项目 `datas.json`。密码进入加密存储，不会回显或输出到日志。

## Docker 启动

安装并启动 Docker Desktop 或 Docker Engine，确保 `docker info` 能正常连接。

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
docker compose logs -f --tail=100
```

浏览器打开 **http://localhost:3000**，首次访问创建管理员。默认只监听主机 `127.0.0.1`，无需预设密码。

需要局域网访问时，在 `.env` 增加 `BIND_ADDRESS=0.0.0.0`，并将 `APP_ORIGIN` 设置为浏览器实际访问的地址，例如 `http://192.168.1.10:3000`。先在本机完成管理员初始化再开放访问。

数据保存在命名卷 `friends-ship-data`，包括数据库、WAL 文件及 `secrets.key`。普通重启、容器重建和 `docker compose down` 会保留数据。`docker compose down -v` 会删除数据卷。

如果本机 Docker 镜像源不可用导致基础镜像拉取失败，可先从官方仓库拉取并标记，再重新构建：

```bash
docker pull registry-1.docker.io/library/node:24-bookworm-slim
docker tag registry-1.docker.io/library/node:24-bookworm-slim node:24-bookworm-slim
docker compose up -d --build
```

```bash
# 重建并更新
docker compose up -d --build

# 停止，保留数据
docker compose down
```

部署只运行 **一个应用实例**。不要对共享数据库配置多个副本。

## 首次使用

1. 创建控制台管理员，登录密码至少 10 位。控制台账号与考勤账号分别管理。
2. 在「个人配置」中填写考勤公司、账号、密码、OpenID 等信息；或导入原项目的 `datas.json`。
3. 设置时间、坐标和地点，保存后点击「测试考勤登录」。此操作会登录考勤系统，但不提交打卡。
4. 点击「模拟打卡」，确认执行记录和计划符合预期。
5. 开启定时任务。可先保持模拟模式运行，确认后关闭模拟模式并保存。
6. 管理员可在「用户管理」创建成员。成员登录后自行填写个人考勤配置。

修改配置会重新生成当日计划，但已执行、失败、待核对或跳过的定时任务不会重复提交。手动打卡独立于定时任务，不会取消当天的定时任务。

### 时间和工作日

- 默认时区 `Asia/Shanghai`，上午 `08:00–08:20`，下午 `18:30–19:00`，每日刷新 `00:05`。
- 刷新时间必须不晚于上午时间段开始。首次启动会在刷新时间之后补建当日计划。
- 原项目 `16:00` 刷新当天计划可能错过上午打卡；导入时自动修正为 `00:05`。
- 每 15 秒检查一次，在计划分钟及下一分钟内可以执行。错过这个窗口会记录为「已跳过」，不会重启后补交。
- 默认按周一至周五判断。使用中国调休规则时，在配置中选择「中国节假日接口」。
- 日期覆盖优先级最高，例如 `{"2026-10-01":0,"2026-10-10":1}`，`0` 表示休息，`1` 表示工作。
- 节假日接口失败默认跳过当天任务；可显式选择回退为周一至周五。当天判断会随计划缓存，修改配置后重新计算。

### 接口兼容

考勤接口使用原项目协议：

```text
POST {apiBaseUrl}/api/system/login
body: {"data":{"company":"...","username":"...","password":"...","source":5,"openId":"..."}}

POST {apiBaseUrl}/api/workforce/mobileAttendance
header: X-Token: <登录取得的 token>
body: {"data":{"longitude":"...","latitude":"...","punchSite":"...","punchWay":2,"employeeId":"...","extUserDevice":"..."}}
```

登录响应要求 `content.body` 中包含 `token`、`employeeId.valueId`、`openId`，可选 `employeeName`。打卡响应在顶层、`content` 或 `content.body` 中出现 `success: true`，或 `code/statusCode` 为 `0`、`200`、`"0"`、`"200"`、`"0000"`，且没有明确失败标记时，才确认为成功。

HTTP 成功但响应不明、提交后超时或网络中断会记为「结果待核对」，不会自动重试。请在考勤系统核对；如果实际接口的成功协议不同，需要调整 `src/attendance.js` 中的 `responseVerdict`。

节假日接口兼容 `GET {holidayUrl}?date=yyyyMMdd`，读取 `data.list[0].workday` 的 `0/1` 值。上游请求超时 12 秒，拒绝自动跳转，响应限制 1MB。

坐标保留原项目的正向随机偏移规则，默认最大 `0.0001` 度；设为 `0` 可关闭。地点在列表中均匀随机选择，全部地点均可被选择。

## 本地开发

Node.js **24 或更高版本**，直接运行，无需安装运行时依赖：

```bash
npm start
# 修改源文件后自动重启
npm run dev
# 语法与业务检查
npm run check
npm test
```

本地启动默认使用当前目录 `data/`。设置环境变量可修改路径、监听端口或绑定地址：

```bash
PORT=3001 HOST=127.0.0.1 DATA_DIR=./data npm start
```

应用不会自动读取 `.env`，Docker Compose 会读取；本地如需使用 `.env`：

```bash
node --env-file=.env src/index.js
```

测试使用临时 SQLite 和进程内 HTTP 请求处理器，模拟上游响应，不监听网络端口，不连接真实考勤服务。覆盖账号权限、CSRF、多用户隔离、密码加密、接口报文、响应判定、调休、计划去重、错过任务、重启恢复和异常处理。

2026-10-14 验证结果：23 项测试在本机 Node.js 26 和 Docker Node.js 24.21.0 中均通过；容器成功构建、启动并通过健康检查，以非 root 用户运行。浏览器验证了管理员初始化、配置保存、模拟执行、创建成员、成员登录、数据隔离和桌面/手机布局。真实考勤接口尚需使用自己的账号验证。

## 环境配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `3000` | 本地端口；Compose 中为主机映射端口，容器固定 3000 |
| `HOST` | `0.0.0.0` | 本地应用监听地址 |
| `BIND_ADDRESS` | `127.0.0.1` | Compose 主机监听地址 |
| `DATA_DIR` | `./data` | 数据目录；容器固定 `/app/data` |
| `TZ` | `Asia/Shanghai` | 容器时区；任务按用户配置的时区计算 |
| `APP_ORIGIN` | 空 | 浏览器访问的准确地址，不含末尾 `/` |
| `COOKIE_SECURE` | `false` | HTTPS 访问设为 `true` |
| `ENCRYPTION_KEY` | 自动生成 | 可选的 64 位十六进制密钥 |
| `ADMIN_USERNAME` | 空 | 仅在首次初始化时创建管理员 |
| `ADMIN_PASSWORD` | 空 | 与 `ADMIN_USERNAME` 同时提供，至少 10 位 |

HTTPS 反向代理部署：配置 `APP_ORIGIN=https://attendance.example.com` 和 `COOKIE_SECURE=true`，代理到主机 `127.0.0.1:3000`。应用不信任客户端转发的 IP；登录限流按直接连接地址计算。

登录密码使用 scrypt 加盐哈希。会话 Cookie 使用 HttpOnly、SameSite=Strict，服务端仅保存会话 token 哈希。登录会话 7 天过期，修改密码或停用用户立即撤销旧会话。写接口校验 CSRF token 与浏览器 Origin。网页使用严格 CSP，无外部字体和脚本。

考勤密码使用 AES-256-GCM 加密。默认密钥自动生成在数据卷 `secrets.key`；数据库与密钥需要一起备份。设置 `ENCRYPTION_KEY` 后必须保持不变，替换密钥会使原密码无法解密。备份前停止服务并复制整个数据卷，恢复时完整还原。`.env` 和 `data/` 均已加入 Git 忽略。

## API

公开接口：`GET /api/health`、`GET /api/auth/status`、`POST /api/auth/setup`、`POST /api/auth/login`。

登录后可用：

| 路径 | 方法 | 功能 |
| --- | --- | --- |
| `/api/auth/logout` | POST | 退出 |
| `/api/auth/password` | POST | 更新控制台密码 |
| `/api/dashboard` | GET | 今日计划、状态与统计 |
| `/api/settings` | GET / PUT | 读取、保存个人配置 |
| `/api/settings/import` | POST | 导入旧 `datas.json` |
| `/api/attendance/test-login` | POST | 测试考勤登录 |
| `/api/attendance/run` | POST | 手动执行，`{"dryRun":true}` 为模拟 |
| `/api/runs?page=1` | GET | 分页记录 |
| `/api/logs` | GET | 最近 100 条日志 |
| `/api/users` | GET / POST | 管理员查看、创建成员 |
| `/api/users/:id` | PATCH | 管理员启用、停用成员 |

写接口需携带登录返回的 `X-CSRF-Token` 和会话 Cookie，请求使用 JSON。`PUT /api/settings` 的空密码保持已保存密码；`clearPassword:true` 删除密码。

## 目录

```text
src/
  index.js       启动与优雅停止
  server.js      HTTP 接口、登录、权限校验
  store.js       SQLite 持久化
  security.js    密码哈希与凭据加密
  config.js      配置校验与时间处理
  attendance.js  考勤、节假日接口适配
  scheduler.js   每日计划、去重与执行
public/          中文网页控制台
test/            自动化测试
Dockerfile       非 root 容器与健康检查
compose.yaml     数据卷、端口和容器配置
```

保留原项目的 Mulan PSL v2 许可证，见 `LICENSE`。新项目不包含原项目中的真实账号密码。
