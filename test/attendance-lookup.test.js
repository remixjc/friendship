import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupQuery, lookupUrl, normalizeLookup } from '../src/attendance-lookup.js';

const month = '2026-11';
const query = (type, options = {}) => lookupQuery({ type, month, ...options });
const list = (...rows) => ({ body: rows, totalCount: rows.length });

test('个人查询拦截员工 ID 缺失或串号，待阅保留本账号被分派的流程', () => {
  const row = {
    id: 15, employeeId: { valueId: 7 }, entityName: 'leaveInfo', businessType: { valueName: '年假申请' },
    processSummary: '流程摘要', extIsBatch: { valueId: 0 }, token: 'hidden',
  };
  assert.throws(() => normalizeLookup(list(row), query('processes'), '8'), /归属/);
  assert.throws(() => normalizeLookup(list({}), query('punches'), '8'), /归属/);
  assert.throws(() => normalizeLookup({ body: { employeeId: 7 } }, query('profile'), '8'), /归属/);
  const item = normalizeLookup(list(row), query('unread'), '8').items[0];
  assert.equal(item.title, '年假申请');
  assert.equal(item.detailPath, '/viewProcessDetails?processInfoId=15&entityName=leaveInfo&isMyApp=true');
  assert.ok(!JSON.stringify(item).includes('hidden'));
  assert.equal(lookupUrl('https://example.test', query('unread'), '8').searchParams.has('employeeId'), false);
});

test('月排班展开本人每天的班次，校验日期边界与嵌套员工', () => {
  const records = list({ id: 7, scheduleInfo_: [
    { scheduleDate: '2026-11-02', scheduleName: '常日班', actualWorkNum: 8,
      scheduleDetail_: [{ beginTime: '09:00', endTime: '18:00' }] },
    { scheduleDate: '2026-11-01', scheduleName: '休息' },
  ] });
  const result = normalizeLookup(records, query('schedule'), '7');
  assert.deepEqual(result.items.map(row => row.title), ['休息', '常日班']);
  assert.equal(result.items[1].fields[1].value, '09:00 至 18:00');
  const params = lookupUrl('https://example.test', query('schedule'), '7').searchParams;
  assert.deepEqual(params.getAll('filter[]').map(value => JSON.parse(value).value), ['2026-11-01', '2026-11-30']);
  assert.equal(params.get('employeeId'), '7');
  records.body[0].scheduleInfo_[0].employeeId = 8;
  assert.throws(() => normalizeLookup(records, query('schedule'), '7'), /归属/);
  records.body[0].scheduleInfo_[0].scheduleDate = '2026-12-01';
  assert.throws(() => normalizeLookup(records, query('schedule'), '7'), /不兼容/);
});

test('部门按名称、简称、上级或编码筛选，只输出展示字段', () => {
  const rows = list({ id: 1, departmentName: '研发中心' },
    { id: 2, departmentName: '应用软件组', parentId: { valueId: 1 }, departmentCode: 'RD-03', orgComments: 'hidden' });
  const { items } = normalizeLookup(rows, query('departments', { search: ' RD-03 ' }), '8');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '应用软件组');
  assert.deepEqual(items[0].fields[0], { label: '上级部门', value: '研发中心' });
  assert.ok(!JSON.stringify(items).includes('hidden'));
  assert.equal(normalizeLookup(rows, query('departments', { search: '无匹配' }), '8').total, 0);
});
