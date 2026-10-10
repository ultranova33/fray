// ==========================================================================
// Fray: app logic
// Private accounts, tasks with realtime sync, swipe gestures, timers with
// alerts, a 3-day history, the 9pm nudge, and the mood deck.
// ==========================================================================

import { QUOTE_BANK, createQuoteShuffler } from './quotes.js';
import { MOODS, SCRIBBLE, dealMood, moodById, applyMood } from './moods.js';

// ---- Config -----------------------------------------------------------------
// The publishable key is safe in browser code; Row Level Security in
// supabase-setup.sql decides what each account can see. Never put a secret
// key here.
const SUPABASE_URL = 'https://reprkvscdnrhxzemlggt.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_FnlUSAC71T2Mj2ATW6DRdQ_VUePWfry';

// Public half of the Web Push key pair. The private half lives only in the
// send-due-pushes Edge Function's secrets (see push-keys.txt).
const VAPID_PUBLIC_KEY = 'BIqQKgN_GC-wJjGTJ6CZt1uMaWkLgKPsC13_Ev9UsV84qStV4ZYEKK0TpUo6kbg8Qdq8VqCanSc9vER6Lr-pTgU';

// Accounts are username + password. Supabase Auth needs an email, so each
// username maps to <username>@<EMAIL_DOMAIN>. No email is ever sent
// ("Confirm email" is off in Supabase), so this never has to be a real inbox.
const EMAIL_DOMAIN = 'fray.app';

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const NOTIFIED_KEY = 'fray.notified';
const PIN_KEY = 'fray.moodPin';
const SHUFFLE = 'shuffle';
const ALERTS_ASKED_KEY = 'fray.alertsAsked';
const LAST_MINUTE_MS = 60 * 1000;
const STALE_ALERT_MS = 10 * 60 * 1000;
const UNDO_MS = 4500;
const SWIPE_TRIGGER = 90;

// ---- DOM ----------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  wipe: $('wipe'),
  auth: $('auth'), authMood: $('auth-mood'), authForm: $('auth-form'),
  authUser: $('auth-username'), authPass: $('auth-password'),
  authError: $('auth-error'), authSubmit: $('auth-submit'), authNote: $('auth-note'),
  app: $('app'), greeting: $('greeting'), dateDay: $('date-day'), dateRest: $('date-rest'),
  viewToday: $('view-today'), viewHistory: $('view-history'),
  quoteText: $('quote-text'), quoteAuthor: $('quote-author'), dice: $('dice'),
  progressLabel: $('progress-label'), nextTimer: $('next-timer'), progressBar: $('progress-bar'),
  folders: $('folders'), sync: $('sync'),
  taskList: $('task-list'), empty: $('empty'), emptyTitle: $('empty-title'), emptyText: $('empty-text'),
  historyList: $('history-list'),
  avatarBtn: $('avatar-btn'), fab: $('fab'),
  scrim: $('scrim'),
  taskSheet: $('task-sheet'), taskForm: $('task-form'), tTitle: $('t-title'), tDay: $('t-day'),
  tCats: $('t-cats'), tCategory: $('t-category'), tMode: $('t-mode'),
  tMinutesRow: $('t-minutes-row'), tQuick: $('t-quick'), tMinutes: $('t-minutes'),
  tEndRow: $('t-end-row'), tEnd: $('t-end'), tEndHint: $('t-end-hint'),
  tError: $('t-error'), tSubmit: $('t-submit'),
  profileSheet: $('profile-sheet'), pAvatar: $('p-avatar'), pName: $('p-name'), pMoodName: $('p-mood-name'),
  pTimer: $('p-timer'), pNudge: $('p-nudge'), pRoll: $('p-roll'), pMood: $('p-mood'),
  pDeviceRow: $('p-device-row'), pDeviceBtn: $('p-device-btn'), pSignout: $('p-signout'),
  alertsSheet: $('alerts-sheet'), alertsIos: $('alerts-ios'), alertsYes: $('alerts-yes'), alertsNo: $('alerts-no'),
  timesup: $('timesup'), timesupTitle: $('timesup-title'),
  timesupDone: $('timesup-done'), timesupSnooze: $('timesup-snooze'), timesupClose: $('timesup-close'),
  toasts: $('toasts'), tpl: $('task-tpl'),
};

// ---- State --------------------------------------------------------------------
const state = {
  user: null,
  profile: null,
  mood: null,
  authMode: 'signin',
  tasks: new Map(),          // id -> row for today and tomorrow
  view: 'today',
  day: 'today',              // which day the Today view lists
  category: null,            // category filter key, or null for all
  justDone: new Set(),
  pendingDelete: new Map(),  // id -> { task, timer }
  notified: loadNotified(),
  alarmQueue: [],
  alarmTask: null,
  today: localDate(),
  shuffler: createQuoteShuffler(QUOTE_BANK),
  channel: null,
  hadRealtimeError: false,
  swReg: null,
  swReady: Promise.resolve(null),
  sheetOpen: null,
  newTask: { day: 'today', mode: 'none', category: null },
};

let sb = null;
let renderCache = new Map();

// ==========================================================================
// Boot
// ==========================================================================

init();

async function init() {
  // PIN_KEY holds this device's copy of the account's mood setting: a mood id,
  // 'shuffle', or nothing yet (new device, or the installed app on iPhone,
  // which has its own storage). With nothing yet, the screen waits for the
  // profile instead of flashing a random mood first.
  const pinPref = readStorage(PIN_KEY);
  state.mood = dealMood(pinPref && pinPref !== SHUFFLE ? pinPref : null);
  applyMood(state.mood);
  if (pinPref === null) {
    document.documentElement.classList.add('booting');
    setTimeout(endBooting, 3000); // never hold the screen on a slow network
  } else playWipe();
  bindUi();
  state.swReady = registerServiceWorker();
  showQuote(state.shuffler.current(), false);

  if (!window.supabase?.createClient) {
    showAuth();
    el.authError.textContent = "Couldn't load Supabase. Check your connection and reload.";
    return;
  }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });

  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && state.user) showAuth();
  });

  loadQuotes();
  const { data } = await sb.auth.getSession();
  if (data?.session?.user) startApp(data.session.user);
  else showAuth();

  setInterval(tick, 1000);
  setInterval(checkNewDay, 30 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { checkNewDay(); tick(); }
  });
  window.addEventListener('scroll', onScrollDepth, { passive: true });
  navigator.serviceWorker?.addEventListener?.('message', (e) => {
    if (e.data?.type === 'open' && String(e.data.url || '').includes('new=tomorrow')) openTaskSheet({ day: 'tomorrow' });
  });
}

function bindUi() {
  // Auth
  document.querySelectorAll('[data-auth-mode]').forEach((b) =>
    b.addEventListener('click', () => setAuthMode(b.dataset.authMode)));
  el.authForm.addEventListener('submit', onAuthSubmit);

  // Navigation
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  document.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => setDay(b.dataset.day)));
  el.avatarBtn.addEventListener('click', openProfile);
  el.fab.addEventListener('click', () => openTaskSheet({ day: state.view === 'today' ? state.day : 'today' }));
  el.scrim.addEventListener('click', closeSheets);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });

  // Quote
  el.dice.addEventListener('click', rollQuote);

  // Folders and tasks
  el.folders.addEventListener('click', onFolderClick);
  el.taskList.addEventListener('click', onTaskClick);
  el.taskList.addEventListener('pointerdown', onSwipeStart);

  // Task sheet
  el.taskForm.addEventListener('submit', onTaskSubmit);
  el.tDay.addEventListener('click', (e) => { const v = segValue(e); if (v) setNewTaskDay(v); });
  el.tMode.addEventListener('click', (e) => { const v = segValue(e); if (v) setNewTaskMode(v); });
  el.tCats.addEventListener('click', onCatChip);
  el.tCategory.addEventListener('input', () => { state.newTask.category = null; markCatChips(); });
  el.tQuick.addEventListener('click', (e) => {
    const b = e.target.closest('[data-min]');
    if (!b) return;
    el.tMinutes.value = b.dataset.min;
    markQuickChips();
  });
  el.tMinutes.addEventListener('input', markQuickChips);
  el.tEnd.addEventListener('input', updateEndHint);

  // Profile
  el.pTimer.addEventListener('click', () => toggleProfile('timer_alerts', el.pTimer));
  el.pNudge.addEventListener('click', () => toggleProfile('nudge_enabled', el.pNudge));
  el.pRoll.addEventListener('click', (e) => { const v = segValue(e); if (v) saveProfile({ rollover: v === 'roll' }); });
  el.pMood.addEventListener('click', (e) => { const v = segValue(e); if (v) setMoodPin(v === 'pin'); });
  el.pDeviceBtn.addEventListener('click', () => enablePhoneAlerts());
  el.pSignout.addEventListener('click', signOut);

  // First-run alerts
  el.alertsYes.addEventListener('click', async () => { closeSheets(); await enablePhoneAlerts(); });
  el.alertsNo.addEventListener('click', closeSheets);

  // Time's up
  el.timesupDone.addEventListener('click', () => { const t = state.alarmTask; hideTimesUp(); if (t) setCompleted(t.id, true); });
  el.timesupSnooze.addEventListener('click', () => { const t = state.alarmTask; hideTimesUp(); if (t) snooze(t.id); });
  el.timesupClose.addEventListener('click', hideTimesUp);

  // Browsers only allow audio after a tap; unlock it on the first one.
  const unlock = () => { getAudio(); window.removeEventListener('pointerdown', unlock); };
  window.addEventListener('pointerdown', unlock);
}

// ==========================================================================
// Mood
// ==========================================================================

function playWipe() {
  el.wipe.classList.remove('go');
  void el.wipe.offsetWidth;
  el.wipe.classList.add('go');
}

function deal(container) {
  container.classList.remove('dealing');
  void container.offsetWidth;
  container.classList.add('dealing');
  setTimeout(() => container.classList.remove('dealing'), 1400);
}

async function setMoodPin(pin) {
  const value = pin ? state.mood.id : null;
  writeStorage(PIN_KEY, value || SHUFFLE);
  await saveProfile({ mood_pin: value });
  toast(pin ? `${state.mood.name} is pinned until you switch back to Shuffle.` : 'Shuffle is on. A new mood every launch.');
}

// ==========================================================================
// Auth
// ==========================================================================

function endBooting() {
  if (!document.documentElement.classList.contains('booting')) return;
  document.documentElement.classList.remove('booting');
  playWipe();
}

function showAuth() {
  endBooting();
  stopRealtime();
  state.user = null;
  state.profile = null;
  state.tasks = new Map();
  renderCache = new Map();
  el.taskList.replaceChildren();
  closeSheets();
  hideTimesUp();
  el.app.hidden = true;
  el.auth.hidden = false;
  el.authMood.textContent = `today's mood · ${state.mood.name}`;
  el.authSubmit.disabled = false;
  deal(el.auth);
}

function setAuthMode(mode) {
  state.authMode = mode;
  document.querySelectorAll('[data-auth-mode]').forEach((b) => {
    const on = b.dataset.authMode === mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  });
  el.authSubmit.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
  el.authPass.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  el.authNote.textContent = mode === 'signup'
    ? "There's no password reset, so pick one you'll remember."
    : 'Your tasks are private to your account.';
  el.authError.textContent = '';
}

async function onAuthSubmit(e) {
  e.preventDefault();
  if (!sb) return;
  const username = el.authUser.value.trim().toLowerCase();
  const password = el.authPass.value;
  el.authError.textContent = '';

  if (!USERNAME_RE.test(username)) {
    el.authError.textContent = 'Usernames are 3–20 lowercase letters, numbers or _.';
    el.authUser.focus();
    return;
  }
  if (password.length < 6) {
    el.authError.textContent = 'Passwords need at least 6 characters.';
    el.authPass.focus();
    return;
  }

  const email = `${username}@${EMAIL_DOMAIN}`;
  el.authSubmit.disabled = true;
  try {
    if (state.authMode === 'signup') {
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username } } });
      if (error) throw error;
      if (!data.session) {
        el.authError.textContent = 'Account created, but Supabase is asking for email confirmation. Turn off "Confirm email" in Supabase (see SETUP.md), then sign in.';
        return;
      }
      await startApp(data.session.user, { firstRun: true });
    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await startApp(data.user);
    }
  } catch (err) {
    el.authError.textContent = authMessage(err);
  } finally {
    el.authSubmit.disabled = false;
  }
}

function authMessage(err) {
  const msg = String(err?.message || err || '');
  if (/invalid login credentials/i.test(msg)) return 'Wrong username or password.';
  if (/already registered|already exists/i.test(msg)) return 'That username is taken. Try another, or sign in.';
  if (/email not confirmed/i.test(msg)) return 'Supabase still has "Confirm email" turned on. Turn it off (see SETUP.md), then sign in.';
  if (/password/i.test(msg) && /characters|weak|short/i.test(msg)) return 'That password is too weak. Use at least 6 characters.';
  if (/rate limit|too many/i.test(msg)) return 'Too many tries. Wait a minute and try again.';
  if (/fetch|network/i.test(msg)) return "Can't reach the server. Check your connection.";
  return msg || 'Something went wrong. Try again.';
}

async function signOut() {
  closeSheets();
  const sub = await currentPushSubscription();
  if (sub && sb) await sb.rpc('delete_push_subscription', { p_endpoint: sub.endpoint }).then(() => {}, () => {});
  await sb.auth.signOut();
  removeStorage(PIN_KEY); // the next account brings its own mood setting
  showAuth();
}

// ==========================================================================
// App start
// ==========================================================================

async function startApp(user, opts = {}) {
  state.user = user;
  el.auth.hidden = true;
  el.app.hidden = false;
  el.authPass.value = '';

  const { data: profile, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (error || !profile) toast("Couldn't load your profile. Has supabase-setup.sql been run?", { error: true });
  state.profile = profile || {
    username: (user.email || '').split('@')[0], rollover: true, timer_alerts: true, nudge_enabled: true, mood_pin: null,
  };

  // A pin saved on another device wins over the locally dealt mood.
  if (state.profile.mood_pin && state.profile.mood_pin !== state.mood.id) {
    const pinned = moodById(state.profile.mood_pin);
    if (pinned) { state.mood = pinned; applyMood(pinned); }
  }
  writeStorage(PIN_KEY, state.profile.mood_pin || SHUFFLE);
  endBooting();

  const name = state.profile.username || 'you';
  el.avatarBtn.textContent = name.charAt(0);
  el.avatarBtn.setAttribute('aria-label', `Open profile for ${name}`);

  sb.rpc('set_timezone', { p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }).then(() => {}, () => {});

  state.today = localDate();
  await sb.rpc('close_days', { p_today: state.today }).then(() => {}, () => {});
  await loadTasks();
  subscribeRealtime();
  refreshPushSubscription();

  setDay('today');
  setView('today', { silent: true });
  renderHeader();
  render();
  deal(el.app);

  if (new URLSearchParams(location.search).get('new') === 'tomorrow') {
    history.replaceState(null, '', location.pathname);
    openTaskSheet({ day: 'tomorrow' });
  } else if (opts.firstRun) {
    maybeAskAlerts();
  }
}

async function checkNewDay() {
  if (!state.user) return;
  const now = localDate();
  renderHeader();
  if (now === state.today) return;
  state.today = now;
  await sb.rpc('close_days', { p_today: now }).then(() => {}, () => {});
  await loadTasks();
  render();
  if (state.view === 'history') renderHistory();
}

// ==========================================================================
// Dates
// ==========================================================================

function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dateFromYmd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dayKeyToDate(key) {
  return key === 'tomorrow' ? localDate(1) : state.today;
}

// ==========================================================================
// Header + quote
// ==========================================================================

function renderHeader() {
  const now = new Date();
  const h = now.getHours();
  const part = h < 5 ? 'Late night' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
  const em = document.createElement('em');
  em.textContent = `${state.profile?.username || 'you'}.`;
  el.greeting.replaceChildren(document.createTextNode(`${part},`), document.createElement('br'), em);
  el.dateDay.textContent = now.toLocaleDateString(undefined, { weekday: 'short' });
  el.dateRest.textContent = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

async function loadQuotes() {
  const { data, error } = await sb.from('quotes').select('quote, author').order('id', { ascending: true });
  if (error || !data?.length) return; // keep the built-in bank
  state.shuffler = createQuoteShuffler(data);
  showQuote(state.shuffler.current(), false);
}

function rollQuote() {
  el.dice.classList.remove('roll');
  void el.dice.offsetWidth;
  el.dice.classList.add('roll');
  showQuote(state.shuffler.next(), true);
}

function showQuote(q, animate) {
  const apply = () => {
    el.quoteText.textContent = `“${q.quote}”`;
    el.quoteAuthor.textContent = q.author ? `— ${q.author}` : '';
    el.quoteAuthor.hidden = !q.author;
    el.quoteText.classList.remove('is-fading');
  };
  if (!animate) return apply();
  el.quoteText.classList.add('is-fading');
  setTimeout(apply, 180);
}

// ==========================================================================
// Tasks: data
// ==========================================================================

async function loadTasks() {
  setSync('loading');
  const { data, error } = await sb.from('tasks').select('*')
    .in('for_date', [state.today, localDate(1)])
    .order('created_at', { ascending: true });
  if (error) {
    setSync('offline');
    toast(`Couldn't load tasks: ${error.message}`, { error: true });
    return;
  }
  state.tasks = new Map(data.map((t) => [t.id, t]));
  const now = Date.now();
  for (const t of data) {
    if (t.deadline_at && !t.completed && now - Date.parse(t.deadline_at) > STALE_ALERT_MS) markNotified(t.id);
  }
  setSync(state.channel ? 'live' : 'synced');
}

function subscribeRealtime() {
  stopRealtime();
  state.channel = sb.channel(`fray-${state.user.id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `user_id=eq.${state.user.id}` }, onRealtime)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setSync('live');
        if (state.hadRealtimeError) { state.hadRealtimeError = false; loadTasks().then(render); }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        state.hadRealtimeError = true;
        setSync('reconnecting');
      }
    });
}

function stopRealtime() {
  if (state.channel && sb) sb.removeChannel(state.channel);
  state.channel = null;
}

function onRealtime(payload) {
  if (payload.eventType === 'DELETE') {
    const id = payload.old?.id;
    if (id && state.tasks.delete(id)) render();
    return;
  }
  const row = payload.new;
  if (!row?.id || row.user_id !== state.user?.id) return;
  if (state.pendingDelete.has(row.id)) return;
  if (row.for_date !== state.today && row.for_date !== localDate(1)) {
    if (state.tasks.delete(row.id)) render();
    return;
  }
  const prev = state.tasks.get(row.id);
  if (row.completed && prev && !prev.completed) state.justDone.add(row.id);
  if (prev && prev.deadline_at !== row.deadline_at) { state.notified.delete(row.id); saveNotified(); }
  state.tasks.set(row.id, row);
  render();
}

async function setCompleted(id, completed) {
  const prev = state.tasks.get(id);
  if (!prev) return;
  if (completed) { state.justDone.add(id); navigator.vibrate?.(20); }
  state.tasks.set(id, { ...prev, completed });
  render();
  const { data, error } = await sb.from('tasks').update({ completed }).eq('id', id).select().single();
  if (error) {
    state.tasks.set(id, prev);
    render();
    toast(`Couldn't save that: ${error.message}`, { error: true });
    return;
  }
  state.tasks.set(id, data);
  render();
}

function deleteWithUndo(id) {
  const task = state.tasks.get(id);
  if (!task) return;
  state.tasks.delete(id);
  render();
  const timer = setTimeout(async () => {
    state.pendingDelete.delete(id);
    const { error } = await sb.from('tasks').delete().eq('id', id);
    if (error) {
      state.tasks.set(id, task);
      render();
      toast(`Couldn't delete: ${error.message}`, { error: true });
    }
  }, UNDO_MS);
  state.pendingDelete.set(id, { task, timer });
  toast('Task deleted.', {
    action: 'Undo',
    ms: UNDO_MS,
    onAction: () => {
      const p = state.pendingDelete.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      state.pendingDelete.delete(id);
      state.tasks.set(id, p.task);
      render();
    },
  });
}

async function snooze(id) {
  const t = state.tasks.get(id);
  if (!t) return;
  const base = Math.max(Date.now(), t.deadline_at ? Date.parse(t.deadline_at) : 0);
  const patch = {
    deadline_at: new Date(base + 5 * 60000).toISOString(),
    goal_minutes: Math.min(2880, (t.goal_minutes || 0) + 5),
    push_sent_at: null,
  };
  state.notified.delete(id);
  saveNotified();
  state.tasks.set(id, { ...t, ...patch });
  render();
  const { error } = await sb.from('tasks').update(patch).eq('id', id);
  if (error) toast(`Couldn't snooze: ${error.message}`, { error: true });
  else toast('5 more minutes. You got this.');
}

// ==========================================================================
// Rendering: Today
// ==========================================================================

function setView(view, opts = {}) {
  state.view = view;
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('is-on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  el.viewToday.hidden = view !== 'today';
  el.viewHistory.hidden = view !== 'history';
  if (view === 'history') { renderHistory(); if (!opts.silent) deal(el.viewHistory); }
  else if (!opts.silent) { render(); deal(el.viewToday); }
  if (!opts.silent) window.scrollTo({ top: 0 });
}

function setDay(day) {
  state.day = day;
  state.category = null;
  document.querySelectorAll('[data-day]').forEach((b) => {
    const on = b.dataset.day === day;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  });
  render();
}

function tasksFor(dayKey) {
  const date = dayKeyToDate(dayKey);
  return [...state.tasks.values()].filter((t) => t.for_date === date);
}

function categoryKey(c) { return (c || '').trim().toLowerCase(); }

function catColor(name) {
  let h = 0;
  for (const ch of categoryKey(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `var(--cat${(h % 5) + 1})`;
}

function render() {
  if (!state.user) return;
  const todayTasks = tasksFor('today');
  const done = todayTasks.filter((t) => t.completed).length;
  el.progressLabel.textContent = `${done} of ${todayTasks.length} done`;
  const pct = todayTasks.length ? Math.round((done / todayTasks.length) * 100) : 0;
  el.progressBar.querySelector('i').style.width = `${pct}%`;
  el.progressBar.setAttribute('aria-valuenow', String(pct));

  const dayTasks = tasksFor(state.day);
  renderFolders(dayTasks);

  const shown = dayTasks
    .filter((t) => state.category === null || categoryKey(t.category) === state.category)
    .sort((a, b) => (a.completed - b.completed) || (Date.parse(a.created_at) - Date.parse(b.created_at)));

  // Reuse unchanged cards so running animations aren't restarted by echoes.
  const next = new Map();
  const nodes = shown.map((t, i) => {
    const sig = JSON.stringify([t.title, t.category, t.completed, t.goal_minutes, t.deadline_at, t.for_date]);
    const cached = renderCache.get(t.id);
    const li = cached && cached.sig === sig && !state.justDone.has(t.id) ? cached.li : renderTask(t);
    li.style.setProperty('--i', String(Math.min(i + 4, 10)));
    next.set(t.id, { sig, li });
    return li;
  });
  renderCache = next;
  const current = [...el.taskList.children];
  if (current.length !== nodes.length || nodes.some((n, i) => n !== current[i])) el.taskList.replaceChildren(...nodes);
  state.justDone.clear();
  nodes.forEach((li) => { if (li.classList.contains('just-done') && !li.dataset.drawn) drawStrike(li); });

  el.empty.hidden = shown.length > 0;
  if (!shown.length) {
    const tomorrow = state.day === 'tomorrow';
    el.emptyTitle.textContent = state.category ? 'Nothing in this folder.' : tomorrow ? 'Tomorrow is wide open.' : 'A clean page.';
    el.emptyText.textContent = tomorrow ? 'Plan a few things tonight. Tap +.' : 'Tap + to deal yourself a task.';
  }
  tick(false);
  onScrollDepth();
}

function renderFolders(dayTasks) {
  const cats = new Map();
  for (const t of dayTasks) {
    if (!t.category) continue;
    const k = categoryKey(t.category);
    const c = cats.get(k) || { label: t.category, count: 0 };
    c.count++;
    cats.set(k, c);
  }
  if (state.category !== null && !cats.has(state.category)) state.category = null;

  const items = [folderBtn('All', dayTasks.length, null, 'var(--pop)')];
  [...cats.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label))
    .forEach(([k, c]) => items.push(folderBtn(c.label, c.count, k, catColor(c.label))));
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'folder folder--add';
  add.dataset.add = '1';
  add.textContent = '+ new';
  items.push(add);
  el.folders.replaceChildren(...items);
}

function folderBtn(label, count, key, color) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'folder' + (state.category === key ? ' is-on' : '');
  b.style.setProperty('--c', color);
  b.dataset.key = key ?? '';
  b.setAttribute('aria-pressed', String(state.category === key));
  const name = document.createElement('b');
  name.textContent = label;
  const n = document.createElement('span');
  n.textContent = `${count} ${count === 1 ? 'task' : 'tasks'}`;
  b.append(name, n);
  return b;
}

function onFolderClick(e) {
  const b = e.target.closest('.folder');
  if (!b) return;
  if (b.dataset.add) { openTaskSheet({ day: state.day, focusCategory: true }); return; }
  const key = b.dataset.key || null;
  state.category = state.category === key ? null : key;
  render();
}

// Draws the done scribble in with a pen stroke, one title line after another,
// then hands off to the static CSS scribble (same shape, see moods.js).
function drawStrike(li) {
  li.dataset.drawn = '1';
  const title = li.querySelector('.task-title');
  const tt = li.querySelector('.tt');
  const lines = [...tt.getClientRects()].filter((r) => r.width > 0);
  if (!lines.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = title.getBoundingClientRect();
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'strike-pen');
  svg.setAttribute('aria-hidden', 'true');
  let delay = 0;
  let last;
  for (const r of lines) {
    const x0 = r.left - box.left;
    const y0 = r.top - box.top + r.height * 0.55 - 6;
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M' + SCRIBBLE.map(([x, y]) => `${(x0 + x * r.width).toFixed(1)} ${(y0 + y).toFixed(1)}`).join(' L'));
    path.setAttribute('pathLength', '1');
    const d = Math.min(0.42, Math.max(0.2, r.width / 650));
    path.style.setProperty('--d', `${d}s`);
    path.style.setProperty('--delay', `${delay + 0.06}s`);
    delay += d;
    svg.append(path);
    last = path;
  }
  tt.classList.add('drawing');
  title.append(svg);
  const finish = () => { tt.classList.remove('drawing'); svg.remove(); };
  last.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, (delay + 0.6) * 1000); // in case the card left the page mid-animation
}

function renderTask(t) {
  const li = el.tpl.content.firstElementChild.cloneNode(true);
  li.dataset.id = t.id;
  li.classList.toggle('is-done', t.completed);
  if (state.justDone.has(t.id) && t.completed) li.classList.add('just-done');
  li.querySelector('.tt').textContent = t.title;
  li.querySelector('.tick').setAttribute('aria-label', t.completed ? 'Mark not done' : 'Mark done');
  const cat = li.querySelector('.task-cat');
  if (t.category) { cat.textContent = t.category; cat.style.setProperty('--c', catColor(t.category)); }
  if (t.deadline_at) {
    const d = new Date(t.deadline_at);
    li.querySelector('.task-when').textContent = `ends ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }
  li.querySelector('.timer').hidden = !t.deadline_at || t.completed;
  return li;
}

function onTaskClick(e) {
  const li = e.target.closest('.task');
  if (!li || li.dataset.swiped) return;
  const id = li.dataset.id;
  if (e.target.closest('.tick')) {
    const t = state.tasks.get(id);
    if (t) setCompleted(id, !t.completed);
  } else if (e.target.closest('.task-del')) {
    deleteWithUndo(id);
  }
}

// ---- Swipe: right = done, left = delete -----------------------------------------

function onSwipeStart(e) {
  if (e.button !== undefined && e.button !== 0) return;
  if (e.target.closest('button')) return;
  const li = e.target.closest('.task');
  if (!li) return;
  const card = li.querySelector('.task-card');
  const startX = e.clientX;
  const startY = e.clientY;
  let dx = 0;
  let dragging = false;

  const move = (ev) => {
    const mx = ev.clientX - startX;
    const my = ev.clientY - startY;
    if (!dragging) {
      if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { cleanup(); return; }
      if (Math.abs(mx) < 10) return;
      dragging = true;
      li.classList.add('is-dragging');
    }
    dx = mx;
    card.style.transform = `translateX(${dx}px) rotate(${(dx / 40).toFixed(2)}deg)`;
    li.classList.toggle('swipe-right', dx > 20);
    li.classList.toggle('swipe-left', dx < -20);
    if (ev.cancelable) ev.preventDefault();
  };
  const up = () => {
    cleanup();
    if (!dragging) return;
    li.classList.remove('is-dragging');
    li.dataset.swiped = '1';
    setTimeout(() => { delete li.dataset.swiped; }, 60);
    const id = li.dataset.id;
    if (dx > SWIPE_TRIGGER) {
      card.style.transform = '';
      const t = state.tasks.get(id);
      if (t) setCompleted(id, !t.completed);
    } else if (dx < -SWIPE_TRIGGER) {
      card.style.transform = 'translateX(-120%)';
      setTimeout(() => deleteWithUndo(id), 160);
    } else {
      card.style.transform = '';
    }
    setTimeout(() => li.classList.remove('swipe-right', 'swipe-left'), 250);
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

// ---- Floating depth: cards drift slightly relative to the viewport -------------

let depthFrame = 0;
function onScrollDepth() {
  if (depthFrame || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  depthFrame = requestAnimationFrame(() => {
    depthFrame = 0;
    const mid = window.innerHeight / 2;
    [...el.taskList.children].forEach((li, i) => {
      const r = li.getBoundingClientRect();
      const depth = 0.012 + (i % 3) * 0.008;
      const y = Math.max(-10, Math.min(10, (mid - (r.top + r.height / 2)) * depth));
      li.style.translate = `0 ${y.toFixed(1)}px`;
    });
  });
}

// ==========================================================================
// Timers & alerts
// ==========================================================================

function tick(allowAlerts = true) {
  if (!state.user) return;
  const now = Date.now();
  let nextLeft = Infinity;

  for (const li of el.taskList.children) {
    const t = state.tasks.get(li.dataset.id);
    if (!t?.deadline_at || t.completed) continue;
    const timer = li.querySelector('.timer');
    const left = Date.parse(t.deadline_at) - now;
    const total = Math.max(1, (t.goal_minutes || 1) * 60000);
    const [a, b] = timerParts(Math.abs(left));
    li.querySelector('.t-mm').textContent = a;
    li.querySelector('.t-ss').textContent = b;
    li.querySelector('.drain i').style.width = `${Math.max(0, Math.min(100, (left / total) * 100)).toFixed(1)}%`;
    timer.classList.toggle('is-last', left > 0 && left <= LAST_MINUTE_MS);
    timer.classList.toggle('is-up', left <= 0);
    const text = left <= 0 ? 'over' : left >= 3600000 ? 'h : min' : '';
    let label = timer.querySelector('.timer-label');
    if (text && !label) {
      label = document.createElement('span');
      label.className = 'timer-label';
      timer.insertBefore(label, timer.querySelector('.drain'));
    }
    if (label) label.textContent = text;
  }

  for (const t of state.tasks.values()) {
    if (!t.deadline_at || t.completed) continue;
    const left = Date.parse(t.deadline_at) - now;
    if (left > 0) nextLeft = Math.min(nextLeft, left);
    else if (allowAlerts && !state.notified.has(t.id) && -left < STALE_ALERT_MS) timeUp(t);
  }
  el.nextTimer.textContent = nextLeft < Infinity ? `next timer ${timerParts(nextLeft).join(':')}` : '';
}

// MM:SS under an hour, H:MM above.
function timerParts(ms) {
  const s = Math.floor(ms / 1000);
  if (s >= 3600) return [String(Math.floor(s / 3600)), String(Math.floor((s % 3600) / 60)).padStart(2, '0')];
  return [String(Math.floor(s / 60)).padStart(2, '0'), String(s % 60).padStart(2, '0')];
}

function timeUp(task) {
  markNotified(task.id);
  playChime();
  navigator.vibrate?.([200, 100, 200, 100, 400]);
  if (state.profile?.timer_alerts !== false && document.visibilityState !== 'visible') {
    showSystemNotification('Fray ⏰', `Time's up for ${task.title}!`, task.id);
  }
  state.alarmQueue.push(task);
  if (!state.alarmTask) showNextAlarm();
}

function showNextAlarm() {
  const task = state.alarmQueue.shift();
  if (!task) return;
  state.alarmTask = task;
  el.timesupTitle.textContent = `Time's up for ${task.title}!`;
  el.timesup.hidden = false;
  el.timesupDone.focus();
}

function hideTimesUp() {
  el.timesup.hidden = true;
  state.alarmTask = null;
  if (state.alarmQueue.length) setTimeout(showNextAlarm, 250);
}

async function showSystemNotification(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const options = { body, tag, renotify: true, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' };
  try {
    const reg = state.swReg || await navigator.serviceWorker?.getRegistration?.();
    if (reg) return reg.showNotification(title, options);
    new Notification(title, options);
  } catch (err) {
    console.warn('[Fray] notification failed:', err);
  }
}

let audioCtx = null;
function getAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playChime() {
  const ctx = getAudio();
  if (!ctx) return;
  [784, 988, 1175, 784, 988, 1175].forEach((freq, i) => {
    const t0 = ctx.currentTime + i * 0.17 + (i >= 3 ? 0.25 : 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.32, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.55);
  });
}

// ==========================================================================
// New task sheet
// ==========================================================================

function openTaskSheet({ day = 'today', focusCategory = false } = {}) {
  if (!state.user) return;
  el.taskForm.reset();
  el.tError.textContent = '';
  state.newTask = { day, mode: 'none', category: null };
  setNewTaskMode('none');
  setNewTaskDay(day);
  markQuickChips();

  const cats = new Map();
  for (const t of state.tasks.values()) {
    if (t.category && !cats.has(categoryKey(t.category))) cats.set(categoryKey(t.category), t.category);
  }
  el.tCats.replaceChildren(...[...cats.values()].sort((a, b) => a.localeCompare(b)).map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-btn';
    b.dataset.cat = c;
    b.style.setProperty('--c', catColor(c));
    b.textContent = c;
    return b;
  }));
  el.tCats.hidden = cats.size === 0;
  if (state.category && cats.has(state.category)) { state.newTask.category = cats.get(state.category); markCatChips(); }

  openSheet(el.taskSheet);
  setTimeout(() => (focusCategory ? el.tCategory : el.tTitle).focus(), 80);
}

function setNewTaskDay(day) {
  state.newTask.day = day;
  setSeg(el.tDay, day);
  // Minute timers start counting now, so they only make sense for today.
  const minutesBtn = el.tMode.querySelector('[data-value="minutes"]');
  minutesBtn.disabled = day === 'tomorrow';
  minutesBtn.title = day === 'tomorrow' ? 'For tomorrow, pick an end time' : '';
  if (day === 'tomorrow' && state.newTask.mode === 'minutes') setNewTaskMode('ends');
  updateEndHint();
}

function setNewTaskMode(mode) {
  state.newTask.mode = mode;
  setSeg(el.tMode, mode);
  el.tMinutesRow.hidden = mode !== 'minutes';
  el.tEndRow.hidden = mode !== 'ends';
  if (mode === 'ends') updateEndHint();
}

function markQuickChips() {
  el.tQuick.querySelectorAll('.chip-btn').forEach((c) => c.classList.toggle('is-on', c.dataset.min === el.tMinutes.value));
}

function updateEndHint() {
  const day = state.newTask.day;
  if (!el.tEnd.value) { el.tEndHint.textContent = day; return; }
  const d = endDate(el.tEnd.value, day);
  el.tEndHint.textContent = `${day} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function endDate(hhmm, dayKey) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = dateFromYmd(dayKeyToDate(dayKey));
  d.setHours(h, m, 0, 0);
  return d;
}

function onCatChip(e) {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  state.newTask.category = state.newTask.category === b.dataset.cat ? null : b.dataset.cat;
  el.tCategory.value = '';
  markCatChips();
}

function markCatChips() {
  el.tCats.querySelectorAll('[data-cat]').forEach((c) => c.classList.toggle('is-on', c.dataset.cat === state.newTask.category));
}

async function onTaskSubmit(e) {
  e.preventDefault();
  el.tError.textContent = '';
  const title = el.tTitle.value.trim().replace(/\s+/g, ' ');
  if (!title) { el.tError.textContent = 'Give your task a name first.'; el.tTitle.focus(); return; }
  const category = (el.tCategory.value.trim().replace(/\s+/g, ' ') || state.newTask.category || '').slice(0, 40) || null;
  const { day, mode } = state.newTask;

  let deadline = null;
  let goal = null;
  if (mode === 'minutes') {
    goal = Number(el.tMinutes.value);
    if (!Number.isInteger(goal) || goal < 1 || goal > 1440) {
      el.tError.textContent = 'Pick a timer from 1 to 1440 minutes.';
      el.tMinutes.focus();
      return;
    }
    deadline = new Date(Date.now() + goal * 60000);
  } else if (mode === 'ends') {
    if (!el.tEnd.value) { el.tError.textContent = 'Pick an end time.'; el.tEnd.focus(); return; }
    deadline = endDate(el.tEnd.value, day);
    if (deadline.getTime() <= Date.now() + 30000) {
      el.tError.textContent = 'That time has already passed today. Pick a later time, or set it for Tomorrow.';
      el.tEnd.focus();
      return;
    }
    goal = Math.min(2880, Math.max(1, Math.ceil((deadline.getTime() - Date.now()) / 60000)));
  }

  const row = {
    title,
    category,
    for_date: dayKeyToDate(day),
    goal_minutes: goal,
    deadline_at: deadline ? deadline.toISOString() : null,
  };

  el.tSubmit.disabled = true;
  const { data, error } = await sb.from('tasks').insert(row).select().single();
  el.tSubmit.disabled = false;
  if (error) { el.tError.textContent = `Couldn't save: ${error.message}`; return; }

  state.tasks.set(data.id, data);
  closeSheets();
  if (state.view !== 'today') setView('today');
  if (state.day !== day) {
    toast(day === 'tomorrow' ? 'Added to tomorrow.' : 'Added to today.', { action: 'Show', onAction: () => setDay(day) });
  }
  render();
  if (goal) maybeAskAlerts();
}

// ==========================================================================
// History (last 3 days)
// ==========================================================================

async function renderHistory() {
  const days = [1, 2, 3].map((n) => localDate(-n));
  el.historyList.replaceChildren(...days.map((d) => historyCard(d, null, [])));
  if (!sb || !state.user) return;

  const [stats, tasks] = await Promise.all([
    sb.from('day_stats').select('day, set_count, done_count').in('day', days),
    sb.from('tasks').select('title, completed, for_date').in('for_date', days).order('created_at', { ascending: true }),
  ]);
  if (state.view !== 'history') return;
  const statMap = new Map((stats.data || []).map((s) => [s.day, s]));
  const taskMap = new Map(days.map((d) => [d, []]));
  for (const t of tasks.data || []) taskMap.get(t.for_date)?.push(t);

  el.historyList.replaceChildren(...days.map((d) => {
    const list = taskMap.get(d);
    const s = statMap.get(d) || { set_count: list.length, done_count: list.filter((t) => t.completed).length };
    return historyCard(d, s, list);
  }));
}

function historyCard(ymd, stat, list) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'day chunky deal';
  card.setAttribute('aria-expanded', 'false');
  const date = dateFromYmd(ymd);

  const top = document.createElement('div');
  top.className = 'day-top';
  const ring = document.createElement('div');
  ring.className = 'ring';
  const pct = stat && stat.set_count ? stat.done_count / stat.set_count : 0;
  ring.style.setProperty('--p', String(pct));
  const pctLabel = document.createElement('span');
  pctLabel.textContent = stat ? (stat.set_count ? `${Math.round(pct * 100)}%` : '–') : '…';
  ring.appendChild(pctLabel);

  const text = document.createElement('div');
  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = ymd === localDate(-1) ? 'Yesterday' : date.toLocaleDateString(undefined, { weekday: 'long' });
  const h = document.createElement('h3');
  h.textContent = stat ? (stat.set_count ? `${stat.done_count} of ${stat.set_count} done` : 'No tasks') : 'Loading';
  const sub = document.createElement('p');
  sub.className = 'day-count';
  sub.textContent = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  text.append(eyebrow, h, sub);
  top.append(ring, text);
  card.appendChild(top);

  if (stat && list.length) {
    const ul = document.createElement('ul');
    ul.className = 'day-list';
    ul.hidden = true;
    for (const t of list) {
      const li = document.createElement('li');
      if (t.completed) li.className = 'done';
      const span = document.createElement('span');
      span.textContent = t.title;
      li.appendChild(span);
      ul.appendChild(li);
    }
    card.appendChild(ul);
    card.addEventListener('click', () => {
      ul.hidden = !ul.hidden;
      card.setAttribute('aria-expanded', String(!ul.hidden));
    });
  } else if (stat && stat.set_count) {
    const p = document.createElement('p');
    p.className = 'day-empty';
    p.textContent = 'Tasks from this day were rolled over or deleted.';
    card.appendChild(p);
  }
  return card;
}

// ==========================================================================
// Profile
// ==========================================================================

function openProfile() {
  const p = state.profile || {};
  el.pName.textContent = p.username || 'you';
  el.pAvatar.textContent = (p.username || '?').charAt(0);
  el.pMoodName.textContent = `today's mood · ${state.mood.name}`;
  el.pTimer.setAttribute('aria-checked', String(p.timer_alerts !== false));
  el.pNudge.setAttribute('aria-checked', String(p.nudge_enabled !== false));
  setSeg(el.pRoll, p.rollover === false ? 'stay' : 'roll');
  setSeg(el.pMood, p.mood_pin ? 'pin' : 'shuffle');
  updateDeviceRow();
  openSheet(el.profileSheet);
}

async function toggleProfile(field, btn) {
  const next = btn.getAttribute('aria-checked') !== 'true';
  btn.setAttribute('aria-checked', String(next));
  await saveProfile({ [field]: next });
  if (next && !(await currentPushSubscription())) enablePhoneAlerts();
}

async function saveProfile(patch) {
  const prev = { ...state.profile };
  state.profile = { ...state.profile, ...patch };
  if (!state.user) return;
  const { error } = await sb.from('profiles').update(patch).eq('id', state.user.id);
  if (error) {
    state.profile = prev;
    toast(`Couldn't save: ${error.message}`, { error: true });
    if (!el.profileSheet.hidden) openProfile();
  }
}

// ==========================================================================
// Sheets, toasts, helpers
// ==========================================================================

function openSheet(sheet) {
  closeSheets();
  el.scrim.hidden = false;
  sheet.hidden = false;
  state.sheetOpen = sheet;
}

function closeSheets() {
  [el.taskSheet, el.profileSheet, el.alertsSheet].forEach((s) => { s.hidden = true; });
  el.scrim.hidden = true;
  state.sheetOpen = null;
}

function setSeg(seg, value) {
  seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.value === value));
}

function segValue(e) {
  const b = e.target.closest('.seg-btn');
  if (!b || b.disabled) return null;
  setSeg(b.parentElement, b.dataset.value);
  return b.dataset.value;
}

function setSync(text) {
  el.sync.textContent = text;
  el.sync.classList.toggle('is-live', text === 'live');
}

function toast(text, opts = {}) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', opts.error ? 'alert' : 'status');
  const span = document.createElement('span');
  span.textContent = text;
  t.appendChild(span);
  if (opts.action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opts.action;
    b.addEventListener('click', () => { opts.onAction?.(); t.remove(); });
    t.appendChild(b);
  }
  el.toasts.appendChild(t);
  setTimeout(() => t.remove(), opts.ms || 4000);
}

function loadNotified() {
  try { return new Set(JSON.parse(readStorage(NOTIFIED_KEY) || '[]')); } catch { return new Set(); }
}
function saveNotified() {
  const ids = [...state.notified].slice(-300);
  state.notified = new Set(ids);
  writeStorage(NOTIFIED_KEY, JSON.stringify(ids));
}
function markNotified(id) { state.notified.add(id); saveNotified(); }

function readStorage(k) { try { return localStorage.getItem(k); } catch { return null; } }
function writeStorage(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
function removeStorage(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } }

// ==========================================================================
// Phone push alerts (timers + 9pm nudge, even with the app closed)
// ==========================================================================

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try { state.swReg = await navigator.serviceWorker.register('sw.js'); } catch (err) { console.warn('[Fray] service worker failed:', err); }
  return state.swReg;
}

async function currentPushSubscription() {
  await state.swReady;
  if (!pushSupported() || !state.swReg) return null;
  try { return await state.swReg.pushManager.getSubscription(); } catch { return null; }
}

function maybeAskAlerts() {
  if (readStorage(ALERTS_ASKED_KEY)) return;
  const iosNeedsInstall = isIos() && !isStandalone();
  if (!pushSupported() && !iosNeedsInstall) return;
  writeStorage(ALERTS_ASKED_KEY, '1');
  if (!iosNeedsInstall && Notification.permission === 'granted') { enablePhoneAlerts({ quiet: true }); return; }
  el.alertsIos.hidden = !iosNeedsInstall;
  el.alertsYes.hidden = iosNeedsInstall;
  setTimeout(() => { if (!state.sheetOpen) openSheet(el.alertsSheet); }, 600);
}

async function updateDeviceRow() {
  const iosNeedsInstall = isIos() && !isStandalone();
  el.pDeviceRow.hidden = !pushSupported() && !iosNeedsInstall;
  const sub = await currentPushSubscription();
  const on = !!sub && 'Notification' in window && Notification.permission === 'granted';
  el.pDeviceBtn.textContent = iosNeedsInstall ? 'How to turn on' : on ? 'Alerts on ✓' : 'Turn on alerts';
  el.pDeviceBtn.disabled = on;
}

async function enablePhoneAlerts(opts = {}) {
  const quiet = opts.quiet === true;
  if (isIos() && !isStandalone()) {
    if (!quiet) toast('On iPhone: Share › Add to Home Screen, open Fray from there, then turn alerts on.', { ms: 9000 });
    return;
  }
  if (!pushSupported()) {
    if (!quiet) toast("This browser can't get push alerts. Fray still rings while it's open.");
    return;
  }
  let permission = Notification.permission;
  if (permission === 'default') {
    try { permission = await Notification.requestPermission(); } catch { permission = 'denied'; }
  }
  if (permission !== 'granted') {
    if (!quiet) toast('Notifications are blocked. Allow them for Fray in your browser or phone settings.', { error: true, ms: 7000 });
    updateDeviceRow();
    return;
  }
  try {
    await state.swReady;
    if (!state.swReg) throw new Error('Alerts need the https site (or localhost).');
    let sub = await state.swReg.pushManager.getSubscription();
    if (!sub) {
      sub = await state.swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(VAPID_PUBLIC_KEY) });
    }
    await savePushSubscription(sub);
    if (!quiet) toast('Alerts are on for this device. 🔔');
  } catch (err) {
    console.warn('[Fray] push subscribe failed:', err);
    if (!quiet) toast(`Couldn't turn on alerts: ${err.message || err}`, { error: true });
  }
  updateDeviceRow();
}

async function refreshPushSubscription() {
  const sub = await currentPushSubscription();
  if (sub && Notification.permission === 'granted') {
    savePushSubscription(sub).catch((err) => console.warn('[Fray] push refresh failed:', err));
  }
}

async function savePushSubscription(sub) {
  if (!sb || !state.user) return;
  const json = sub.toJSON();
  const { error } = await sb.rpc('save_push_subscription', {
    p_endpoint: json.endpoint,
    p_p256dh: json.keys.p256dh,
    p_auth: json.keys.auth,
    p_user_agent: navigator.userAgent,
  });
  if (error) throw error;
}

function base64UrlToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Handy for checks in the browser console.
window.fray = { MOODS, state };
