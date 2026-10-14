import { randomInt } from 'node:crypto';
import { AppError, isWeekday } from './config.js';

export class AttendanceError extends AppError {
  constructor(message, outcome = 'failed') {
    super(message, 502);
    this.outcome = outcome;
  }
}

export function createAttendance(fetchImpl = fetch, timeout = 12000) {
  async function request(url, options = {}, submitted = false) {
    const uncertain = submitted ? 'unknown' : 'failed';
    try {
      const response = await fetchImpl(url, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(timeout),
        headers: { Accept: 'application/json', ...options.headers },
      });
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
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new AttendanceError('上游返回了非 JSON 响应', uncertain); }
    } catch (error) {
      if (error instanceof AttendanceError) throw error;
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
      for (const key of ['code', 'statusCode']) {
        if (Object.hasOwn(object, key)) {
          if (![0, 200, '0', '200', '0000'].includes(object[key])) return false;
          success = true;
        }
      }
    }
    return success ? true : null;
  }

  async function login(config) {
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
    async punch(config, dryRun) {
      const point = location(config);
      if (dryRun) return { employeeName: config.username || '模拟账号', message: `模拟完成：${point.punchSite}（${point.longitude}, ${point.latitude}），未调用考勤接口` };
      const account = await login(config);
      const response = await request(`${config.apiBaseUrl}/api/workforce/mobileAttendance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Token': account.token },
        body: JSON.stringify({ data: {
          ...point, punchWay: 2, employeeId: account.employeeId, extUserDevice: account.openId,
        } }),
      }, true);
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
