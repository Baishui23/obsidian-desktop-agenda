(() => {
  'use strict';
  const bridge = window.desktopAgenda;
  const $ = id => document.getElementById(id);
  const subscriptions = [];
  const pending = new Set();
  let model = null;
  let view = 'today';
  let draft = null;
  let loadTimeout;
  let desktopError = '';

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, className, action) {
    const node = element('button', className, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  function status(message, error = false) {
    $('task-status').textContent = message;
    $('task-status').classList.toggle('error', error);
  }

  function plusDay(value) {
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  }

  function tick() {
    const now = new Date();
    const time = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(now);
    $('clock').replaceChildren(document.createTextNode(time), element('span', '', '今天'));
    $('date').textContent = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long'
    }).format(now).replace('日', '日 · ');
  }

  function submit(task, callback) {
    if (pending.has(task.id)) return;
    pending.add(task.id);
    status('正在保存到原笔记…');
    render();
    callback();
  }

  function historyDetails(task) {
    const details = element('details', 'defer-history');
    details.append(element('summary', '', `改期记录 · ${task.deferCount} 次`));
    const list = element('ol');
    for (const record of task.history) {
      if (!record || typeof record !== 'object') continue;
      const when = new Date(record.at);
      const date = Number.isFinite(when.getTime()) ? when.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '时间未记录';
      let text = `${date}：计划 ${record.from || '未排期'} → ${record.to || '未记录'}`;
      if (record.dueFrom !== record.dueTo) text += `；截止 ${record.dueFrom || '未设'} → ${record.dueTo || '未设'}`;
      list.append(element('li', '', text));
    }
    details.append(list);
    return details;
  }

  function deferForm(task) {
    const form = element('form', 'defer-form');
    const dateLabel = element('label', 'defer-label', '新的计划日期');
    const date = element('input', 'defer-date');
    date.type = 'date';
    date.min = model.today;
    date.required = true;
    date.value = draft.date;
    date.addEventListener('input', () => { draft.date = date.value; });
    dateLabel.append(date);
    const quick = element('div', 'defer-quick');
    const setDate = value => { draft.date = value; date.value = value; };
    quick.append(button('今天', 'text-button', () => setDate(model.today)), button('明天', 'text-button', () => setDate(model.tomorrow)));
    const dueLabel = element('label', 'defer-due-label');
    const due = element('input');
    due.type = 'checkbox';
    due.checked = draft.changeDue;
    due.addEventListener('change', () => { draft.changeDue = due.checked; });
    dueLabel.append(due, document.createTextNode('截止日也改到这一天'));
    const hint = element('p', 'defer-hint', task.due ? `原截止：${task.due}。保留截止日时，超期提醒也会保留。` : '未设置截止日；默认只调整计划日期。');
    const actions = element('div', 'defer-actions');
    const save = element('button', 'text-button save-button', '保存改期');
    save.type = 'submit';
    actions.append(button('取消', 'text-button', () => { draft = null; render(); }), save);
    form.append(dateLabel, quick, dueLabel, hint, actions);
    for (const control of form.querySelectorAll('button,input')) control.disabled = pending.has(task.id);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!date.reportValidity()) return;
      const target = date.value;
      const changeDue = due.checked;
      submit(task, () => bridge.postponeTask(task.id, target, changeDue));
    });
    return form;
  }

  function taskCard(task) {
    const card = element('article', `task-card${task.overdue ? ' overdue' : ''}${task.done ? ' completed' : ''}`);
    const row = element('div', 'task-row');
    const time = element('span', 'time');
    time.append(element('strong', '', task.start || (task.date ? task.date.slice(5) : '待定')),
      element('small', '', task.end ? `至 ${task.end}` : task.date ? '全天' : '未排期'));
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.checked = task.done;
    checkbox.disabled = pending.has(task.id) || task.recurring;
    checkbox.setAttribute('aria-label', `${task.done ? '恢复未完成' : '标记完成'}：${task.title}`);
    checkbox.addEventListener('change', () => {
      const done = checkbox.checked;
      submit(task, () => bridge.completeTask(task.id, done));
    });
    const copy = element('span', 'task-copy');
    copy.append(element('strong', '', task.title));
    const meta = [];
    if (task.scheduled) meta.push(`计划 ${task.scheduled}`);
    else if (task.date && !task.due) meta.push(`日记 ${task.date}`);
    if (task.due) meta.push(`截止 ${task.due}`);
    copy.append(element('small', '', meta.join(' · ') || '尚未安排日期'));
    if (task.overdue) copy.append(element('span', 'overdue-badge', `${task.overdueDue ? '已逾期' : '计划滞后'} ${task.daysLate} 天`));
    if (task.recurring) copy.append(element('small', '', '循环任务请在 Tasks 中处理'));
    row.append(time, checkbox, copy);
    const tools = element('div', 'task-actions');
    const source = button(task.path.split('/').pop().replace(/\.md$/u, ''), 'source-button', () => bridge.openTask(task.id));
    source.title = `打开原文：${task.path}:${task.line + 1}`;
    tools.append(source);
    if (!task.done && !task.recurring) {
      const postpone = button(task.date && task.date > model.today ? '改期' : '延期', 'text-button postpone-button', () => {
        draft = draft?.id === task.id ? null : {
          id: task.id, date: plusDay(task.date && task.date > model.today ? task.date : model.today), changeDue: false
        };
        render();
      });
      postpone.disabled = pending.has(task.id);
      tools.append(postpone);
    }
    card.append(row, tools);
    if (task.deferCount) card.append(historyDetails(task));
    if (draft?.id === task.id) card.append(deferForm(task));
    return card;
  }

  function render() {
    if (!model) return;
    const todayTasks = model.tasks.filter(task => task.todayVisible);
    const visible = view === 'all' ? model.tasks.filter(task => !task.done) : todayTasks;
    if (draft && !model.tasks.some(task => task.id === draft.id)) draft = null;
    const unfinished = todayTasks.filter(task => !task.done);
    const focus = unfinished.find(task => task.primary) || unfinished[0];
    const overdue = model.tasks.filter(task => task.overdue).length;
    $('focus-title').textContent = focus?.title || '今天的安排已处理完';
    $('focus-description').textContent = focus ? [focus.start && `${focus.start} - ${focus.end}`, focus.due && `截止 ${focus.due}`].filter(Boolean).join(' · ') || '按计划推进，完成后勾选。' : '可以查看后续计划，或在笔记中添加任务。';
    $('focus-tag').textContent = focus?.overdue ? '逾期待处理' : focus?.primary ? '首要任务' : '今日安排';
    $('focus-tag').classList.toggle('urgent', !!focus?.overdue);
    $('task-total').textContent = overdue ? `${overdue} 项待处理逾期` : `${unfinished.length} 项待完成`;
    $('progress').textContent = `${todayTasks.filter(task => task.done).length} / ${todayTasks.length} 已完成`;
    $('list-heading').textContent = view === 'all' ? '全部未完成' : '今日与遗留';
    $('view-today').classList.toggle('active', view === 'today');
    $('view-all').classList.toggle('active', view === 'all');
    $('view-today').setAttribute('aria-pressed', String(view === 'today'));
    $('view-all').setAttribute('aria-pressed', String(view === 'all'));
    $('task-list').replaceChildren(...visible.map(taskCard));
    $('empty-state').hidden = visible.length > 0;
    $('task-issues').hidden = model.issues.length === 0;
    $('issues-title').textContent = `${model.issues.length} 处输入需要调整`;
    $('issues-list').replaceChildren(...model.issues.map(issue => element('li', '', `${issue.path}:${issue.line} — ${issue.message}`)));
  }

  tick();
  const timer = setInterval(tick, 1000);
  if (!bridge?.onTasks) {
    status('请在 Obsidian 社区插件中重新启用 Desktop Agenda，以加载新版。', true);
    ['fit', 'desktop', 'close', 'opacity', 'view-today', 'view-all', 'refresh'].forEach(id => { $(id).disabled = true; });
    return;
  }
  $('fit').addEventListener('click', () => bridge.fitScreen());
  $('desktop').addEventListener('click', () => bridge.toggleDesktop());
  $('close').addEventListener('click', () => bridge.close());
  $('view-today').addEventListener('click', () => { view = 'today'; render(); });
  $('view-all').addEventListener('click', () => { view = 'all'; render(); });
  $('refresh').addEventListener('click', () => { status('正在重新读取任务…'); bridge.refreshTasks(); });
  $('opacity').addEventListener('input', event => {
    const value = Number(event.target.value);
    $('opacity-value').textContent = `${value}%`;
    $('opacity').setAttribute('aria-valuetext', `${value}%`);
    bridge.setOpacity(value / 100);
  });
  subscriptions.push(bridge.onState(state => {
    const editing = document.activeElement === $('opacity');
    const opacity = editing ? Number($('opacity').value) : Math.round(state.opacity * 100);
    if (!editing) $('opacity').value = String(opacity);
    $('opacity').setAttribute('aria-valuetext', `${opacity}%`);
    $('opacity-value').textContent = `${opacity}%`;
    const attached = !!state.desktopAttached;
    desktopError = state.desktopError || '';
    $('desktop').classList.toggle('selected', attached);
    $('desktop').setAttribute('aria-pressed', String(attached));
    $('desktop').title = state.mode === 'bottom' ? '前置编辑窗口' : '放回置底显示';
    $('mode-label').textContent = attached ? '置底显示' : '前置编辑';
    $('mode-dot').classList.toggle('off', !attached);
    $('fit').disabled = false;
    $('layout-hint').textContent = attached ? '软件窗口会盖住它 · 可切换前置编辑' : '拖动顶部移动 · 点桌面图标置底';
    if (desktopError) status(desktopError, true);
  }));
  subscriptions.push(bridge.onTasks(data => {
    clearTimeout(loadTimeout);
    const changed = !model || JSON.stringify(model) !== JSON.stringify(data);
    model = data;
    if (changed) render();
    if (!pending.size) status(desktopError || '已同步原笔记，逾期任务会标红。', !!desktopError);
  }));
  subscriptions.push(bridge.onTaskResult(result => {
    pending.delete(result.id);
    render();
    status(result.message);
  }));
  subscriptions.push(bridge.onError(error => {
    pending.delete(error.id);
    render();
    status(error.message || '操作失败，请刷新后重试', true);
  }));
  loadTimeout = setTimeout(() => {
    if (!model) status('尚未收到任务。请在社区插件关闭后重新启用 Desktop Agenda，再点刷新。', true);
  }, 5500);
  bridge.refreshTasks();
  window.addEventListener('beforeunload', () => {
    clearInterval(timer);
    clearTimeout(loadTimeout);
    subscriptions.forEach(unsubscribe => unsubscribe());
  });
})();
