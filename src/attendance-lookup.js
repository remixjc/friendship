import { AppError, isDate } from './config.js';
import { reportQuery } from './reports.js';

const endpoints = {
  schedule: '/workforce/scheduleInfo',
  exceptions: '/workforce/exceptionResult',
  leave: '/workforce/leaveInfo',
  travel: '/workforce/travelInfo',
  punches: '/workforce/punchInfo',
  cancellations: '/workforce/leaveCancelInfo',
  quotas: '/workforce/calculationQuota',
  processes: '/workflow/processInfo/token',
  unread: '/workflow/processInfo/toRead',
  profile: '/system/employee/info',
  departments: '/employee/department',
  overview: '/workforce/getAttendanceSituationByMonth',
};

const leavePeriod = [
  ['开始', ['beginDateTime', 'beginDate']], ['结束', ['endDateTime', 'endDate']],
  ['申请时间', ['extApplyDateTime', 'applyDateTime']], ['审批完成', ['extApproveDateTime', 'approveDateTime']],
];
const workflow = {
  title: ['businessType', 'processName', 'processDefineName'],
  date: ['applyDateTime', 'extApplyDateTime', 'createDateTime'],
  status: ['applyStatus', 'processStatus', 'status'],
  fields: [['流程概述', 'processSummary'], ['当前审批人', 'handleEmployeeId'], ['流程来源', 'source']],
};
const layouts = {
  schedule: {
    title: 'scheduleName', date: 'scheduleDate',
    fields: [['工时', 'actualWorkNum'], ['备注', 'notation']],
  },
  exceptions: {
    title: 'exceptionName', date: 'scheduleDate', status: 'isConfirm',
    fields: [['数量', 'exceptionNum'], ['计量单位', 'calculateUnit'], ['应刷卡', 'shouldPunchDateTime1'],
      ['实际刷卡', 'actualPunchDateTime1'], ['申诉时间', 'complaintDateTime1'],
      ['第二段应刷卡', 'shouldPunchDateTime2'], ['第二段实际刷卡', 'actualPunchDateTime2'],
      ['第二段申诉时间', 'complaintDateTime2']],
  },
  leave: {
    title: 'vacationName', date: ['beginDate', 'beginDateTime'], status: 'applyStatus',
    fields: [...leavePeriod, ['休假类型', 'vacationType'], ['休假数量', 'leaveNum'], ['计量单位', 'calculateUnit'],
      ['预计结束', 'expectEndDate'], ['说明', 'comments']],
  },
  travel: {
    title: ['travelName', 'travelDefineId'], date: ['beginDate', 'beginDateTime'], status: 'applyStatus',
    fields: [...leavePeriod, ['出差数量', 'travelNum'], ['计量单位', 'calculateUnit'],
      ['目的地', ['destination', 'travelDestination', 'travelSite', 'travelAddress']], ['说明', 'comments']],
  },
  punches: {
    title: 'punchDateTime', date: 'punchResultDate', status: 'punchStatus',
    fields: [['打卡类型', 'punchType'], ['打卡方式', 'punchWay'], ['来源', 'source'], ['打卡地址', 'punchSite']],
  },
  cancellations: {
    title: ['vacationName', 'vacationDefineId'], date: ['extCancelBeginDate', 'extCancelBeginDateTime'], status: 'applyStatus',
    fields: [...leavePeriod, ['休假数量', 'leaveNum'], ['计量单位', 'calculateUnit'],
      ['销假开始', ['extCancelBeginDateTime', 'extCancelBeginDate']], ['销假结束', ['extCancelEndDateTime', 'extCancelEndDate']],
      ['销假原因', ['extCancelReason', 'cancelReason']], ['销假说明', 'extLeaveCancelComment']],
  },
  quotas: {
    title: 'vacationName', date: 'effectiveDate', status: 'isExpiry',
    fields: [['剩余额度', 'remainNum'], ['已用额度', 'usedNum'], ['计量单位', 'calculateUnit'], ['失效日期', 'expiryDate'],
      ['计算周期', 'calcPeriod'], ['额度归属', 'quotaBelong'], ['额度基数', 'baseNum'], ['初始化额度', 'initNum'],
      ['调整额度', 'adjustNum'], ['已补偿额度', 'paidNum'], ['审批中数量', 'lockNum']],
  },
  processes: workflow,
  unread: workflow,
  profile: {
    title: 'employeeName', date: 'positionName', status: 'employeeStatus',
    fields: [['员工编号', 'employeeCode'], ['组织及部门', ['departmentName', 'departmentId']],
      ['入职日期', 'entryDate'], ['司龄', 'workingAge']],
  },
  overview: {
    fields: [['旷工次数', 'absenteeismNum'], ['忘打卡次数', 'forgetNum'], ['请假次数', 'leaveNum'], ['加班次数', 'overtimeNum']],
  },
};

export function lookupQuery({ type, month, page, search = '' }) {
  if (!Object.hasOwn(endpoints, type)) throw new AppError('不支持的考勤查询类型');
  const query = reportQuery({ month, page, pageSize: type === 'schedule' ? 50 : 20 });
  if (['schedule', 'profile', 'overview'].includes(type) && query.page !== 1) throw new AppError('此查询仅支持第 1 页');
  if (typeof search !== 'string' || search.length > 80) throw new AppError('搜索内容最多 80 个字符');
  return { ...query, type, search: search.trim().toLowerCase() };
}

export function lookupUrl(baseUrl, query, employeeId) {
  const { type, page, pageSize, dateRange } = query;
  const url = new URL(`/api${endpoints[type]}`, baseUrl);
  const params = url.searchParams;
  const addFilter = filter => params.append('filter[]', JSON.stringify(filter));
  if (type === 'profile' || type === 'departments') return url;
  if (type === 'overview') {
    for (const [key, value] of Object.entries({ ...dateRange, employeeId })) params.set(key, value);
    return url;
  }
  params.set('pageNum', String(page));
  params.set('pageSize', String(pageSize));
  // Both workflow endpoints apply their own session scope. Waiting-to-read items
  // may be assigned to this account by a different employee.
  if (!['processes', 'unread'].includes(type)) params.set('employeeId', employeeId);
  if (type === 'schedule') {
    addFilter({ field: 'scheduleDate', value: dateRange.beginDate, condition: '>=' });
    addFilter({ field: 'scheduleDate', value: dateRange.endDate, condition: '<=' });
  } else {
    params.set('dateRange', JSON.stringify(dateRange));
  }
  if (type === 'processes' || type === 'leave') {
    addFilter({ entityName: type === 'processes' ? 'processInfo' : 'leaveInfo',
      fieldName: 'applyStatus', condition: 'not in', fieldValue: [4] });
  }
  return url;
}

const isObject = row => row !== null && typeof row === 'object' && !Array.isArray(row);
const badShape = () => new AppError('考勤系统返回的查询格式不兼容', 502);
const idValue = value => isObject(value) ? value.valueId : value;

function verifyOwner(owner, employeeId) {
  const id = idValue(owner);
  if (!['number', 'string'].includes(typeof id) || String(id) !== employeeId) {
    throw new AppError('考勤系统返回了无法核实归属的记录，请核对账号的考勤查询权限', 502);
  }
}

function displayValue(row, keys) {
  for (const key of [keys].flat()) {
    const field = row[key];
    const value = isObject(field) ? field.valueName : field;
    if (typeof value === 'string' && value.trim()) return value.slice(0, 500);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function workflowDetail(row) {
  const id = String(row.id ?? '');
  if (!/^[\w-]{1,80}$/.test(id) || typeof row.entityName !== 'string' || !/^\w{1,80}$/.test(row.entityName)) return null;
  const params = new URLSearchParams({ processInfoId: id, entityName: row.entityName, isMyApp: 'true' });
  const batch = [1, '1', true].includes(idValue(row.extIsBatch));
  if (batch) {
    const employee = String(idValue(row.employeeId) ?? '');
    if (!/^[\w-]{1,80}$/.test(employee)) return null;
    params.set('applyEmployeeId', employee);
  }
  return `${batch ? '/batchRequest' : '/viewProcessDetails'}?${params}`;
}

function projectRow(row, type) {
  const layout = layouts[type];
  const fields = layout.fields.flatMap(([label, key]) => {
    const value = displayValue(row, key);
    return value === null ? [] : [{ label, value }];
  });
  if (type === 'schedule') {
    const segments = row.scheduleDetail_ ?? [];
    if (!Array.isArray(segments) || segments.length > 16 || segments.some(segment => !isObject(segment))) throw badShape();
    for (const segment of segments) {
      const from = [displayValue(segment, 'beginDate'), displayValue(segment, 'beginTime')].filter(Boolean).join(' ');
      const to = [displayValue(segment, 'endDate'), displayValue(segment, 'endTime')].filter(Boolean).join(' ');
      const period = [from, to].filter(Boolean).join(' 至 ');
      if (period) fields.push({ label: displayValue(segment, 'scheduleType') || '班次时段', value: period });
    }
  }
  return { title: displayValue(row, layout.title), date: displayValue(row, layout.date),
    status: displayValue(row, layout.status), fields,
    ...(['processes', 'unread'].includes(type) ? { detailPath: workflowDetail(row) } : {}) };
}

function normalizeDepartments(rows, query) {
  const { page, pageSize, search } = query;
  if (!Array.isArray(rows) || rows.length > 2000 || rows.some(row => !isObject(row))) throw badShape();
  const byId = new Map(rows.map(row => [String(row.id), displayValue(row, 'departmentName')]));
  const matches = rows.flatMap(row => {
    const title = displayValue(row, 'departmentName');
    if (!title) return [];
    const code = displayValue(row, 'departmentCode');
    const shortName = displayValue(row, 'shortName');
    const parent = byId.get(String(idValue(row.parentId))) || (isObject(row.parentId) ? displayValue(row, 'parentId') : null);
    if (search && ![title, code, shortName, parent].some(value => value?.toLowerCase().includes(search))) return [];
    const fields = [['上级部门', parent], ['部门编码', code], ['简称', shortName], ['组织层级', displayValue(row, 'grade')]]
      .filter(([, value]) => value).map(([label, value]) => ({ label, value }));
    return [{ title, status: displayValue(row, 'isEnable'), fields }];
  });
  const offset = (page - 1) * pageSize;
  return { items: matches.slice(offset, offset + pageSize), page, pageSize, total: matches.length };
}

export function normalizeLookup(content, query, employeeId) {
  const { type, month, page, pageSize } = query;
  const body = content?.body;
  if (type === 'profile' || type === 'overview') {
    if (!isObject(body)) throw badShape();
    if (type === 'profile' || body.employeeId != null) verifyOwner(body.employeeId, employeeId);
    return { items: [projectRow(body, type)], page: 1, pageSize, total: 1 };
  }
  const count = content?.totalCount;
  const total = typeof count === 'string' && /^\d+$/.test(count) ? Number(count) : count;
  if ((total === null || total === 0) && (body === null || (Array.isArray(body) && !body.length))) {
    return { items: [], page, pageSize, total: 0 };
  }
  if (type === 'departments') return normalizeDepartments(body, query);
  if (!Array.isArray(body) || body.length > pageSize || !Number.isSafeInteger(total) || total < body.length
    || body.some(row => !isObject(row))) throw badShape();
  if (type === 'schedule') {
    const days = body.flatMap(row => {
      if (!Object.hasOwn(row, 'scheduleInfo_')) return [row];
      verifyOwner(row.employeeId ?? row.id, employeeId);
      if (row.scheduleInfo_ === null) return [];
      if (!Array.isArray(row.scheduleInfo_) || row.scheduleInfo_.length > 31) throw badShape();
      return row.scheduleInfo_;
    });
    if (days.length > 50 || total > body.length) throw badShape();
    for (const day of days) {
      if (!isObject(day) || !isDate(day.scheduleDate) || !day.scheduleDate.startsWith(`${month}-`)) throw badShape();
      // Direct schedules have an owner. Nested dates may inherit their checked parent owner.
      if (day.employeeId != null || body.includes(day)) verifyOwner(day.employeeId, employeeId);
    }
    days.sort((a, b) => a.scheduleDate.localeCompare(b.scheduleDate));
    return { items: days.map(day => projectRow(day, type)), page, pageSize, total: days.length };
  }
  if (type !== 'unread') {
    for (const row of body) verifyOwner(row.employeeId, employeeId);
  }
  return { items: body.map(row => projectRow(row, type)), page, pageSize, total };
}
