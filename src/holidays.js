import { createHash } from 'node:crypto';
import { AppError, appleHolidayUrl, isDate, isWeekday } from './config.js';

export const HOLIDAY_CACHE_TTL = 24 * 60 * 60 * 1000;
const HOLIDAY_YEAR_CACHE_TTL = 7 * HOLIDAY_CACHE_TTL;
const FAILURE_COOLDOWN = 60 * 1000;
const APPLE_RETRY_DELAY = 15 * 60 * 1000;
const appleRefreshDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });
const BACKUP_CALENDARS = [
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/',
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/',
];
const NATIONAL_HOLIDAYS = ['元旦', '春节', '清明', '劳动节', '端午', '中秋', '国庆'];
const DAY_MS = 24 * 60 * 60 * 1000;

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

function coversNationalHolidays(names) {
  return NATIONAL_HOLIDAYS.every(name => names.some(label => label.includes(name)));
}

function recordDay(days, date, workday) {
  if (Object.hasOwn(days, date) && days[date] !== workday) {
    throw new AppError('节假日日历包含冲突日期', 502);
  }
  days[date] = workday;
}

function parseHolidayYear(result, year) {
  if (result?.year !== year || !Array.isArray(result.papers)
    || !result.papers.some(paper => typeof paper === 'string' && /^https?:\/\/www\.gov\.cn\//.test(paper))
    || !Array.isArray(result.days) || result.days.length > 397) {
    throw new AppError('备用节假日日历格式不兼容', 502);
  }
  const days = {};
  const holidayNames = new Set();
  for (const item of result.days) {
    const date = item?.date;
    const isCurrentYear = typeof date === 'string' && date.startsWith(`${year}-`);
    if (typeof date !== 'string' || !isDate(date) || (!isCurrentYear && !date.startsWith(`${year - 1}-12-`))
      || typeof item.name !== 'string' || typeof item.isOffDay !== 'boolean') {
      throw new AppError('备用节假日日历包含无效日期', 502);
    }
    recordDay(days, date, !item.isOffDay);
    if (isCurrentYear && item.isOffDay) holidayNames.add(item.name);
  }
  // A preliminary file may only list New Year's Day. Missing dates in it
  // cannot be treated as ordinary weekdays.
  if (!coversNationalHolidays([...holidayNames])) {
    throw new AppError('备用节假日日历缺少完整年度安排', 502);
  }
  return days;
}

function appleDate(value) {
  const date = value?.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  if (!date || !isDate(date)) throw new AppError('Apple 节假日日历包含无效日期', 502);
  return Date.parse(`${date}T00:00:00Z`);
}

export function parseAppleHolidayCalendar(text) {
  const content = text.replace(/\r?\n[ \t]/g, '').replace(/\r\n/g, '\n').trim();
  if (!content.startsWith('BEGIN:VCALENDAR\n') || !content.endsWith('\nEND:VCALENDAR')) {
    throw new AppError('Apple 节假日日历格式不兼容', 502);
  }
  const days = {};
  const years = new Map();
  for (const [, event] of content.matchAll(/^BEGIN:VEVENT\n([\s\S]*?)^END:VEVENT$/gm)) {
    const summary = event.match(/^SUMMARY(?:;[^:\n]+)?:(.+)（([休班])）$/m);
    if (!summary) continue;
    if (/^(?:RRULE|RDATE|EXDATE|RECURRENCE-ID|DURATION)[;:]/m.test(event)) {
      throw new AppError('Apple 节假日日历包含未支持的日期规则', 502);
    }
    const start = appleDate(event.match(/^DTSTART;VALUE=DATE:(\d{8})$/m)?.[1]);
    const end = /^DTEND[;:]/m.test(event)
      ? appleDate(event.match(/^DTEND;VALUE=DATE:(\d{8})$/m)?.[1]) : start + DAY_MS;
    if (end <= start || end - start > 31 * DAY_MS) {
      throw new AppError('Apple 节假日日历包含无效的日期范围', 502);
    }
    const workday = summary[2] === '班';
    for (let timestamp = start; timestamp < end; timestamp += DAY_MS) {
      const date = new Date(timestamp).toISOString().slice(0, 10);
      recordDay(days, date, workday);
      if (!workday) {
        const year = Number(date.slice(0, 4));
        if (!years.has(year)) years.set(year, new Set());
        years.get(year).add(summary[1]);
      }
    }
  }
  const completeYears = [...years].filter(([, holidays]) => coversNationalHolidays([...holidays])).map(([year]) => year);
  if (!completeYears.length) throw new AppError('Apple 节假日日历缺少完整年度安排', 502);
  return { days, completeYears };
}

function appleWorkday(snapshot, day) {
  const year = Number(day.slice(0, 4));
  if (!snapshot?.completeYears.includes(year)
    || (day.slice(5, 7) === '12' && !snapshot.completeYears.includes(year + 1))) return null;
  return snapshot.days[day] ?? isWeekday(day);
}

function mergeAppleSnapshot(previous, fresh, now) {
  const keepYears = (previous?.completeYears ?? []).filter(year =>
    year >= new Date(now).getUTCFullYear() - 1 && !fresh.completeYears.includes(year));
  const days = { ...fresh.days };
  for (const [day, workday] of Object.entries(previous?.days ?? {})) {
    const year = Number(day.slice(0, 4));
    if (keepYears.includes(year) || (day.slice(5, 7) === '12' && keepYears.includes(year + 1))) {
      days[day] = workday;
    }
  }
  return { days, completeYears: [...fresh.completeYears, ...keepYears], fetchedAt: now, attemptedAt: now };
}

function createCache({ load, save, ttl }, clock) {
  const memory = new Map(), inFlight = new Map(), failures = new Map();
  return async (key, fetchEntry) => {
    const entry = load ? load(key) : memory.get(key);
    const now = clock();
    if (entry && entry.fetchedAt <= now && entry.fetchedAt > now - ttl) {
      return { ...entry, cached: true };
    }
    if (inFlight.has(key)) return inFlight.get(key);
    if ((failures.get(key) || 0) > now) throw new AppError('节假日接口暂不可用，稍后重新查询', 502);
    const promise = Promise.resolve().then(async () => {
      try {
        const fresh = { ...await fetchEntry(), fetchedAt: clock() };
        if (save) save(key, fresh);
        else {
          memory.set(key, fresh);
          if (memory.size > 1000) memory.delete(memory.keys().next().value);
        }
        failures.delete(key);
        return fresh;
      } catch (error) {
        failures.set(key, clock() + FAILURE_COOLDOWN);
        if (failures.size > 1000) failures.delete(failures.keys().next().value);
        throw error;
      }
    });
    inFlight.set(key, promise);
    try { return await promise; }
    finally { inFlight.delete(key); }
  };
}

export function createHolidayCalendar(store, clock = Date.now) {
  const daily = createCache({ load: store?.loadHoliday, save: store?.saveHoliday, ttl: HOLIDAY_CACHE_TTL }, clock);
  const scheduleStore = { load: store?.loadHolidaySchedule, save: store?.saveHolidaySchedule };
  const annual = createCache({ ...scheduleStore, ttl: HOLIDAY_YEAR_CACHE_TTL }, clock);
  let appleSnapshot = store?.loadHolidaySchedule('apple') ?? null;
  let appleRefresh;
  let nextAppleRetry = 0;

  function refreshApple(request) {
    if (appleRefresh) return appleRefresh;
    const now = clock();
    const lastAttempt = appleSnapshot?.attemptedAt ?? appleSnapshot?.fetchedAt;
    if (now < nextAppleRetry || (lastAttempt <= now && appleRefreshDay.format(lastAttempt) === appleRefreshDay.format(now))) return;
    appleRefresh = (async () => {
      let fresh;
      try { fresh = parseAppleHolidayCalendar(await request(new URL(appleHolidayUrl))); }
      catch {
        nextAppleRetry = now + APPLE_RETRY_DELAY;
        if (appleSnapshot) {
          appleSnapshot = { ...appleSnapshot, attemptedAt: now };
          store?.saveHolidaySchedule('apple', appleSnapshot);
        }
        return;
      }
      appleSnapshot = mergeAppleSnapshot(appleSnapshot, fresh, now);
      store?.saveHolidaySchedule('apple', appleSnapshot);
    })().finally(() => { appleRefresh = undefined; });
    return appleRefresh;
  }

  function getYear(year, request) {
    return annual(`holiday-cn:${year}`, async () => {
      for (const base of BACKUP_CALENDARS) {
        try {
          const result = await request(new URL(`${year}.json`, base));
          return { days: parseHolidayYear(result, year) };
        } catch {
          // Try the other host for the same calendar.
        }
      }
      throw new AppError('备用节假日日历暂不可用', 502);
    });
  }

  return {
    refreshApple,
    waitForAppleRefresh: () => appleRefresh,
    getLocalApple(day) {
      const workday = appleWorkday(appleSnapshot, day);
      return workday === null ? null : { workday, source: 'Apple 节假日日历（本地）' };
    },
    async get(endpoint, day, request) {
      const url = holidayRequestUrl(endpoint, day);
      const key = createHash('sha256').update(url.href).digest('hex');
      const { workday, cached } = await daily(key, async () => ({
        day, workday: parseHoliday(await request(url), day),
      }));
      return { workday, source: cached ? '节假日接口（缓存）' : '节假日接口' };
    },
    async getApple(day, request) {
      if (!isDate(day)) throw new AppError('节假日查询日期无效');
      const workday = appleWorkday(appleSnapshot, day);
      if (workday !== null) {
        void refreshApple(request)?.catch(() => {});
        return { workday, source: 'Apple 节假日日历（本地）' };
      }
      await refreshApple(request);
      const updated = appleWorkday(appleSnapshot, day);
      if (updated === null) throw new AppError('Apple 节假日日历尚未覆盖该日期', 502);
      return { workday: updated, source: 'Apple 节假日日历' };
    },
    async getBackup(day, request) {
      if (!isDate(day)) throw new AppError('节假日查询日期无效');
      const year = Number(day.slice(0, 4));
      // A December date can be included in next year's published schedule.
      const [current, next] = await Promise.all([
        getYear(year, request),
        day.slice(5, 7) === '12' ? getYear(year + 1, request) : null,
      ]);
      const workday = next?.days[day] ?? current.days[day] ?? isWeekday(day);
      return { workday, source: current.cached && (!next || next.cached) ? '节假日备用日历（缓存）' : '节假日备用日历' };
    },
  };
}
