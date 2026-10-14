import { createHash } from 'node:crypto';
import { AppError, isDate } from './config.js';

export const HOLIDAY_CACHE_TTL = 24 * 60 * 60 * 1000;
const FAILURE_COOLDOWN = 60 * 1000;

export function holidayRequestUrl(endpoint, day) {
  if (!isDate(day)) throw new AppError('节假日查询日期无效');
  const template = endpoint.includes('{date}');
  const url = new URL(endpoint.replaceAll('{date}', day));
  if (!template) url.searchParams.set('date', day.replaceAll('-', ''));
  return url;
}

export function parseHoliday(result, day) {
  if (!result || typeof result !== 'object' || result.success === false) {
    throw new AppError('节假日接口返回格式不兼容', 502);
  }
  if (Object.hasOwn(result, 'type')) {
    if (![0, '0'].includes(result.code) || ![0, 1, 2, 3].includes(result.type?.type)) {
      throw new AppError('节假日接口返回状态或日期类型不兼容', 502);
    }
    if (day && result.holiday?.date && result.holiday.date !== day) {
      throw new AppError('节假日接口返回了其他日期的数据', 502);
    }
    if (day && Object.hasOwn(result.type, 'week')) {
      const week = new Date(`${day}T12:00:00Z`).getUTCDay() || 7;
      if (result.type.week !== week) throw new AppError('节假日接口返回的星期与查询日期不符', 502);
    }
    // Timor: 0 normal workday, 1 weekend, 2 holiday, 3 compensating workday.
    return [0, 3].includes(result.type.type);
  }
  if (['code', 'statusCode', 'msgCode'].some(key => Object.hasOwn(result, key) && ![0, 200, '0', '200'].includes(result[key]))) {
    throw new AppError('节假日接口返回业务错误', 502);
  }
  const value = result.data?.list?.[0]?.workday;
  if (![0, 1, '0', '1'].includes(value)) throw new AppError('节假日接口返回工作日格式不兼容', 502);
  return String(value) === '1';
}

export function createHolidayCalendar(store, clock = Date.now) {
  const memory = new Map(), inFlight = new Map(), failures = new Map();
  return {
    async get(endpoint, day, request) {
      const url = holidayRequestUrl(endpoint, day);
      const key = createHash('sha256').update(url.href).digest('hex');
      const cached = store ? store.loadHoliday(key) : memory.get(key);
      const now = clock();
      if (cached && cached.day === day && typeof cached.workday === 'boolean'
        && cached.fetchedAt <= now && cached.fetchedAt > now - HOLIDAY_CACHE_TTL) {
        return { workday: cached.workday, source: '节假日接口（缓存）' };
      }
      if (inFlight.has(key)) return inFlight.get(key);
      if ((failures.get(key) || 0) > now) throw new AppError('节假日接口暂不可用，稍后重新查询', 502);
      const promise = Promise.resolve().then(async () => {
        try {
          const workday = parseHoliday(await request(url), day);
          const entry = { day, workday, fetchedAt: clock() };
          if (store) store.saveHoliday(key, entry);
          else {
            memory.set(key, entry);
            if (memory.size > 1000) memory.delete(memory.keys().next().value);
          }
          failures.delete(key);
          return { workday, source: '节假日接口' };
        } catch (error) {
          failures.set(key, clock() + FAILURE_COOLDOWN);
          if (failures.size > 1000) failures.delete(failures.keys().next().value);
          throw error;
        }
      });
      inFlight.set(key, promise);
      try { return await promise; }
      finally { inFlight.delete(key); }
    },
  };
}
