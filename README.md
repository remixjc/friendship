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
- 查询真实考勤记录：按月份查看考勤明细、班次、打卡/休假等项目及月度汇总，支持明细和汇总各自分页。
- 年假配额：当前年度额度、已释放、已使用、未使用及失效日期，展示前两年的结余。
- 考勤登录状态按用户加密保存，查询与打卡复用 token，容器重建后继续有效；到期或上游明确拒绝登录状态时自动重新登录。
- 导入旧项目 `datas.json`。密码进入加密存储，不会回显或输出到日志。

## Docker 启动

安装并启动 Docker Desktop 或 Docker Engine，确保 `docker info` 能正常连接。

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
docker compose logs -f --tail=100
```

浏览器打开 **http://localhost:3000**；部署在飞牛或其他服务器时，打开 **http://服务器局域网IP:3000**。首次访问创建管理员，无需预设密码。默认绑定 `0.0.0.0`，允许通过主机各 IPv4 网络接口访问。

已有 `.env` 如果设置了 `BIND_ADDRESS=127.0.0.1`，需改为 `BIND_ADDRESS=0.0.0.0`，再执行 `docker compose up -d` 应用端口变更。浏览器使用服务器实际 IP，不使用 `0.0.0.0`。`APP_ORIGIN` 可留空以校验当前 Host；如需固定访问地址，可设置为例如 `http://192.168.1.10:3000`。仅供本机访问时，将 `BIND_ADDRESS` 设置为 `127.0.0.1`。

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
3. 设置时间、坐标和地点，保存后点击「测试考勤登录」。此操作复用或获取考勤登录状态，并调用只读接口验证，不提交打卡。
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
- 节假日接口失败默认跳过当天任务，页面显示「判断失败，已跳过」，不误报为休息日；可显式选择回退为周一至周五。指定日期覆盖始终优先。

### 接口兼容

考勤接口使用原项目协议：

```text
POST {apiBaseUrl}/api/system/login
body: {"data":{"company":"...","username":"...","password":"...","source":5,"openId":"..."}}

POST {apiBaseUrl}/api/workforce/mobileAttendance
header: X-Token: <登录取得的 token>
body: {"data":{"longitude":"...","latitude":"...","punchSite":"...","punchWay":2,"employeeId":"...","extUserDevice":"..."}}
```

登录响应要求 `content.body` 中包含 `token`、`employeeId.valueId`、`openId`，可选 `employeeName`。打卡响应在顶层、`content` 或 `content.body` 中出现 `success: true`，或 `code/statusCode/msgCode` 为 `0`、`200`、`"0"`、`"200"`、`"0000"`，且没有明确失败标记时，才确认为成功。

token、员工 ID 和服务端 OpenID 使用 AES-256-GCM 加密保存到 SQLite，按控制台用户隔离。首次使用时登录，随后考勤记录、年假查询、登录验证和真实打卡共用该状态。JWT 含 `exp` 时按到期时间更新；其他 token 不猜测有效期，在接口明确返回 HTTP/业务 401 或失败响应明确表示 token/登录过期时重新登录，并最多重试原请求一次。并发调用共享一次登录或刷新。普通 HTTP/业务 403 权限拒绝不会触发刷新。

修改接口地址、公司、账号、密码、source 或 OpenID 时清除旧状态；只改时间或位置等配置保留状态。删除密码或停用用户也撤销上游缓存。容器重启或重建保留数据卷和密钥即可继续复用。「测试考勤登录」通过 `GET /api/system/employee/info` 验证缓存 token，正常时不会强制重新登录。

HTTP 成功但响应不明、提交后超时或网络中断会记为「结果待核对」，不会自动重试。只有明确登录失效的打卡请求会在重新登录后重试一次，沿用同一坐标和地点。请在考勤系统核对未知结果；如果实际接口的成功协议不同，需要调整 `src/attendance.js` 中的 `responseVerdict`。

节假日接口默认使用提莫：

```text
https://timor.tech/api/holiday/info/{date}
```

`{date}` 自动替换为 `YYYY-MM-DD`。要求业务 `code=0`，读取 `type.type`：`0` 普通工作日、`1` 周末、`2` 法定假期、`3` 调休补班；只有 `0/3` 安排自动任务。校验上游返回的星期及明确日期，避免展示错误日期结果。保留对旧 `GET {holidayUrl}?date=yyyyMMdd` 协议的兼容，读取 `data.list[0].workday` 的 `0/1` 值；业务错误不能被当成正常工作日结果。

成功结果（包含工作与休息）按请求地址和日期持久化缓存 24 小时，各用户共享，重启后复用；同时合并并发请求。失败不写成休息日缓存，同一地址和日期在一分钟内不重复请求，仍按各用户的失败策略处理。自动任务沿用当日计划，失败后如需重新判断可以重新保存配置，或使用指定日期覆盖。上游请求超时 12 秒，拒绝自动跳转，响应限制 1MB。

升级时，已保存的旧默认地址 `https://api.apihubs.cn/holiday/get` 自动迁移到提莫，其他自定义地址保留。当天已有计划只重新判断工作日，不重新随机选择时间，不重复已有执行记录。公共接口的可用性仍会受网络或服务维护影响，缓存和日期覆盖可以降低影响。

坐标保留原项目的正向随机偏移规则，默认最大 `0.0001` 度；设为 `0` 可关闭。地点在列表中均匀随机选择，全部地点均可被选择。

### 考勤记录查询

在「考勤记录」选择月份查询，使用当前用户个人配置中的考勤账号登录，并从登录响应取得 `employeeId` 和 token。查询使用 `X-Token`，请求原系统的两个接口：

```text
GET {apiBaseUrl}/api/workforce/timeCardInfo
GET {apiBaseUrl}/api/workforce/timeCardAttendanceSummary

参数：pageNum、pageSize、employeeId、dateRange
dateRange：{"beginDate":"2026-10-01","endDate":"2026-10-31"}
```

查询复用已保存的登录状态，首次或失效时登录，随后并行获取明细和汇总。月份会自动计算月末，包括闰年。明细按日期分页，默认每页 20 个日期，展开每天全部 `timeAttendance` 项目；汇总每页 50 项，独立分页。接口需要成功状态和 `content.body` 列表、`content.totalCount` 总数；业务鉴权失败不会被当成空结果。

实际开始/结束时间使用 `beginDateTime/endDateTime`；为空时展示「—」。`inTimeCardExtraAttendance/outTimeCardExtraAttendance.shouldPunchDateTime` 单独以灰色「计划」展示，不表示实际已打卡。年假等项目保留上游起止时间。时长和汇总直接展示上游值，例如 `43:01` 不会被转换为一天中的时刻或在本地重新计算。

异常、加班、出差仅展示上游存在标记，当前未接入这些详情接口。未推测 `flag/dateType/status` 等未说明枚举的含义。

明细或汇总单独失败时，保留另一部分结果并提示错误。查询独立于定时任务，模拟模式也可以查询真实考勤记录；查询仅执行登录与 GET，不提交打卡。没有本地考勤数据缓存，每次进入、刷新或翻页都会重新请求。token 和密码保留在后端，页面只接收展示所需字段；客户端无法指定其他员工 ID。

移动端登录 token 是否拥有这两个查询接口的权限，需要在个人配置中填写自己的考勤账号后实测；若上游权限不足，页面明确提示查询被拒绝。

### 年假配额查询

「年假配额」调用 `GET {apiBaseUrl}/api/workforce/attendanceSummary`，携带 `X-Token`、`pageNum=1`、`pageSize=10`、个人员工 ID、员工过滤条件和当前月日期范围；沿用原个人页面的 `skipAuth=true` 参数。月份和年度按个人配置时区计算，员工 ID 来自上游登录，客户端不能指定其他员工，返回其他员工数据时拒绝展示。

读取 `content.body[0].annualLeave` 中的 `baseNum/initNum/usedNum/availableNum/expirationDate`，对应年度额度、已释放、已使用、未使用和失效日期。`lastYearLeave` 与 `beforeLastYearLeave` 的 `extendedUsedNum/extendedRemainNum/extendedExpiryDate` 展示前两年的使用、结余和失效日期。小时数保留小数和零，缺失字段显示「—」，未使用时长直接采用上游数据，不以年度额度减已用推算。查询失败显示错误，无数据明确显示空状态。

接口和字段已对照原系统个人页面及其前端代码确认。项目自身登录取得的移动端 token 是否拥有年假接口权限仍需使用个人账号实测；权限不足会显示查询拒绝，不使用浏览器里的 token。

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

2026-10-14 验证结果：56 项测试在本机 Node.js 和 Docker Node.js 24 中均通过，覆盖年假字段、时区、多用户隔离、加密持久化、重启复用、凭据变更、并发刷新、明确过期重试，以及网络故障不重放打卡；新增节假日类型转换、缓存到期/重启/并发、失败冷却和旧配置迁移验证。测试使用临时数据与模拟上游，不连接真实考勤服务或提交真实打卡。

## 环境配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `3000` | 本地端口；Compose 中为主机映射端口，容器固定 3000 |
| `HOST` | `0.0.0.0` | 本地应用监听地址 |
| `BIND_ADDRESS` | `0.0.0.0` | Compose 主机监听地址；默认允许局域网访问 |
| `DATA_DIR` | `./data` | 数据目录；容器固定 `/app/data` |
| `TZ` | `Asia/Shanghai` | 容器时区；任务按用户配置的时区计算 |
| `APP_ORIGIN` | 空 | 浏览器访问的准确地址，不含末尾 `/` |
| `COOKIE_SECURE` | `false` | HTTPS 访问设为 `true` |
| `ENCRYPTION_KEY` | 自动生成 | 可选的 64 位十六进制密钥 |
| `ADMIN_USERNAME` | 空 | 仅在首次初始化时创建管理员 |
| `ADMIN_PASSWORD` | 空 | 与 `ADMIN_USERNAME` 同时提供，至少 10 位 |

HTTPS 本机反向代理部署：配置 `BIND_ADDRESS=127.0.0.1`、`APP_ORIGIN=https://attendance.example.com` 和 `COOKIE_SECURE=true`，代理到主机 `127.0.0.1:3000`。应用不信任客户端转发的 IP；登录限流按直接连接地址计算。

登录密码使用 scrypt 加盐哈希。会话 Cookie 使用 HttpOnly、SameSite=Strict，服务端仅保存会话 token 哈希。登录会话 7 天过期，修改密码或停用用户立即撤销旧会话。写接口校验 CSRF token 与浏览器 Origin。网页使用严格 CSP，无外部字体和脚本。

考勤密码和上游登录状态使用 AES-256-GCM 加密。默认密钥自动生成在数据卷 `secrets.key`；数据库与密钥需要一起备份。设置 `ENCRYPTION_KEY` 后必须保持不变，替换密钥会使原密码和登录状态无法解密。备份前停止服务并复制整个数据卷，恢复时完整还原。`.env` 和 `data/` 均已加入 Git 忽略。

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
| `/api/attendance/records?month=2026-10&page=1&pageSize=20&summaryPage=1` | GET | 当前账号的考勤明细及月度汇总 |
| `/api/attendance/quota` | GET | 当前账号年假配额及前两年结余 |
| `/api/runs?page=1` | GET | 分页记录 |
| `/api/logs` | GET | 最近 100 条日志 |
| `/api/users` | GET / POST | 管理员查看、创建成员 |
| `/api/users/:id` | PATCH | 管理员启用、停用成员 |

写接口需携带登录返回的 `X-CSRF-Token` 和会话 Cookie，请求使用 JSON。`PUT /api/settings` 的空密码保持已保存密码；`clearPassword:true` 删除密码。

考勤查询接口的 `month` 默认取用户配置时区的当前月份，`pageSize` 允许 1～50。返回 `records`、`summary` 两个分页对象（`items/total/page/pageSize`），以及 `recordsError/summaryError`；部分失败的对象为 `null`。员工 ID 由后端登录获取，忽略客户端传入的员工或用户 ID。每用户最多 12 次查询/分钟，禁止同用户同时发起多个查询。

## 目录

```text
src/
  index.js       启动与优雅停止
  server.js      HTTP 接口、登录、权限校验
  store.js       SQLite 持久化
  security.js    密码哈希与凭据加密
  config.js      配置校验与时间处理
  attendance.js  考勤、节假日接口适配
  reports.js     月份查询校验与考勤展示字段转换
  scheduler.js   每日计划、去重与执行
public/          中文网页控制台
test/            自动化测试
Dockerfile       非 root 容器与健康检查
compose.yaml     数据卷、端口和容器配置
```

保留原项目的 Mulan PSL v2 许可证，见 `LICENSE`。新项目不包含原项目中的真实账号密码。
