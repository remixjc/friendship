import { randomInt } from 'node:crypto';

export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const defaults = {
  enabled: false,
  dryRun: true,
  timezone: 'Asia/Shanghai',
  freshDate: '00:05',
  amStart: '08:00',
  amEnd: '08:20',
  pmStart: '18:30',
  pmEnd: '19:00',
  workdayMode: 'weekdays',
  holidayFallback: 'skip',
  workdayOverrides: {},
  company: 'wanji',
  username: '',
  openId: '',
  source: 5,
  apiBaseUrl: 'https://kaoqin.wanji.net.cn',
  holidayUrl: 'https://api.apihubs.cn/holiday/get',
  longitude: 116.295660,
  latitude: 40.049682,
  coordinateJitter: 0.0001,
  sites: [
    '北京市海淀区上地街道首创空间中关村软件园(软件园三号路)',
    '北京市海淀区上地街道软件园二号路中关村软件园(软件园三号路)',
    '北京市海淀区上地街道百家云双师课堂中关村软件园(软件园三号路)',
    '北京市海淀区上地街道软件园四号路中关村软件园(软件园三号路)',
  ],
};

export function minutes(time) {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

export function randomTime(start, end, random = randomInt) {
  const n = random(minutes(start), minutes(end) + 1);
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

export function localClock(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { day: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

export function isWeekday(day) {
  const n = new Date(`${day}T12:00:00Z`).getUTCDay();
  return n !== 0 && n !== 6;
}

export function isDate(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`))
    && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

function validUrl(value, name, allowHttp) {
  try {
    const url = new URL(value);
    if (!(url.protocol === 'https:' || (allowHttp && url.protocol === 'http:'))
      || url.username || url.password || url.hash) throw new Error();
    return url;
  } catch {
    throw new AppError(`${name}必须是有效的 HTTPS 地址`);
  }
}

export function validateSettings(input, previous = defaults, hasPassword = false, allowHttp = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('配置格式错误');
  const settings = structuredClone(previous);
  for (const key of Object.keys(defaults)) if (Object.hasOwn(input, key)) settings[key] = input[key];
  for (const key of ['enabled', 'dryRun']) {
    if (typeof settings[key] !== 'boolean') throw new AppError(`${key}必须为布尔值`);
  }
  for (const key of ['freshDate', 'amStart', 'amEnd', 'pmStart', 'pmEnd']) {
    if (typeof settings[key] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(settings[key])) {
      throw new AppError('时间必须使用 HH:mm 格式');
    }
  }
  if (settings.amStart > settings.amEnd || settings.pmStart > settings.pmEnd) throw new AppError('时间范围的开始不能晚于结束');
  if (settings.amEnd >= settings.pmStart) throw new AppError('上午与下午时间段不能重叠');
  if (settings.freshDate > settings.amStart) throw new AppError('每日刷新时间不能晚于上午时间段的开始');
  try { new Intl.DateTimeFormat('en', { timeZone: settings.timezone }).format(); }
  catch { throw new AppError('无效的时区'); }
  if (!['weekdays', 'holiday'].includes(settings.workdayMode)) throw new AppError('无效的工作日模式');
  if (!['skip', 'weekdays'].includes(settings.holidayFallback)) throw new AppError('无效的节假日接口失败策略');
  if (!settings.workdayOverrides || typeof settings.workdayOverrides !== 'object'
    || Array.isArray(settings.workdayOverrides) || Object.keys(settings.workdayOverrides).length > 366) {
    throw new AppError('日期覆盖必须为最多 366 项的 JSON 对象');
  }
  for (const [day, value] of Object.entries(settings.workdayOverrides)) {
    if (!isDate(day) || (value !== 0 && value !== 1)) throw new AppError('日期覆盖格式为 {"2026-10-01":0}，0 休息，1 工作');
  }
  for (const key of ['company', 'username', 'openId', 'timezone']) {
    if (typeof settings[key] !== 'string' || settings[key].length > 200) throw new AppError(`${key}格式错误`);
    settings[key] = settings[key].trim();
  }
  if (!Number.isInteger(settings.source) || settings.source < 0 || settings.source > 100) throw new AppError('source 必须为 0～100 的整数');
  const base = validUrl(settings.apiBaseUrl, '考勤接口', allowHttp);
  if (base.pathname !== '/' || base.search) throw new AppError('考勤接口填写域名根地址，不含路径或查询参数');
  settings.apiBaseUrl = base.origin;
  validUrl(settings.holidayUrl, '节假日接口', allowHttp);
  for (const [key, limit] of [['longitude', 180], ['latitude', 90]]) {
    if (typeof settings[key] !== 'number' || !Number.isFinite(settings[key]) || Math.abs(settings[key]) > limit) {
      throw new AppError(`${key}超出有效范围`);
    }
  }
  if (typeof settings.coordinateJitter !== 'number' || !Number.isFinite(settings.coordinateJitter)
    || settings.coordinateJitter < 0 || settings.coordinateJitter > 0.001) throw new AppError('坐标随机偏移必须在 0～0.001 度之间');
  if (Math.abs(settings.longitude) + settings.coordinateJitter > 180
    || Math.abs(settings.latitude) + settings.coordinateJitter > 90) throw new AppError('坐标加偏移后超出有效范围');
  if (!Array.isArray(settings.sites) || settings.sites.length < 1 || settings.sites.length > 50
    || settings.sites.some(site => typeof site !== 'string' || !site.trim() || site.length > 300)) {
    throw new AppError('请填写 1～50 个有效打卡地点，每项不超过 300 字');
  }
  settings.sites = settings.sites.map(site => site.trim());
  if (Object.hasOwn(input, 'password') && (typeof input.password !== 'string' || input.password.length > 256)) {
    throw new AppError('考勤密码格式错误');
  }
  if (settings.enabled && !settings.dryRun && (!settings.company || !settings.username || !settings.openId || !hasPassword)) {
    throw new AppError('启用真实自动打卡前，请填写公司、账号、密码和 OpenID');
  }
  return settings;
}

export function importLegacy(input) {
  if (!input?.times || !input?.userInfo?.[0]?.data) throw new AppError('文件必须是原项目 datas.json 格式');
  const { times, userInfo } = input;
  const data = userInfo[0].data;
  return {
    amStart: times.amStart, amEnd: times.amEnd, pmStart: times.pmStart, pmEnd: times.pmEnd,
    freshDate: times.freshDate <= times.amStart ? times.freshDate : '00:05',
    company: data.company, username: data.username, password: data.password,
    source: data.source, openId: data.openId, enabled: false, dryRun: true,
    workdayMode: 'holiday',
  };
}
