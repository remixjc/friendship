const root = document.querySelector('#root');
const icons = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor" stroke="none"/><circle cx="15" cy="17" r="3" fill="currentColor" stroke="none"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  logs: '<path d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M21 20v-2a6 6 0 0 0-4-5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  logout: '<path d="M10 17v3H4V4h6v3M8 12h13M17 8l4 4-4 4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1"/>',
  moon: '<path d="M20 15a9 9 0 0 1-11-11 9 9 0 1 0 11 11Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
  arrow: '<path d="M5 12h14M14 7l5 5-5 5"/>',
  refresh: '<path d="M20 8V3l-3 3a8 8 0 1 0 3 8M20 8h-5"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-5"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.clock}</svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let state = { user: null, csrf: null, settings: null, page: 'dashboard', runsPage: 1, renderId: 0,
  reportMonth: '', reportPage: 1, summaryPage: 1 };
let toastTimer, refreshTimer;
function toast(message, error = false) {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.className = `visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = ''; }, error ? 7000 : 4500);
}
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf || '', ...options.headers },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.user) {
      state.user = null;
      clearInterval(refreshTimer);
      showAuth(true);
    }
    throw new Error(result.error || '请求失败');
  }
  return result;
}
const brand = `<div class="brand"><span class="brandmark">F</span><div>FriendsShip<small>ATTENDANCE STUDIO</small></div></div>`;
const button = (label, action, name = '', style = 'secondary') => `<button class="button ${style}" type="button" data-action="${action}">${name ? icon(name) : ''}${label}</button>`;
const badge = (text, style = '') => `<span class="badge ${style}">${escape(text)}</span>`;
const dateFormat = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: state.settings?.timezone || 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value)) : '—';
const statuses = { success: ['已成功', ''], simulated: ['模拟完成', 'blue'], failed: ['失败', 'error'], unknown: ['结果待核对', 'warn'], skipped: ['已跳过', 'gray'], running: ['执行中', 'warn'] };
const runBadge = status => badge(...(statuses[status] || [status, 'gray']));
function field(name, title, value, { type = 'text', hint = '', placeholder = '', required = false, span = false, min = '', max = '', step = '' } = {}) {
  return `<label class="field${span ? ' span-2' : ''}"><span>${title}</span><input name="${name}" type="${type}" value="${escape(value)}" placeholder="${escape(placeholder)}" ${required ? 'required' : ''} ${min !== '' ? `min="${min}"` : ''} ${max !== '' ? `max="${max}"` : ''} ${step !== '' ? `step="${step}"` : ''} ${type === 'password' ? 'autocomplete="new-password"' : ''}>${hint ? `<small>${hint}</small>` : ''}</label>`;
}
function select(name, title, value, items, hint = '') {
  return `<label class="field"><span>${title}</span><select name="${name}">${items.map(([key, label]) => `<option value="${key}" ${key === value ? 'selected' : ''}>${label}</option>`).join('')}</select>${hint ? `<small>${hint}</small>` : ''}</label>`;
}
function toggle(name, label, checked, text) {
  return `<div class="toggle-row"><div><strong>${label}</strong><p>${text}</p></div><label class="switch"><input type="checkbox" name="${name}" aria-label="${label}" ${checked ? 'checked' : ''}><span class="switch-track"></span></label></div>`;
}
function showAuth(initialized) {
  root.innerHTML = `<div class="auth"><section class="auth-story">${brand}<div><span class="eyebrow">A LITTLE LESS TO REMEMBER</span><h1>把日常交给计划，<br><em>把时间留给自己。</em></h1><p>从每天的第一件事，到准时结束工作。<br>让考勤、配置和执行记录，井然有序。</p></div><footer><span>每日计划</span><span>独立配置</span><span>安心管理</span></footer></section><main class="auth-main"><div class="auth-card"><span class="eyebrow">${initialized ? 'WELCOME BACK' : 'YOUR FIRST STEP'}</span><h2>${initialized ? '登录你的工作空间' : '创建管理员账号'}</h2><p>${initialized ? '欢迎回来，今天的计划已经准备就绪。' : '首次使用，请设置控制台登录账号。创建完成后即可配置考勤服务。'}</p><form id="auth-form">${!initialized ? field('displayName', '显示名称', '', { placeholder: '如何称呼你', max: 60 }) : ''}<label class="field"><span>用户名</span><input name="username" autocomplete="username" placeholder="3～40 位字母、数字或 _ . -" required minlength="3" maxlength="40" pattern="[a-zA-Z0-9_.-]+"></label><label class="field"><span>密码</span><input name="password" type="password" autocomplete="${initialized ? 'current-password' : 'new-password'}" placeholder="${initialized ? '输入登录密码' : '至少 10 位字符'}" required ${!initialized ? 'minlength="10"' : ''} maxlength="128"></label><div class="form-error" id="auth-error" role="alert"></div><button class="button primary" type="submit">${initialized ? '登录控制台' : '创建并进入控制台'}${icon('arrow')}</button></form><div class="auth-footnote">控制台账号与考勤账号分别管理<br>FriendsShip · 让每一天更有秩序</div></div></main></div>`;
  document.querySelector('#auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = event.target.querySelector('button[type=submit]');
    submit.disabled = true;
    document.querySelector('#auth-error').textContent = '';
    try {
      const result = await api(initialized ? '/auth/login' : '/auth/setup', { method: 'POST', body: Object.fromEntries(new FormData(event.target)) });
      state.user = result.user; state.csrf = result.csrf;
      await enterApp();
    } catch (error) { document.querySelector('#auth-error').textContent = error.message; }
    finally { submit.disabled = false; }
  });
}
const pages = { dashboard: ['dashboard', '工作概览', 'Overview'], attendance: ['logs', '考勤记录', 'Attendance'], quota: ['sun', '年假配额', 'Leave quota'], settings: ['settings', '个人配置', 'Configuration'], runs: ['clock', '执行记录', 'History'], logs: ['logs', '运行日志', 'Activity'], users: ['users', '用户管理', 'Members'], account: ['shield', '账号安全', 'Security'] };
function shell() {
  root.innerHTML = `<div class="shell"><aside class="sidebar">${brand}<div class="nav-label">WORKSPACE</div><nav class="nav">${Object.entries(pages).filter(([key]) => key !== 'users' || state.user.role === 'admin').map(([key, [name, title]]) => `<a href="#${key}" data-page="${key}">${icon(name)}${title}</a>`).join('')}</nav><div class="sidebar-bottom"><div class="side-note"><strong>每一次执行，都有迹可循。</strong><p>计划和结果持久保存，随时了解<br>你的考勤任务运行情况。</p></div><div class="profile"><span class="avatar">${escape(state.user.displayName.slice(0, 1).toUpperCase())}</span><div class="profile-info"><strong>${escape(state.user.displayName)}</strong><span>${state.user.role === 'admin' ? '管理员' : '成员'}</span></div><button class="logout" data-action="logout" aria-label="退出登录">${icon('logout')}</button></div></div></aside><main class="main"><header class="topbar"><div>工作空间 <span> / </span><strong id="breadcrumb">工作概览</strong></div><div class="topbar-right"><span class="online">服务运行中</span><span class="profile-mobile">${escape(state.user.displayName)}<button data-action="logout">退出</button></span><span id="top-date"></span></div></header><div class="content" id="content"></div></main></div>`;
  root.addEventListener('click', onClick);
}
function heading(title, subtitle, actions = '') {
  return `<div class="page-heading"><div><span class="eyebrow">${pages[state.page]?.[2].toUpperCase() || 'WORKSPACE'}</span><h1>${title}</h1><p>${subtitle}</p></div><div class="actions">${actions}</div></div>`;
}
function empty(message) { return `<div class="empty">${icon('logs')}${message}</div>`; }
function runsTable(runs) {
  if (!runs.length) return empty('还没有执行记录<br>先完成配置，再试一次模拟打卡。');
  return `<div class="table-wrap"><table><thead><tr><th>执行时间</th><th>任务</th><th>状态</th><th>结果说明</th></tr></thead><tbody>${runs.map(run => `<tr><td class="time">${dateFormat(run.created_at)}</td><td>${run.trigger === 'manual' ? '手动执行' : run.slot === 'am' ? '上午打卡' : '下午打卡'}</td><td>${runBadge(run.status)}</td><td class="message">${escape(run.message || '等待接口响应…')}</td></tr>`).join('')}</tbody></table></div>`;
}
function attendanceMonth() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: state.settings.timezone, year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}`;
}
function reportPagination(data, prefix, noun) {
  if (!data) return '';
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return `<div class="pagination"><span>共 ${data.total} ${noun} · 第 ${data.page} / ${pages} 页</span><div class="actions"><button class="button secondary" data-action="${prefix}-prev" ${data.page <= 1 ? 'disabled' : ''}>上一页</button><button class="button secondary" data-action="${prefix}-next" ${data.page >= pages ? 'disabled' : ''}>下一页</button></div></div>`;
}
function attendanceTime(actual, planned, day) {
  const short = value => value?.startsWith(`${day} `) ? value.slice(11) : value;
  return `<span class="actual-time">${actual ? escape(short(actual)) : '—'}</span>${planned ? `<small class="planned-time">计划 ${escape(short(planned))}</small>` : ''}`;
}
function attendanceTable(data) {
  if (!data.items.length) return empty('这个月份暂无考勤明细。');
  return `<div class="table-wrap"><table class="attendance-table"><thead><tr><th>日期 / 班次</th><th>考勤项目</th><th>时长</th><th>实际开始时间</th><th>实际结束时间</th><th>标记</th></tr></thead><tbody>${data.items.map(day => {
    const items = day.items.length ? day.items : [{ name: '暂无考勤项目' }];
    const flags = [day.hasException ? badge('存在异常', 'error') : '', day.hasOvertime ? badge('存在加班', 'blue') : '', day.hasTravel ? badge('存在出差', 'blue') : ''].filter(Boolean).join(' ') || '—';
    return items.map((item, index) => `<tr>${index === 0 ? `<td rowspan="${items.length}" class="attendance-day"><strong>${escape(day.date)}</strong><span>${escape(day.scheduleName || '暂无班次')}</span></td>` : ''}<td class="attendance-item">${escape(item.name || '未命名项目')}<span class="hint">${escape(item.type || '')}</span></td><td class="attendance-duration">${escape(item.duration ?? '—')}</td><td class="attendance-clock">${attendanceTime(item.begin, item.plannedBegin, day.date)}</td><td class="attendance-clock">${attendanceTime(item.end, item.plannedEnd, day.date)}</td>${index === 0 ? `<td rowspan="${items.length}" class="attendance-flags">${flags}</td>` : ''}</tr>`).join('');
  }).join('')}</tbody></table></div>`;
}
function reportError(message) {
  return `<div class="report-error" role="alert">${icon('logs')}<p>${escape(message)}</p><span>检查个人配置和考勤查询权限后重试。</span></div>`;
}
function quotaView(data = null, error = null) {
  const configured = state.settings.username && state.settings.company && state.settings.openId && state.settings.hasPassword;
  const quotaCard = (quota, current) => `<section class="card report-summary quota-summary"><div class="card-head"><h2>${quota.year} 年${current ? '年假配额' : '结余'}</h2>${badge(current ? '当前年度' : '过往年度', current ? '' : 'gray')}</div><div class="summary-grid">${[
    ...(current ? [['年度额度', quota.total], ['已释放', quota.released]] : []),
    ['已使用', quota.used], ['未使用', quota.remaining],
  ].map(([label, value]) => `<article class="summary-item"><strong>${label}</strong><p>${escape(value ?? '—')}<small>小时</small></p></article>`).join('')}</div><div class="quota-expiry">失效日期：${escape(quota.expiresOn || '未提供')}</div></section>`;
  return heading('年假配额', '查看当前年度额度、使用情况及过往年度结余。', button('刷新配额', 'refresh', 'refresh'))
    + (!configured ? `<section class="card">${empty('请先在个人配置中填写考勤账号信息。')}<div class="report-config">${button('前往个人配置', 'settings', 'settings', 'primary')}</div></section>` : error ? `<section class="card">${reportError(error)}</section>` : data ? `
      <div class="quota-caption">${escape(data.employeeName)} · 更新于 ${dateFormat(data.queriedAt)} · 数据来自考勤系统</div>
      ${data.current ? quotaCard(data.current, true) : `<section class="card report-summary">${empty('上游尚未提供当前年度的年假配额。')}</section>`}
      ${data.previous.map(quota => quotaCard(quota, false)).join('')}
      <div class="footer"><span>未使用时长采用上游值，不以年度额度减去已用时长推算。</span><span>未提供的数据展示为「—」。</span></div>` : '');
}
function attendanceView(data = null, error = null) {
  const configured = state.settings.username && state.settings.company && state.settings.openId && state.settings.hasPassword;
  return heading('考勤记录', '查看考勤系统中的实际明细与月度汇总。', button('刷新考勤', 'refresh', 'refresh'))
    + `<section class="card report-filter"><form id="report-form"><label class="field"><span>查询月份</span><input name="month" type="month" min="1900-01" max="9999-12" value="${escape(state.reportMonth)}" required></label><button type="submit" class="button primary">${icon('logs')}查询考勤</button><p>${data ? `${escape(data.employeeName)} · 更新于 ${dateFormat(data.queriedAt)}` : '按个人配置中的考勤账号查询'}</p></form></section>`
    + (!configured ? `<section class="card">${empty('请先在个人配置中填写公司、考勤账号、密码和 OpenID。')}<div class="report-config">${button('前往个人配置', 'settings', 'settings', 'primary')}</div></section>` : error ? `<section class="card">${reportError(error)}</section>` : data ? `
      <section class="card report-summary"><div class="card-head"><h2>月度考勤汇总</h2><span>${escape(data.month)} · 按上游统计展示</span></div>${data.summaryError ? reportError(data.summaryError) : data.summary.items.length ? `<div class="summary-grid">${data.summary.items.map(item => `<article class="summary-item"><div><strong>${escape(item.name || '未命名项目')}</strong>${badge(item.type || '考勤汇总', 'gray')}</div><p>${escape(item.total ?? '—')}<small>${escape(item.unit || '')}</small></p></article>`).join('')}</div>${reportPagination(data.summary, 'summary', '项')}` : empty('这个月份暂无汇总数据。')}</section>
      <section class="card"><div class="card-head"><h2>考勤明细</h2><span>同一天的多个考勤项目分别展示</span></div><div class="report-note">打卡项目的实际时间为空时显示「—」；下方灰色「计划」仅供参考，不表示已经打卡。休假等项目显示上游记录的起止时间。</div>${data.recordsError ? reportError(data.recordsError) : attendanceTable(data.records) + reportPagination(data.records, 'report', '个日期')}</section>
      <div class="footer"><span>考勤查询仅获取记录，不会提交打卡。</span><span>时长与汇总采用上游值，不在本地重新计算。</span></div>` : '');
}
function dashboard(data) {
  const config = state.settings, plan = data.plan;
  const detail = (key, value) => `<div class="detail"><span>${key}</span><strong>${value}</strong></div>`;
  return heading(`你好，${escape(state.user.displayName)}。`, '看一眼今天的安排，让每一次执行都心中有数。', button('模拟打卡', 'simulate', 'play') + button('个人配置', 'settings', 'settings', 'primary'))
    + `<section class="welcome"><div><span class="eyebrow">TODAY, WELL PLANNED</span><h2>${!data.enabled ? '先准备好，再从容出发。' : data.dryRun ? '你的计划，正在模拟运行。' : plan?.workday ? '今天的考勤，已加入计划。' : '今天可以慢一点。'}</h2><p>${!data.enabled ? '定时任务尚未开启。完成账号和时间配置后，可以先用模拟打卡验证整个流程。' : data.dryRun ? '模拟模式会记录计划和执行结果。准备好后，在个人配置中切换到真实打卡。' : plan?.workday ? '系统会在选定的时间内执行打卡。每个定时任务仅提交一次，结果可在执行记录中查看。' : '当前未安排工作日任务。你仍可以查看配置、记录，或手动执行测试。'}</p></div><div class="welcome-symbol"><div class="clock-graphic"></div></div></section>`
    + `<div class="stats">${[['今日执行', data.stats.total || 0, '次', 'clock', '包含手动与定时任务'], ['真实成功', data.stats.success || 0, '次', 'check', '由考勤接口确认'], ['模拟完成', data.stats.simulated || 0, '次', 'play', '不发送考勤请求'], ['需要关注', data.stats.failed || 0, '次', 'logs', '失败或结果待核对']].map(([label, value, unit, name, foot]) => `<div class="stat"><div class="stat-top">${label}${icon(name)}</div><div class="stat-value">${value}<small>${unit}</small></div><div class="stat-foot">${foot}</div></div>`).join('')}</div>`
    + `<div class="dashboard-grid"><section class="card"><div class="card-head"><h2>今日打卡计划</h2>${plan ? badge(plan.workday ? '工作日' : '休息日', plan.workday ? '' : 'gray') : badge('等待刷新', 'gray')}</div><div class="card-body">${[['am', '上午打卡', 'sun'], ['pm', '下午打卡', 'moon']].map(([slot, label, name]) => `<div class="schedule-row"><div class="schedule-icon">${icon(name)}</div><div><h3>${label}</h3><p>随机范围 ${config[`${slot}Start`]} – ${config[`${slot}End`]}</p></div><div class="schedule-time">${plan?.[slot] || '--:--'}<small>${plan ? '已生成计划' : '尚未生成'}</small></div></div>`).join('')}<div class="plan-note">${escape(plan?.source || `每日 ${config.freshDate} 后生成计划`)} · ${escape(config.timezone)}<br>错过执行时间会记录为跳过，避免重启后补打卡。</div></div></section><section class="card"><div class="card-head"><h2>服务状态</h2>${badge(data.enabled ? '已启用' : '已暂停', data.enabled ? '' : 'gray')}</div><div class="card-body">${detail('定时任务', data.enabled ? '运行中' : '未开启')}${detail('执行模式', data.dryRun ? badge('模拟模式', 'blue') : badge('真实打卡', 'warn'))}${detail('考勤账号', escape(config.username || '尚未配置'))}${detail('考勤密码', config.hasPassword ? '已加密保存' : '尚未设置')}${detail('每日刷新', config.freshDate)}${detail('工作日规则', config.workdayMode === 'holiday' ? '节假日接口' : '周一至周五')}<div class="actions">${button('测试考勤登录', 'test-login', 'shield')}${!data.dryRun ? button('立即打卡', 'real-run', 'play', 'primary') : ''}</div></div></section></div><section class="card"><div class="card-head"><h2>最近执行</h2><a href="#runs" class="button ghost">查看全部 ${icon('arrow')}</a></div>${runsTable(data.runs)}</section><div class="footer"><span>FriendsShip / Attendance Studio</span><span>数据独立保存 · 执行记录保留 90 天</span></div>`;
}
function section(number, title, subtitle, content) {
  return `<section class="card section-card"><div class="section-title"><span class="section-number">${number}</span><div><h2>${title}</h2><p>${subtitle}</p></div></div>${content}</section>`;
}
function settingsView(config) {
  return heading('个人配置', '配置你的考勤账号与执行计划。修改后，请保存再测试。')
    + `<div class="settings-layout"><form id="settings-form">${section('01', '运行方式', '先用模拟模式验证，准备好后再开启真实执行。',
      toggle('enabled', '开启定时任务', config.enabled, '在工作日按上午、下午计划自动执行。') + toggle('dryRun', '模拟模式', config.dryRun, '仅生成执行记录，不登录或提交考勤请求。'))}
      ${section('02', '考勤账号', '登录状态自动保存，失效后重新登录；修改考勤账号会清除原登录状态。', `<div class="form-grid">${field('company', '公司标识', config.company)}${field('username', '考勤用户名', config.username)}${field('password', '考勤密码', '', { type: 'password', placeholder: config.hasPassword ? '已保存，留空保持原密码' : '请输入考勤密码', hint: '加密保存，页面不会回显。' })}${field('openId', 'OpenID', config.openId)}${field('source', '登录来源 source', config.source, { type: 'number', min: 0, max: 100, step: 1 })}${field('apiBaseUrl', '考勤接口根地址', config.apiBaseUrl, { type: 'url', hint: '登录与打卡使用同一个 HTTPS 域名。' })}</div><label class="hint"><input type="checkbox" name="clearPassword"> 删除已保存的考勤密码</label>`)}
      ${section('03', '每日时间计划', '每天在时间段内随机选择一个分钟。上午、下午任务各执行一次。', `<div class="form-grid">${field('amStart', '上午开始', config.amStart, { type: 'time', required: true })}${field('amEnd', '上午结束', config.amEnd, { type: 'time', required: true })}${field('pmStart', '下午开始', config.pmStart, { type: 'time', required: true })}${field('pmEnd', '下午结束', config.pmEnd, { type: 'time', required: true })}${field('freshDate', '每日刷新时间', config.freshDate, { type: 'time', required: true, hint: '需早于或等于上午开始时间。' })}${field('timezone', '计划时区', config.timezone, { required: true, hint: '例如 Asia/Shanghai、Asia/Tokyo。' })}</div>`)}
      ${section('04', '工作日规则', '可识别调休，也可以为指定日期直接覆盖工作日状态。', `<div class="form-grid">${select('workdayMode', '工作日判断', config.workdayMode, [['weekdays', '周一至周五'], ['holiday', '中国节假日接口（含调休）']])}${select('holidayFallback', '节假日接口失败时', config.holidayFallback, [['skip', '跳过当天自动任务'], ['weekdays', '回退为周一至周五']])}${field('holidayUrl', '节假日接口地址', config.holidayUrl, { type: 'url', span: true, hint: '兼容 data.list[0].workday，系统自动附加 date=yyyyMMdd。' })}<label class="field span-2"><span>指定日期覆盖（JSON）</span><textarea name="workdayOverrides" spellcheck="false" placeholder='{"2026-10-01":0,"2026-10-10":1}'>${escape(JSON.stringify(config.workdayOverrides, null, 2))}</textarea><small>0 = 休息日，1 = 工作日。日期覆盖优先于其他规则。</small></label></div>`)}
      ${section('05', '打卡位置', '按原项目规则，从地点列表中随机选择地点，并可对坐标添加正向偏移。', `<div class="form-grid">${field('longitude', '经度', config.longitude, { type: 'number', min: -180, max: 180, step: 'any', required: true })}${field('latitude', '纬度', config.latitude, { type: 'number', min: -90, max: 90, step: 'any', required: true })}${field('coordinateJitter', '最大随机偏移（度）', config.coordinateJitter, { type: 'number', min: 0, max: 0.001, step: 'any', hint: '设置为 0 时使用固定坐标。', span: true })}<label class="field span-2"><span>打卡地点</span><textarea name="sites" required rows="5">${escape(config.sites.join('\n'))}</textarea><small>每行一个地点，最多 50 个。</small></label></div>`)}
      <div class="form-error" id="settings-error" role="alert"></div><div class="save-bar"><span>修改会重新生成今日计划。</span><button class="button primary" type="submit">${icon('check')}保存配置</button></div></form><aside class="settings-aside"><section class="card aside-card"><h3>准备好了吗？</h3><p>先保存配置，再验证考勤登录。模拟打卡可以随时测试，不会向考勤系统提交请求。</p>${button('测试考勤登录', 'test-login', 'shield')}${button('模拟打卡', 'simulate', 'play')}</section><section class="card aside-card note-green"><h3>从旧项目迁移</h3><p>导入原项目的 datas.json，自动转换账号与时间配置。导入后仍保持任务关闭、模拟模式开启。</p>${button('导入 datas.json', 'import', 'logs')}<input type="file" id="import-file" accept=".json,application/json" hidden><p class="hint">原项目晚于上午打卡的刷新时间，会自动调整为 00:05。</p></section><section class="card aside-card"><h3>关于每日计划</h3><p>每 15 秒检查一次。允许在计划分钟及下一分钟执行；离线期间错过的任务不会自动补交。修改配置不会重复已执行的定时任务。</p></section></aside></div>`;
}
async function renderPage({ quiet = false } = {}) {
  if (!state.user) return;
  const page = state.page;
  const renderId = ++state.renderId;
  document.querySelectorAll('[data-page]').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  document.querySelector('#breadcrumb').textContent = pages[page]?.[1] || '工作概览';
  const content = document.querySelector('#content');
  if (!quiet) content.innerHTML = '<div class="loading">正在加载…</div>';
  try {
    let markup;
    if (page === 'dashboard') {
      const [config, data] = await Promise.all([api('/settings'), api('/dashboard')]);
      state.settings = config;
      document.querySelector('#top-date').textContent = data.clock.day;
      markup = dashboard(data);
    } else if (page === 'settings') {
      state.settings = await api('/settings');
      markup = settingsView(state.settings);
    } else if (page === 'attendance') {
      const config = await api('/settings');
      if (renderId !== state.renderId || !state.user) return;
      state.settings = config;
      state.reportMonth ||= attendanceMonth();
      if (!config.username || !config.company || !config.openId || !config.hasPassword) {
        markup = attendanceView();
      } else {
        try {
          const query = new URLSearchParams({ month: state.reportMonth, page: state.reportPage, summaryPage: state.summaryPage });
          const data = await api(`/attendance/records?${query}`);
          markup = attendanceView(data);
        } catch (error) { markup = attendanceView(null, error.message); }
      }
    } else if (page === 'quota') {
      const config = await api('/settings');
      if (renderId !== state.renderId || !state.user) return;
      state.settings = config;
      if (!state.settings.username || !state.settings.company || !state.settings.openId || !state.settings.hasPassword) {
        markup = quotaView();
      } else {
        try { markup = quotaView(await api('/attendance/quota')); }
        catch (error) { markup = quotaView(null, error.message); }
      }
    } else if (page === 'runs') {
      const data = await api(`/runs?page=${state.runsPage}`);
      markup = heading('执行记录', '查看每次模拟与真实打卡的结果。', button('刷新记录', 'refresh', 'refresh'))
        + `<section class="card">${runsTable(data.items)}<div class="pagination"><span>共 ${data.total} 条 · 第 ${data.page} 页</span><div class="actions"><button class="button secondary" data-action="prev-page" ${data.page <= 1 ? 'disabled' : ''}>上一页</button><button class="button secondary" data-action="next-page" ${data.page * 20 >= data.total ? 'disabled' : ''}>下一页</button></div></div></section>`;
    } else if (page === 'logs') {
      const data = await api('/logs');
      markup = heading('运行日志', '最近 100 条事件，记录计划更新、账号操作和任务状态。', button('刷新日志', 'refresh', 'refresh'))
        + `<section class="card">${data.items.length ? `<div class="log-list">${data.items.map(log => `<div class="log-row"><time>${dateFormat(log.created_at)}</time><div>${badge({ info: '信息', warn: '注意', error: '错误' }[log.level], { info: 'gray', warn: 'warn', error: 'error' }[log.level])}</div><p>${escape(log.message)}</p></div>`).join('')}</div>` : empty('暂无运行日志')}</section>`;
    } else if (page === 'users' && state.user.role === 'admin') {
      const data = await api('/users');
      markup = heading('用户管理', '每个成员拥有独立的考勤账号、配置和执行记录。')
        + `<div class="user-layout"><section class="card"><div class="card-head"><h2>工作空间成员</h2><span>${data.items.length} 位成员</span></div><div class="table-wrap"><table><thead><tr><th>成员</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>${data.items.map(user => `<tr><td>${escape(user.displayName)}<br><span class="hint">${escape(user.username)}</span></td><td>${user.role === 'admin' ? '管理员' : '成员'}</td><td>${badge(user.disabled ? '已停用' : '正常', user.disabled ? 'gray' : '')}</td><td>${user.id === state.user.id ? '<span class="hint">当前账号</span>' : `<button class="button ghost" data-action="toggle-user" data-id="${user.id}" data-disabled="${user.disabled}">${user.disabled ? '启用' : '停用'}</button>`}</td></tr>`).join('')}</tbody></table></div></section><section class="card section-card"><div class="section-title"><span class="section-number">+</span><div><h2>添加成员</h2><p>创建后，成员可以独立登录并配置考勤。</p></div></div><form id="user-form">${field('displayName', '显示名称', '', { placeholder: '成员名称' })}${field('username', '登录用户名', '', { required: true })}${field('password', '初始登录密码', '', { type: 'password', required: true, hint: '10～128 位字符' })}${select('role', '用户角色', 'user', [['user', '普通成员'], ['admin', '管理员']])}<div class="form-error" id="user-error" role="alert"></div><button class="button primary" type="submit">创建成员</button></form></section></div>`;
    } else if (page === 'account') {
      markup = heading('账号安全', '管理控制台的登录密码。考勤账号密码请在个人配置中修改。')
        + `<section class="card account-card"><form id="password-form">${field('currentPassword', '当前登录密码', '', { type: 'password', required: true })}${field('newPassword', '新登录密码', '', { type: 'password', required: true, hint: '10～128 位字符。修改后，其他已登录设备将退出。' })}${field('confirmPassword', '确认新密码', '', { type: 'password', required: true })}<div class="form-error" id="password-error" role="alert"></div><button class="button primary" type="submit">更新密码</button></form></section>`;
    } else { state.page = 'dashboard'; return renderPage(); }
    if (renderId !== state.renderId || !state.user) return;
    content.innerHTML = markup;
    attachForms();
  } catch (error) {
    if (renderId === state.renderId && state.user) {
      if (!quiet) content.innerHTML = empty(escape(error.message)) + button('重新加载', 'refresh', 'refresh');
      toast(error.message, true);
    }
  }
}
function attachForms() {
  document.querySelector('#report-form')?.addEventListener('submit', event => {
    event.preventDefault();
    state.reportMonth = new FormData(event.target).get('month');
    state.reportPage = 1;
    state.summaryPage = 1;
    void renderPage();
  });
  const settingsForm = document.querySelector('#settings-form');
  settingsForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(settingsForm));
    try {
      for (const key of ['enabled', 'dryRun', 'clearPassword']) data[key] = settingsForm.elements[key].checked;
      for (const key of ['source', 'longitude', 'latitude', 'coordinateJitter']) data[key] = Number(data[key]);
      try { data.workdayOverrides = JSON.parse(data.workdayOverrides || '{}'); }
      catch { throw new Error('日期覆盖不是有效的 JSON'); }
      data.sites = data.sites.split('\n').map(s => s.trim()).filter(Boolean);
      await submitForm(settingsForm, '#settings-error', async () => {
        state.settings = await api('/settings', { method: 'PUT', body: data });
        toast('配置已保存');
        await renderPage();
      });
    } catch (error) { document.querySelector('#settings-error').textContent = error.message; }
  });
  const userForm = document.querySelector('#user-form');
  userForm?.addEventListener('submit', event => {
    event.preventDefault();
    void submitForm(userForm, '#user-error', async () => {
      await api('/users', { method: 'POST', body: Object.fromEntries(new FormData(userForm)) });
      toast('成员已创建');
      await renderPage();
    });
  });
  const passwordForm = document.querySelector('#password-form');
  passwordForm?.addEventListener('submit', event => {
    event.preventDefault();
    void submitForm(passwordForm, '#password-error', async () => {
      const data = Object.fromEntries(new FormData(passwordForm));
      if (data.newPassword !== data.confirmPassword) throw new Error('两次新密码不一致');
      const result = await api('/auth/password', { method: 'POST', body: data });
      state.csrf = result.csrf;
      toast('登录密码已更新，其他设备的旧会话已失效');
      passwordForm.reset();
    });
  });
  document.querySelector('#import-file')?.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 65536) throw new Error('文件不能超过 64KB');
      let input;
      try { input = JSON.parse(await file.text()); } catch { throw new Error('文件不是有效的 JSON'); }
      state.settings = await api('/settings/import', { method: 'POST', body: input });
      toast('已导入，定时任务关闭且模拟模式开启');
      await renderPage();
    } catch (error) { toast(error.message, true); event.target.value = ''; }
  });
}
async function submitForm(form, errorSelector, fn) {
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  const errorElement = document.querySelector(errorSelector);
  errorElement.textContent = '';
  try { await fn(); }
  catch (error) { if (errorElement.isConnected) errorElement.textContent = error.message; else toast(error.message, true); }
  finally { submit.disabled = false; }
}
async function confirmRealRun() {
  const dialog = document.querySelector('#confirm-dialog');
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}
async function onClick(event) {
  const element = event.target.closest('[data-action]');
  if (!element || element.disabled) return;
  const action = element.dataset.action;
  element.disabled = true;
  try {
    if (action === 'logout') {
      await api('/auth/logout', { method: 'POST' });
      state.user = null; state.csrf = null; state.settings = null;
      state.reportMonth = ''; state.reportPage = 1; state.summaryPage = 1;
      clearInterval(refreshTimer);
      root.removeEventListener('click', onClick);
      showAuth(true);
    } else if (action === 'settings') {
      location.hash = 'settings';
    } else if (action === 'refresh') {
      await renderPage();
    } else if (action === 'simulate' || action === 'real-run') {
      if (action === 'real-run' && !await confirmRealRun()) return;
      const result = await api('/attendance/run', { method: 'POST', body: { dryRun: action === 'simulate' } });
      toast(result.message, !['simulated', 'success'].includes(result.status));
      if (state.page === 'dashboard' || state.page === 'runs') await renderPage();
    } else if (action === 'test-login') {
      const result = await api('/attendance/test-login', { method: 'POST' });
      toast(`${result.employeeName}：${result.message}`);
    } else if (action === 'import') {
      document.querySelector('#import-file').click();
    } else if (action === 'prev-page' || action === 'next-page') {
      state.runsPage += action === 'prev-page' ? -1 : 1;
      await renderPage();
    } else if (['report-prev', 'report-next', 'summary-prev', 'summary-next'].includes(action)) {
      const key = action.startsWith('report-') ? 'reportPage' : 'summaryPage';
      state[key] = Math.max(1, state[key] + (action.endsWith('prev') ? -1 : 1));
      await renderPage();
    } else if (action === 'toggle-user') {
      await api(`/users/${element.dataset.id}`, { method: 'PATCH', body: { disabled: element.dataset.disabled !== 'true' } });
      toast('成员状态已更新');
      await renderPage();
    }
  } catch (error) { toast(error.message, true); }
  finally { element.disabled = false; }
}
async function enterApp() {
  state.settings = await api('/settings');
  shell();
  state.page = location.hash.slice(1) || 'dashboard';
  await renderPage();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (state.page === 'dashboard' && state.user && document.visibilityState === 'visible' && !document.querySelector('#confirm-dialog').open) void renderPage({ quiet: true });
  }, 30000);
}
window.addEventListener('hashchange', () => {
  if (!state.user) return;
  state.page = location.hash.slice(1) || 'dashboard';
  void renderPage();
});
try {
  const result = await api('/auth/status');
  state.user = result.user; state.csrf = result.csrf;
  if (state.user) await enterApp();
  else showAuth(result.initialized);
} catch {
  root.innerHTML = `<div class="boot">无法连接服务<span>请检查服务是否启动，再刷新页面。</span></div>`;
}
