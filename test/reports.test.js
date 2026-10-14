import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDays, normalizeSummary, reportQuery } from '../src/reports.js';

test('月份查询校验分页，并正确计算闰年、非闰年和跨年月份', () => {
  assert.deepEqual(reportQuery({ month: '2024-02' }).dateRange, { beginDate: '2024-02-01', endDate: '2024-02-29' });
  assert.equal(reportQuery({ month: '2026-02' }).dateRange.endDate, '2026-02-28');
  assert.equal(reportQuery({ month: '2026-12' }).dateRange.endDate, '2026-12-31');
  for (const input of [
    { month: '2026-13' }, { month: '2026-1' }, { month: '' }, { month: null },
    { month: '2026-10', page: 0 }, { month: '2026-10', page: 1.5 },
    { month: '2026-10', pageSize: 51 }, { month: '2026-10', summaryPage: NaN },
  ]) assert.throws(() => reportQuery(input));
});

test('保留每日多项目，实际缺卡与计划时间不混淆，不传出未知字段', () => {
  const days = normalizeDays([{
    scheduleDate: '2026-10-14', employeeId: 42, scheduleName: '测试弹性班次',
    existException: 1, existOvertime: null, existTravel: true,
    privateField: 'must-not-return',
    timeAttendance: [
      { attendanceName: '打卡', attendanceType: { valueName: '刷卡' }, beginDateTime: '2026-10-14 08:49',
        endDateTime: null, attendanceNum: null,
        outTimeCardExtraAttendance: { flag: 3, shouldPunchDateTime: '2026-10-14 18:19' } },
      { attendanceName: '年假', attendanceType: { valueName: '休假' }, attendanceNum: '08:00',
        beginDateTime: '2026-10-14 08:30', endDateTime: '2026-10-14 18:30' },
    ],
  }], '42', '2026-10');
  assert.equal(days[0].items.length, 2);
  assert.equal(days[0].items[0].end, null);
  assert.equal(days[0].items[0].plannedEnd, '2026-10-14 18:19');
  assert.equal(days[0].items[1].name, '年假');
  assert.equal(days[0].items[1].duration, '08:00');
  assert.equal(days[0].hasException, true);
  assert.equal(days[0].hasOvertime, false);
  assert.equal(days[0].hasTravel, true);
  assert.ok(!JSON.stringify(days).includes('must-not-return'));
  assert.deepEqual(normalizeDays([{ scheduleDate: '2026-10-11', timeAttendance: null }], '42', '2026-10')[0].items, []);
});

test('汇总保留超过 24 小时时长和原计量单位，不重算或转换为时间', () => {
  const rows = normalizeSummary([
    { attendanceName: '出勤工时', totalNum: '43:01', calculateUnit: { valueName: '小时' }, attendanceType: { valueName: '出差' }, employeeId: { valueId: 42 } },
    { attendanceName: '天数', totalNum: 0, calculateUnit: { valueName: '天' } },
  ], '42');
  assert.equal(rows[0].total, '43:01');
  assert.equal(rows[0].unit, '小时');
  assert.equal(rows[1].total, '0');
});

test('拒绝其他员工、非查询月份、错误列表项目和无效日期', () => {
  assert.throws(() => normalizeDays([{ scheduleDate: '2026-10-14', employeeId: 999 }], '42', '2026-10'), /其他员工/);
  assert.throws(() => normalizeSummary([{ employeeId: { valueId: 999 } }], '42'), /其他员工/);
  assert.throws(() => normalizeDays([{ scheduleDate: '2026-11-01' }], '42', '2026-10'), /非查询月份/);
  assert.throws(() => normalizeDays([{ scheduleDate: '2026-02-30' }], '42', '2026-02'), /无效日期/);
  assert.throws(() => normalizeDays([{ scheduleDate: '2026-10-01', timeAttendance: 'invalid' }], '42', '2026-10'), /格式不兼容/);
});
