// ── Supabase config ──────────────────────────────────────────────────────────
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://mnqyhrihmopwqjipsldj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_cgZHeK5PSfjqQuaTS-MWmQ_3DufPATJ';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── State ────────────────────────────────────────────────────────────────────
let tasks  = [];
let blocks = [];
let events = [];   // real Google Calendar events
let isOffline    = false;
let weekOffset   = 0;
let monthOffset  = 0;
let currentView  = 'week';
let selectedDate = null;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const greetingEl    = document.getElementById('greeting');
const dateLineEl    = document.getElementById('date-line');
const weekBadgeEl   = document.getElementById('week-badge');
const periodLabel   = document.getElementById('period-label');
const prevPeriodBtn = document.getElementById('prev-period');
const nextPeriodBtn = document.getElementById('next-period');
const weekGridWrap  = document.getElementById('week-grid-wrap');
const monthGridWrap = document.getElementById('month-grid-wrap');
const monthDayHdrs  = document.getElementById('month-day-headers');
const monthGrid     = document.getElementById('month-grid');
const meetingBadge  = document.getElementById('meeting-badge');
const taskBadge     = document.getElementById('task-badge');
const alertBar      = document.getElementById('alert-bar');
const offlineBanner = document.getElementById('offline-banner');
const scheduleList  = document.getElementById('schedule-list');
const taskList      = document.getElementById('task-list');
const weekGrid      = document.getElementById('week-grid');
const taskInput     = document.getElementById('task-input');
const addBtn        = document.getElementById('add-btn');

// ── Date helpers ─────────────────────────────────────────────────────────────
const now      = new Date();
const todayStr = now.toISOString().slice(0, 10);
selectedDate   = new Date(now);

function selectedDateStr() {
  return selectedDate.toISOString().slice(0, 10);
}
function isSelectedDate(d) {
  return d.toDateString() === selectedDate.toDateString();
}
function getWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}
function getHourMinute(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':');
  const hour = parseInt(h, 10);
  return `${hour % 12 || 12}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
}
function formatEventTime(startAt) {
  const d = new Date(startAt);
  const h = d.getHours(), m = d.getMinutes();
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
function monToFriDates(offset = 0) {
  const days = [];
  const d = new Date(now);
  const diff = d.getDay() === 0 ? -6 : 1 - d.getDay();
  d.setDate(d.getDate() + diff + offset * 7);
  for (let i = 0; i < 5; i++) { days.push(new Date(d)); d.setDate(d.getDate() + 1); }
  return days;
}

// ── Color helpers ─────────────────────────────────────────────────────────────
const COLOR_MAP = {
  red:    'tomato',
  blue:   '#4B8CF7',
  purple: '#534AB7',
  green:  '#1D9E75',
  gray:   '#888780',
};
function resolveColor(block) {
  if (block.color && block.color.startsWith('#')) return block.color;
  return COLOR_MAP[block.color] || '#888780';
}

const CALENDAR_COLORS = {
  'Rincon':      '#534AB7',
  'Coastal Inn': '#0EA5E9',
  'Holiday':     '#F59E0B',
};
function calendarColor(name) {
  return CALENDAR_COLORS[name] || '#888780';
}

// ── Events for a given date ───────────────────────────────────────────────────
function getEventsForDate(dateStr) {
  return events.filter(e => {
    if (e.status === 'cancelled') return false;
    if (e.all_day) {
      // stored as midnight UTC — compare UTC date string
      return e.start_at.slice(0, 10) === dateStr;
    }
    // timed event — compare in local time
    return new Date(e.start_at).toLocaleDateString('en-CA') === dateStr;
  });
}

// ── Render header ─────────────────────────────────────────────────────────────
function renderHeader() {
  const h = now.getHours();
  const isToday = selectedDate.toDateString() === now.toDateString();
  const greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  greetingEl.textContent = isToday ? `${greeting}, Peter` : 'Peter';

  const dayNames   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const label = isToday ? 'Today' : dayNames[selectedDate.getDay()];
  dateLineEl.textContent = `${label} · ${monthNames[selectedDate.getMonth()]} ${selectedDate.getDate()}, ${selectedDate.getFullYear()}`;
  weekBadgeEl.textContent = `W${getWeekNumber(selectedDate)}`;
}

// ── Render schedule ───────────────────────────────────────────────────────────
function renderSchedule() {
  const dow     = selectedDate.getDay();
  const dateStr = selectedDateStr();

  // Recurring structure blocks (gym, deep work, etc.)
  const todayBlocks = blocks
    .filter(b => b.is_active && b.day_of_week === dow)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));

  // Real calendar events for this date
  const todayEvents = getEventsForDate(dateStr)
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at));

  // Update header badges
  const realMeetingCount = todayEvents.filter(e => e.calendar_name !== 'Holiday').length;
  meetingBadge.textContent = `${realMeetingCount} ${realMeetingCount === 1 ? 'meeting' : 'meetings'}`;

  if (todayBlocks.length === 0 && todayEvents.length === 0) {
    scheduleList.innerHTML = '<div class="empty-state">Nothing on the schedule today</div>';
    return;
  }

  // Merge blocks + events, sorted by start time
  const blockItems = todayBlocks.map(b => ({
    sortKey:   b.start_time,
    timeLabel: getHourMinute(b.start_time),
    color:     resolveColor(b),
    title:     b.title,
    location:  null,
    badge:     null,
    isBlock:   true,
  }));

  const eventItems = todayEvents.map(e => ({
    sortKey:   e.all_day ? '00:00' : new Date(e.start_at).toTimeString().slice(0, 5),
    timeLabel: e.all_day ? 'All day' : formatEventTime(e.start_at),
    color:     calendarColor(e.calendar_name),
    title:     e.title,
    location:  e.location || null,
    badge:     e.calendar_name !== 'Rincon' ? e.calendar_name : null,
    isBlock:   false,
  }));

  const allItems = [...blockItems, ...eventItems]
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  scheduleList.innerHTML = allItems.map(item => `
    <div class="schedule-item">
      <div class="schedule-pip" style="background:${item.color}"></div>
      <div class="schedule-time">${item.timeLabel}</div>
      <div class="schedule-body">
        <div class="schedule-title">${escHtml(item.title)}</div>
        ${item.location ? `<div class="schedule-location">${escHtml(item.location)}</div>` : ''}
      </div>
      ${item.badge ? `<div class="schedule-cal-badge">${escHtml(item.badge)}</div>` : ''}
    </div>
  `).join('');
}

// ── Render tasks ──────────────────────────────────────────────────────────────
const PRIORITY_CLASS = {
  strategic:    'priority-strategic',
  decision:     'priority-decision',
  relationship: 'priority-relationship',
  admin:        'priority-admin',
};

function renderTasks() {
  const pending = tasks.filter(t => t.status !== 'done');
  taskBadge.textContent = `${pending.length} ${pending.length === 1 ? 'task' : 'tasks'}`;

  if (tasks.length === 0) {
    taskList.innerHTML = '<div class="empty-state">No tasks for today — nice work</div>';
    return;
  }

  const sorted = [...tasks].sort((a, b) => {
    if (a.status === 'done' && b.status !== 'done') return 1;
    if (a.status !== 'done' && b.status === 'done') return -1;
    return 0;
  });

  taskList.innerHTML = sorted.map(t => `
    <div class="task-item ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}" onclick="toggleTask('${t.id}')">
      <div class="task-check">
        <span class="task-check-mark">✓</span>
      </div>
      <div class="task-body">
        <div class="task-title">${escHtml(t.title)}</div>
        ${t.due_time ? `<div class="task-meta">${getHourMinute(t.due_time)}</div>` : ''}
      </div>
      <div class="priority-dot ${PRIORITY_CLASS[t.priority] || 'priority-admin'}"></div>
    </div>
  `).join('');
}

// ── Select a day ─────────────────────────────────────────────────────────────
window.selectDay = async function(dateStr) {
  selectedDate = new Date(dateStr + 'T12:00:00');
  renderHeader();
  renderSchedule();  // uses in-memory events — instant

  if (!isOffline) {
    const { data, error } = await sb
      .from('tasks')
      .select('*')
      .eq('due_date', dateStr)
      .order('created_at', { ascending: false });
    if (!error) tasks = data || [];
  }
  renderTasks();

  if (currentView === 'week') renderWeek();
  else renderMonth();

  document.querySelector('main').scrollTo({ top: 0, behavior: 'smooth' });
};

// ── View toggle ───────────────────────────────────────────────────────────────
window.setView = function(view) {
  currentView = view;
  document.getElementById('view-week').classList.toggle('active', view === 'week');
  document.getElementById('view-month').classList.toggle('active', view === 'month');
  weekGridWrap.style.display  = view === 'week'  ? '' : 'none';
  monthGridWrap.style.display = view === 'month' ? '' : 'none';
  view === 'week' ? renderWeek() : renderMonth();
};

// ── Week view ─────────────────────────────────────────────────────────────────
function renderWeek() {
  const weekDays  = monToFriDates(weekOffset);
  const dayLabels = ['Mon','Tue','Wed','Thu','Fri'];
  const dowForCol = [1, 2, 3, 4, 5];
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const first = weekDays[0], last = weekDays[4];
  periodLabel.textContent = weekOffset === 0 ? 'This week'
    : weekOffset === 1 ? 'Next week'
    : weekOffset === -1 ? 'Last week'
    : `${monthNames[first.getMonth()]} ${first.getDate()} – ${monthNames[last.getMonth()]} ${last.getDate()}`;

  prevPeriodBtn.style.opacity = weekOffset <= -1 ? '0.3' : '1';

  weekGrid.innerHTML = weekDays.map((d, i) => {
    const dow        = dowForCol[i];
    const isToday    = d.toDateString() === now.toDateString();
    const isSelected = isSelectedDate(d);
    const ds         = d.toISOString().slice(0, 10);

    // Block pips (recurring structure)
    const dayBlocks = blocks.filter(b => b.is_active && b.day_of_week === dow);
    const blockPips = dayBlocks.map(b =>
      `<div class="pip" style="background:${resolveColor(b)}"></div>`).join('');

    // Event pips (real meetings — skip holidays to avoid clutter)
    const dayEvents = getEventsForDate(ds).filter(e => e.calendar_name !== 'Holiday');
    const eventPips = dayEvents.map(e =>
      `<div class="pip" style="background:${calendarColor(e.calendar_name)}"></div>`).join('');

    return `
      <div class="week-day ${isToday ? 'today' : ''} ${isSelected && !isToday ? 'selected' : ''}"
           onclick="selectDay('${ds}')" style="cursor:pointer;">
        <div class="week-day-label">${dayLabels[i]}</div>
        <div class="week-day-num">${d.getDate()}</div>
        <div class="week-pips">${blockPips}${eventPips}</div>
      </div>`;
  }).join('');
}

// ── Month view ────────────────────────────────────────────────────────────────
function renderMonth() {
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const target = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const year = target.getFullYear(), month = target.getMonth();

  periodLabel.textContent = `${monthNames[month]} ${year}`;
  prevPeriodBtn.style.opacity = monthOffset <= -1 ? '0.3' : '1';

  const dayHdrs = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  monthDayHdrs.innerHTML = dayHdrs.map(d => `<div class="month-day-hdr">${d}</div>`).join('');

  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev  = new Date(year, month, 0).getDate();

  let cells = '';

  for (let i = firstDay - 1; i >= 0; i--) {
    cells += `<div class="month-cell other-month"><div class="month-cell-num">${daysInPrev - i}</div></div>`;
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const date    = new Date(year, month, d);
    const dow     = date.getDay();
    const isToday = date.toDateString() === now.toDateString();
    const isSel   = isSelectedDate(date);
    const ds      = date.toISOString().slice(0, 10);

    const dayBlocks = (dow >= 1 && dow <= 5)
      ? blocks.filter(b => b.is_active && b.day_of_week === dow)
      : [];
    const blockPips = dayBlocks.map(b =>
      `<div class="month-pip" style="background:${resolveColor(b)}"></div>`).join('');

    const dayEvents = getEventsForDate(ds).filter(e => e.calendar_name !== 'Holiday');
    const eventPips = dayEvents.map(e =>
      `<div class="month-pip" style="background:${calendarColor(e.calendar_name)}"></div>`).join('');

    cells += `
      <div class="month-cell ${isToday ? 'today' : ''} ${isSel && !isToday ? 'selected' : ''}"
           onclick="selectDay('${ds}')" style="cursor:pointer;">
        <div class="month-cell-num">${d}</div>
        <div class="month-pips">${blockPips}${eventPips}</div>
      </div>`;
  }

  const total    = firstDay + daysInMonth;
  const trailing = total % 7 === 0 ? 0 : 7 - (total % 7);
  for (let i = 1; i <= trailing; i++) {
    cells += `<div class="month-cell other-month"><div class="month-cell-num">${i}</div></div>`;
  }

  monthGrid.innerHTML = cells;
}

// ── Period navigation ─────────────────────────────────────────────────────────
prevPeriodBtn.addEventListener('click', () => {
  if (currentView === 'week') {
    weekOffset--; renderWeek();
  } else {
    monthOffset--; renderMonth();
  }
});
nextPeriodBtn.addEventListener('click', () => {
  if (currentView === 'week') { weekOffset++; renderWeek(); }
  else { monthOffset++; renderMonth(); }
});

// ── Toggle task ───────────────────────────────────────────────────────────────
window.toggleTask = async function(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  const newStatus = task.status === 'done' ? 'pending' : 'done';
  task.status = newStatus;
  renderTasks();
  if (!isOffline) {
    const { error } = await sb.from('tasks').update({ status: newStatus }).eq('id', id);
    if (error) {
      task.status = newStatus === 'done' ? 'pending' : 'done';
      renderTasks();
    }
  }
};

// ── Add task ──────────────────────────────────────────────────────────────────
async function addTask(title) {
  title = title.trim();
  if (!title) return;

  const newTask = {
    id:       crypto.randomUUID(),
    title,
    due_date: selectedDateStr(),
    status:   'pending',
    priority: 'admin',
    source:   'manual',
  };

  tasks.unshift(newTask);
  taskInput.value = '';
  addBtn.disabled = true;
  renderTasks();

  if (!isOffline) {
    const { data, error } = await sb.from('tasks').insert({
      title:    newTask.title,
      due_date: newTask.due_date,
      status:   'pending',
      priority: 'admin',
      source:   'manual',
    }).select().single();

    if (error) {
      tasks = tasks.filter(t => t.id !== newTask.id);
      renderTasks();
    } else if (data) {
      const idx = tasks.findIndex(t => t.id === newTask.id);
      if (idx !== -1) tasks[idx] = data;
    }
  }
}

addBtn.addEventListener('click', () => addTask(taskInput.value));
taskInput.addEventListener('input', () => {
  addBtn.disabled = taskInput.value.trim().length === 0;
});
taskInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') addTask(taskInput.value);
});

// ── Alerts ────────────────────────────────────────────────────────────────────
function checkAlerts() {
  const dow = now.getDay();
  const todayEvents = getEventsForDate(todayStr).filter(e => e.calendar_name !== 'Holiday');

  const alerts = [];
  if (dow === 1) alerts.push('Monday — team meetings day.');
  if (dow === 4) alerts.push('Thursday — partnership slots today.');
  if (todayEvents.length > 5) alerts.push(`Heads up — you have ${todayEvents.length} meetings today.`);

  if (alerts.length) {
    alertBar.textContent = alerts.join(' ');
    alertBar.classList.add('visible');
  }
}

// ── Load all data ─────────────────────────────────────────────────────────────
async function loadData() {
  try {
    // Window: 30 days back → 90 days forward
    const rangeStart = new Date(now); rangeStart.setDate(rangeStart.getDate() - 30);
    const rangeEnd   = new Date(now); rangeEnd.setDate(rangeEnd.getDate() + 90);

    const [blockRes, taskRes, eventRes] = await Promise.all([
      sb.from('calendar_blocks').select('*').eq('is_active', true),
      sb.from('tasks').select('*').eq('due_date', todayStr).order('created_at', { ascending: false }),
      sb.from('calendar_events')
        .select('*')
        .gte('start_at', rangeStart.toISOString())
        .lte('start_at', rangeEnd.toISOString())
        .neq('status', 'cancelled')
        .order('start_at', { ascending: true }),
    ]);

    if (blockRes.error) throw blockRes.error;
    if (taskRes.error)  throw taskRes.error;
    // Event errors are non-fatal — table may not exist yet
    if (eventRes.error) console.warn('Events load failed:', eventRes.error.message);

    blocks = blockRes.data || [];
    tasks  = taskRes.data  || [];
    events = eventRes.data || [];

    localStorage.setItem('rincon_blocks', JSON.stringify(blocks));
    localStorage.setItem('rincon_tasks',  JSON.stringify(tasks));
    localStorage.setItem('rincon_events', JSON.stringify(events));
    localStorage.setItem('rincon_cached', todayStr);

  } catch (err) {
    console.warn('Supabase load failed, using cache:', err);
    isOffline = true;
    offlineBanner.classList.add('visible');
    blocks = JSON.parse(localStorage.getItem('rincon_blocks') || '[]');
    tasks  = JSON.parse(localStorage.getItem('rincon_tasks')  || '[]');
    events = JSON.parse(localStorage.getItem('rincon_events') || '[]');
  }

  checkAlerts();
  renderSchedule();
  renderTasks();
  setView('week');
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Online/offline ────────────────────────────────────────────────────────────
window.addEventListener('online',  () => { isOffline = false; offlineBanner.classList.remove('visible'); loadData(); });
window.addEventListener('offline', () => { isOffline = true;  offlineBanner.classList.add('visible'); });

// ── Service worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(console.error);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
renderHeader();
loadData();
