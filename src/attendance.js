import { randomInt } from 'node:crypto';
import { AppError, isWeekday, localClock } from './config.js';
import { normalizeDays, normalizeSummary, normalizeQuota, reportQuery } from './reports.js';
import { createUpstreamSessions, UpstreamAuthError } from './upstream-session.js';

export class AttendanceError extends AppError {
  constructor(message, outcome = 'failed') {
    super(message, 502);
    this.outcome = outcome;
  }
}

export function createAttendance(fetchImpl = fetch, timeout = 12000, { store, clock = Date.now } = {}) {
  const memory = new Map();
  const sessions = createUpstreamSessions(store || {
    loadUpstreamSession: id => memory.get(id),
    saveUpstreamSession: (id, value) => memory.set(id, value),
  }, clock);
  async function request(url, options = {}, submitted = false) {
    const uncertain = submitted ? 'unknown' : 'failed';
    try {
      const response = await fetchImpl(url, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(timeout),
        headers: { Accept: 'application/json', ...options.headers },
      });
      if (response.status === 401) throw new UpstreamAuthError();
      if (!response.ok) throw new AttendanceError(`上游接口返回 HTTP ${response.status}`, response.status >= 500 ? uncertain : 'failed');
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 1024 * 1024) {
          await reader.cancel();
          throw new AttendanceError('上游响应超过大小限制', uncertain);
        }
        chunks.push(Buffer.from(value));
      }
      let json;
      try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new AttendanceError('上游返回了非 JSON 响应', uncertain); }
      const expired = [json, json?.content].some(value => {
        if (!value || typeof value !== 'object') return false;
        if (['code', 'statusCode', 'msgCode'].some(key => String(value[key]) === '401')) return true;
        const message = value.msgText ?? value.message;
        return responseVerdict(json) === false && typeof message === 'string'
          && /(?:token|令牌|登录).{0,20}(?:过期|失效|expired|invalid)|(?:expired|invalid).{0,10}token/i.test(message);
      });
      if (expired) throw new UpstreamAuthError();
      return json;
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Never copy upstream messages, tokens or credentials into public errors/logs.
      throw new AttendanceError('上游请求失败或超时，请检查网络和接口地址', uncertain);
    }
  }

  function responseVerdict(json) {
    const objects = [json, json?.content, json?.content?.body];
    let success = false;
    for (const object of objects) {
      if (!object || typeof object !== 'object') continue;
      if (object.success === false) return false;
      if (object.success === true) success = true;
      for (const key of ['code', 'statusCode', 'msgCode']) {
        if (Object.hasOwn(object, key)) {
          if (![0, 200, '0', '200', '0000'].includes(object[key])) return false;
          success = true;
        }
      }
    }
    return success ? true : null;
  }

  async function freshLogin(config) {
    if (!config.company || !config.username || !config.password || !config.openId) {
      throw new AppError('请先填写公司、考勤账号、密码和 OpenID');
    }
    const response = await request(`${config.apiBaseUrl}/api/system/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {
        company: config.company, username: config.username, password: config.password,
        source: config.source, openId: config.openId,
      } }),
    });
    const body = response?.content?.body;
    const employeeId = body?.employeeId?.valueId;
    if (responseVerdict(response) === false || typeof body?.token !== 'string' || !body.token
      || !['string', 'number'].includes(typeof employeeId) || String(employeeId) === ''
      || typeof body?.openId !== 'string' || !body.openId) {
      throw new AttendanceError('考勤登录失败，或响应缺少 token、employeeId、openId，请核对账号及接口兼容性');
    }
    return { token: body.token, employeeId: String(employeeId), openId: body.openId,
      employeeName: typeof body.employeeName === 'string' ? body.employeeName.slice(0, 100) : config.username };
  }

  const login = config => sessions.get(config, () => freshLogin(config));
  async function authenticated(config, operation) {
    let account = await login(config);
    try { return { account, result: await operation(account) }; }
    catch (error) {
      if (!(error instanceof UpstreamAuthError)) throw error;
      account = await sessions.get(config, () => freshLogin(config), account.token);
      return { account, result: await operation(account) };
    }
  }

  function location(config) {
    const jitter = () => randomInt(0, 1000001) / 1000000 * config.coordinateJitter;
    return {
      longitude: (config.longitude + jitter()).toFixed(6),
      latitude: (config.latitude + jitter()).toFixed(6),
      punchSite: config.sites[randomInt(0, config.sites.length)],
    };
  }

  return {
    login,
    async testLogin(config) {
      const { account, result } = await authenticated(config, account => request(
        `${config.apiBaseUrl}/api/system/employee/info`, { method: 'GET', headers: { 'X-Token': account.token } },
      ));
      if (responseVerdict(result) !== true) throw new AttendanceError('考勤账号验证失败，请检查查询权限');
      return account;
    },
    async report(config, input) {
      const query = reportQuery(input);
      const account = await login(config);
      async function list(endpoint, page, pageSize, normalize) {
        const { account, result } = await authenticated(config, account => {
          const url = new URL(`/api/workforce/${endpoint}`, config.apiBaseUrl);
          url.searchParams.set('pageNum', String(page));
          url.searchParams.set('pageSize', String(pageSize));
          url.searchParams.set('employeeId', account.employeeId);
          url.searchParams.set('dateRange', JSON.stringify(query.dateRange));
          return request(url, { method: 'GET', headers: { 'X-Token': account.token } });
        });
        if (responseVerdict(result) !== true) {
          throw new AttendanceError('考勤查询被拒绝或响应状态不兼容，请检查账号查询权限');
        }
        const { body, totalCount } = result.content || {};
        const total = typeof totalCount === 'string' && /^\d+$/.test(totalCount) ? Number(totalCount) : totalCount;
        if (!Array.isArray(body) || body.length > pageSize || !Number.isSafeInteger(total) || total < 0 || total < body.length) {
          throw new AttendanceError('考勤查询的列表或分页格式不兼容');
        }
        return { items: normalize(body, account.employeeId), total, page, pageSize };
      }
      const results = await Promise.allSettled([
        list('timeCardInfo', query.page, query.pageSize, (rows, id) => normalizeDays(rows, id, query.month)),
        list('timeCardAttendanceSummary', query.summaryPage, 50, normalizeSummary),
      ]);
      const safeError = error => error instanceof AppError ? error.message : '考勤查询失败，请稍后重试';
      if (results.every(result => result.status === 'rejected')) {
        throw new AttendanceError(safeError(results[0].reason));
      }
      return {
        month: query.month, dateRange: query.dateRange,
        employeeName: account.employeeName,
        records: results[0].status === 'fulfilled' ? results[0].value : null,
        summary: results[1].status === 'fulfilled' ? results[1].value : null,
        recordsError: results[0].status === 'rejected' ? safeError(results[0].reason) : null,
        summaryError: results[1].status === 'rejected' ? safeError(results[1].reason) : null,
        queriedAt: new Date().toISOString(),
      };
    },
    async quota(config) {
      const month = localClock(new Date(clock()), config.timezone).day.slice(0, 7);
      const { dateRange } = reportQuery({ month });
      const { account, result } = await authenticated(config, account => {
        const url = new URL('/api/workforce/attendanceSummary', config.apiBaseUrl);
        url.searchParams.set('pageNum', '1');
        url.searchParams.set('pageSize', '10');
        url.searchParams.set('employeeId', account.employeeId);
        // Match the upstream personal page; employee selection remains bound to the logged-in account.
        url.searchParams.set('skipAuth', 'true');
        url.searchParams.set('filter', JSON.stringify({
          fieldName: 'employeeCode', condition: '=',
          fieldValue: /^\d+$/.test(account.employeeId) && Number.isSafeInteger(Number(account.employeeId))
            ? Number(account.employeeId) : account.employeeId,
          entityName: 'employee',
        }));
        url.searchParams.set('dateRange', JSON.stringify(dateRange));
        return request(url, { method: 'GET', headers: { 'X-Token': account.token } });
      });
      if (responseVerdict(result) !== true) throw new AttendanceError('年假配额查询被拒绝，请检查账号查询权限');
      return { ...normalizeQuota(result.content?.body, account.employeeId, Number(month.slice(0, 4))),
        employeeName: account.employeeName, queriedAt: new Date(clock()).toISOString() };
    },
    async punch(config, dryRun) {
      const point = location(config);
      if (dryRun) return { employeeName: config.username || '模拟账号', message: `模拟完成：${point.punchSite}（${point.longitude}, ${point.latitude}），未调用考勤接口` };
      const { account, result: response } = await authenticated(config, account => request(`${config.apiBaseUrl}/api/workforce/mobileAttendance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Token': account.token },
        body: JSON.stringify({ data: {
          ...point, punchWay: 2, employeeId: account.employeeId, extUserDevice: account.openId,
        } }),
      }, true));
      const verdict = responseVerdict(response);
      if (verdict === false) throw new AttendanceError('考勤接口明确拒绝了打卡请求，请核对账号、位置和考勤规则');
      if (verdict === null) throw new AttendanceError('已提交请求，但响应缺少可识别的成功标记；请在考勤系统核对结果', 'unknown');
      return { employeeName: account.employeeName, message: '考勤接口已确认打卡成功' };
    },
    async workday(config, day) {
      if (Object.hasOwn(config.workdayOverrides, day)) {
        return { workday: Boolean(config.workdayOverrides[day]), source: '日期覆盖' };
      }
      if (config.workdayMode === 'weekdays') return { workday: isWeekday(day), source: '周一至周五' };
      try {
        const url = new URL(config.holidayUrl);
        url.searchParams.set('date', day.replaceAll('-', ''));
        const result = await request(url);
        const value = result?.data?.list?.[0]?.workday;
        if (![0, 1, '0', '1'].includes(value)) throw new Error('invalid workday');
        return { workday: String(value) === '1', source: '节假日接口' };
      } catch {
        return {
          workday: config.holidayFallback === 'weekdays' && isWeekday(day),
          source: config.holidayFallback === 'weekdays' ? '接口失败，按周一至周五回退' : '接口失败，跳过今日任务',
          warning: true,
        };
      }
    },
  };
}
