import { AppError, isDate } from './config.js';

export function reportQuery({ month, page = 1, pageSize = 20, summaryPage = 1 }) {
  if (typeof month !== 'string' || !/^(19|[2-9]\d)\d{2}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new AppError('月份必须为 YYYY-MM 格式（1900～9999 年）');
  }
  for (const [key, value, max] of [['page', page, 10000], ['pageSize', pageSize, 50], ['summaryPage', summaryPage, 10000]]) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new AppError(`${key}必须为 1～${max} 的整数`);
  }
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { month, page, pageSize, summaryPage, dateRange: { beginDate: `${month}-01`, endDate: `${month}-${lastDay}` } };
}

const text = value => typeof value === 'string' ? value.slice(0, 500) : null;
const dictionary = value => text(value?.valueName);
const dateTime = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)
  && isDate(value.slice(0, 10)) ? value : null;
const marked = value => value === true || value === 1 || value === '1';
const employeeValue = value => value && typeof value === 'object' ? value.valueId : value;

function assertEmployee(value, employeeId) {
  if (value !== null && value !== undefined && String(employeeValue(value)) !== employeeId) {
    throw new AppError('考勤接口返回了其他员工的数据，已拒绝展示，请检查上游权限', 502);
  }
}

export function normalizeDays(rows, employeeId, month) {
  return rows.map(row => {
    if (!row || typeof row !== 'object' || !isDate(row.scheduleDate) || !row.scheduleDate.startsWith(`${month}-`)) {
      throw new AppError('考勤明细包含无效日期或非查询月份的数据', 502);
    }
    assertEmployee(row.employeeId, employeeId);
    if (row.timeAttendance !== null && row.timeAttendance !== undefined && !Array.isArray(row.timeAttendance)) {
      throw new AppError('考勤明细项目格式不兼容', 502);
    }
    if ((row.timeAttendance?.length || 0) > 100) throw new AppError('单日考勤项目超过数量限制', 502);
    return {
      date: row.scheduleDate,
      scheduleName: text(row.scheduleName),
      hasException: marked(row.existException),
      hasOvertime: marked(row.existOvertime),
      hasTravel: marked(row.existTravel),
      items: (row.timeAttendance || []).map(item => {
        if (!item || typeof item !== 'object') throw new AppError('考勤明细项目格式不兼容', 502);
        assertEmployee(item.employeeId, employeeId);
        return {
          name: text(item.attendanceName),
          type: dictionary(item.attendanceType),
          duration: text(item.attendanceNum),
          begin: dateTime(item.beginDateTime),
          end: dateTime(item.endDateTime),
          plannedBegin: dateTime(item.inTimeCardExtraAttendance?.shouldPunchDateTime),
          plannedEnd: dateTime(item.outTimeCardExtraAttendance?.shouldPunchDateTime),
        };
      }),
    };
  });
}

export function normalizeSummary(rows, employeeId) {
  return rows.map(row => {
    if (!row || typeof row !== 'object') throw new AppError('考勤汇总格式不兼容', 502);
    assertEmployee(row.employeeId, employeeId);
    return {
      name: text(row.attendanceName), type: dictionary(row.attendanceType),
      total: text(row.totalNum) ?? (typeof row.totalNum === 'number' && Number.isFinite(row.totalNum) ? String(row.totalNum) : null),
      unit: dictionary(row.calculateUnit),
    };
  });
}

export function normalizeQuota(rows, employeeId, year) {
  if (!Array.isArray(rows) || rows.length > 10) throw new AppError('年假配额列表格式不兼容', 502);
  const hours = value => {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const date = value => typeof value === 'string' && isDate(value.slice(0, 10)) ? value.slice(0, 10) : null;
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new AppError('年假配额格式不兼容', 502);
    assertEmployee(row.employeeId, employeeId);
  }
  if (rows.length > 1) throw new AppError('年假配额返回多条员工记录，请检查查询条件', 502);
  const row = rows[0];
  const normalize = (value, quotaYear, previous) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return {
      year: quotaYear,
      total: previous ? null : hours(value.baseNum),
      released: previous ? null : hours(value.initNum),
      used: hours(previous ? value.extendedUsedNum : value.usedNum),
      remaining: hours(previous ? value.extendedRemainNum : value.availableNum),
      expiresOn: date(previous ? value.extendedExpiryDate : value.expirationDate),
    };
  };
  return {
    current: normalize(row?.annualLeave, year, false),
    previous: [
      normalize(row?.lastYearLeave, year - 1, true),
      normalize(row?.beforeLastYearLeave, year - 2, true),
    ].filter(Boolean),
  };
}
