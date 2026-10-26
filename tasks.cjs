'use strict';

const crypto = require('node:crypto');
const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([^\]])(\]\s+)(.+)$/u;
const HISTORY = /^\s*<!-- desktop-agenda:defer (\{.*\}) -->\s*$/u;

function todayISO(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addDays(value, count) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function dayDifference(before, after) {
  return Math.round((Date.parse(`${after}T00:00:00Z`) - Date.parse(`${before}T00:00:00Z`)) / 86400000);
}

function isTaskFile(filePath) {
  return filePath.endsWith('.md') && !/(^|\/)(?:90 模板|templates?|node_modules|\.[^/]+)(?:\/|$)/iu.test(filePath);
}

function extractDate(text, marker) {
  const matches = [...text.matchAll(new RegExp(`${marker}\\uFE0F?\\s*(\\d{4}-\\d{2}-\\d{2})`, 'gu'))];
  if (!text.includes(marker)) return null;
  if (matches.length !== 1 || !validDate(matches[0][1])) throw new Error(`${marker} 后需要唯一且有效的 YYYY-MM-DD 日期`);
  return matches[0][1];
}

function parseLine(raw, filePath, line) {
  const match = raw.match(TASK);
  if (!match) return null;
  const body = match[4].replace(/<!--.*?-->/gu, '');
  if (!/(?:^|\s)#task(?=\s|$)/u.test(body)) return null;
  if (![' ', 'x', 'X'].includes(match[2])) throw new Error('目前只支持 [ ] 和 [x]；自定义任务状态请在原笔记处理');
  const scheduled = extractDate(body, '⏳');
  const due = extractDate(body, '📅');
  const completed = extractDate(body, '✅');
  const fileDate = filePath.match(/(?:^|\/)(\d{4}-\d{2}-\d{2})(?:\.md|\s)/u)?.[1];
  const date = scheduled || due || (validDate(fileDate) ? fileDate : null);
  const timeMatch = body.match(/^(\d{2}:\d{2})\s*[-–—]\s*(\d{2}:\d{2})\s+/u);
  let start = null;
  let end = null;
  if (timeMatch) {
    [start, end] = [timeMatch[1], timeMatch[2]];
    if (![start, end].every(value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) || end <= start) {
      throw new Error('时间须为当天有效的 HH:mm - HH:mm，结束时间晚于开始时间');
    }
  } else if (/^\d{1,2}:\d{2}/u.test(body)) {
    throw new Error('时间范围请写成 HH:mm - HH:mm，例如 09:00 - 10:00');
  }
  const tags = [...body.matchAll(/(?:^|\s)#([^\s#]+)/gu)].map(item => item[1]);
  const title = body
    .replace(/^\d{2}:\d{2}\s*[-–—]\s*\d{2}:\d{2}\s+/u, '')
    .replace(/(?:⏳|📅|✅|➕|🛫|❌)\uFE0F?\s*\d{4}-\d{2}-\d{2}/gu, '')
    .replace(/(?:^|\s)#[^\s#]+/gu, ' ')
    .replace(/[🔺⏫🔼🔽⏬]/gu, '')
    .replace(/\s+\^[\w-]+\s*$/u, '')
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/gu, '$2')
    .replace(/\[\[([^\]]+)\]\]/gu, '$1')
    .replace(/\s+/gu, ' ').trim();
  if (!title) throw new Error('请填写任务内容');
  const id = crypto.createHash('sha256').update(`${filePath}\n${line}\n${raw}`).digest('hex').slice(0, 24);
  return {
    id, path: filePath, line, raw, title, scheduled, due, completed, date, start, end,
    done: match[2].toLowerCase() === 'x',
    priority: body.includes('⏫') ? 3 : body.includes('🔼') ? 2 : body.includes('🔽') ? 0 : 1,
    primary: tags.includes('首要'), tags, recurring: body.includes('🔁'), history: []
  };
}

function parseFile(content, filePath) {
  const tasks = [];
  const issues = [];
  const lines = content.split(/\r?\n/u);
  let frontmatter = /^\uFEFF?---\s*$/u.test(lines[0] || '');
  let fence = null;
  let comment = false;
  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line];
    if (frontmatter) {
      if (line > 0 && /^---\s*$/u.test(raw)) frontmatter = false;
      continue;
    }
    const marker = raw.match(/^\s{0,3}(`{3,}|~{3,})/u);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    if (comment) { if (raw.includes('-->')) comment = false; continue; }
    if (raw.trimStart().startsWith('<!--')) {
      if (!raw.includes('-->')) comment = true;
      continue;
    }
    try {
      const task = parseLine(raw, filePath, line);
      if (!task) continue;
      for (let next = line + 1; next < lines.length; next++) {
        const history = lines[next].match(HISTORY);
        if (!history) break;
        try { task.history.push(JSON.parse(history[1])); } catch { /* Keep a damaged comment untouched. */ }
      }
      tasks.push(task);
    } catch (error) {
      issues.push({ path: filePath, line: line + 1, message: error.message });
    }
  }
  return { tasks, issues };
}

function viewTask(task, today) {
  const overdueDue = !task.done && !!task.due && task.due < today;
  const overduePlan = !task.done && !!task.date && task.date < today;
  const overdue = overdueDue || overduePlan;
  const daysLate = overdue ? dayDifference(overdueDue ? task.due : task.date, today) : 0;
  const todayVisible = task.done ? (task.date === today || task.completed === today) : !task.date || task.date <= today || (!!task.due && task.due <= today);
  const { raw, ...safe } = task;
  return { ...safe, overdue, overdueDue, overduePlan, daysLate, todayVisible, deferCount: task.history.length };
}

function updateDate(body, marker, value) {
  const pattern = new RegExp(`${marker}\\uFE0F?\\s*\\d{4}-\\d{2}-\\d{2}`, 'gu');
  if (body.includes(marker)) return body.replace(pattern, `${marker} ${value}`);
  // Keep an existing Obsidian block ID as the last token.
  const block = body.match(/\s+(\^[\w-]+)\s*$/u);
  return block ? `${body.slice(0, block.index).trimEnd()} ${marker} ${value} ${block[1]}` : `${body.trimEnd()} ${marker} ${value}`;
}

function mutateTask(content, reference, action, today = todayISO()) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/u);
  const candidates = lines.map((line, i) => line === reference.raw ? i : -1).filter(i => i >= 0);
  if (candidates.length !== 1) throw new Error('原任务已改变或存在重复行，请刷新；重复任务需先在原文区分内容');
  const [index] = candidates;
  // A task moved into a code fence or comment must never be edited as a live task.
  const current = parseFile(content, reference.path).tasks.find(task => task.line === index && task.raw === reference.raw);
  if (!current) throw new Error('原位置已不是有效任务，请刷新');
  if (current.recurring) throw new Error('循环任务请使用 Tasks 插件处理，以保留循环规则');
  const match = lines[index].match(TASK);
  let body = match[4];
  if (action.type === 'complete') {
    if (typeof action.done !== 'boolean') throw new Error('任务状态无效');
    if (current.done === action.done) return content;
    body = body.replace(/\s*✅\uFE0F?\s*\d{4}-\d{2}-\d{2}/gu, '');
    if (action.done) body = updateDate(body, '✅', today);
    lines[index] = `${match[1]}${action.done ? 'x' : ' '}${match[3]}${body}`;
  } else if (action.type === 'postpone') {
    if (current.done) throw new Error('已完成任务无需延期');
    if (!validDate(action.date) || action.date < today) throw new Error('新计划日期须为今天或以后，格式 YYYY-MM-DD');
    if (typeof action.changeDue !== 'boolean') throw new Error('截止日选项无效');
    if (current.scheduled === action.date && (!action.changeDue || current.due === action.date)) return content;
    body = updateDate(body, '⏳', action.date);
    if (action.changeDue) body = updateDate(body, '📅', action.date);
    lines[index] = `${match[1]} ${match[3]}${body}`;
    const history = {
      at: new Date().toISOString(), from: current.date, to: action.date,
      dueFrom: current.due, dueTo: action.changeDue ? action.date : current.due
    };
    const indent = lines[index].match(/^\s*/u)[0];
    lines.splice(index + 1, 0, `${indent}  <!-- desktop-agenda:defer ${JSON.stringify(history)} -->`);
  } else {
    throw new Error('不支持的任务操作');
  }
  return lines.join(eol);
}

module.exports = { todayISO, validDate, addDays, isTaskFile, parseFile, viewTask, mutateTask };
