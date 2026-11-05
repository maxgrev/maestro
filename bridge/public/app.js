import { showSidebar, syncSidebar } from '/conversation-layout.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
let conversations = [], selected = '', requested = params.get('conversation'), unreadOnly = params.get('filter') === 'unread';
let listBusy = false, listSignature = '', selectedWasUnread = false, epoch = 0, controller, historyBusy = false;
let entries = new Map(), nodes = new Map(), dbCursor = null, nativeCursor = null, loadedOlder = false, historyInitialized = false, nativeBusy = false;
let historyTask = Promise.resolve();
let followRequest, playing, playingUrl, speechController, playingTurn = '', playback = 0;
const sending = new Set(), connecting = new Set(), readIds = new Set(), pendingReads = new Set();
const drafts = new Map();
const states = { ready: 'Connected', busy: 'Working', attention: 'Needs attention', connect: 'Not connected', setup: 'Setup needed', watch: 'On your StopWatch' };
const turnStates = { queued: 'Queued', transcribing: 'Transcribing…', dispatching: 'Sending…', working: 'Working…', uncertain: 'Check delivery', failed: 'Failed', needs_attention: 'Needs your attention' };
function el(tag, text, cls) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || 'Request failed. Try again.'); error.status = response.status; throw error;
  }
  return response.json();
}
function post(path, body, options) { return api(path, { method: 'POST', body: JSON.stringify(body), ...options }); }
function current() { return conversations.find(c => c.id === selected); }
function draft(id) { if (drafts.has(id)) return drafts.get(id); try { return sessionStorage.getItem('maestro-draft:' + id) || ''; } catch { return ''; } }
function saveDraft(id, text) { if (!id) return; drafts.set(id, text); try { if (text) sessionStorage.setItem('maestro-draft:' + id, text); else sessionStorage.removeItem('maestro-draft:' + id); } catch { /* The in-memory draft still survives a conversation switch. */ } }
function url() {
  const next = new URL(location.href); next.search = '';
  if (unreadOnly) next.searchParams.set('filter', 'unread');
  if (selected) next.searchParams.set('conversation', selected);
  history.replaceState(null, '', next);
}
function shortTime(value) {
  const date = new Date(value), today = new Date();
  return date.toDateString() === today.toDateString() ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function preview(text) {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1').replace(/^\s*(?:#{1,6}\s+|[-*]\s+)/gm, '').replace(/\s+/g, ' ');
}
function renderList() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const unread = conversations.filter(c => !c.id.startsWith('new:') && c.unread > 0).length;
  $('unread-count').textContent = unread || '';
  $('filter-all').setAttribute('aria-pressed', String(!unreadOnly));
  $('filter-unread').setAttribute('aria-pressed', String(unreadOnly));
  const visible = conversations.filter(c => !c.id.startsWith('new:') && (!unreadOnly || c.unread || c.id === selected && selectedWasUnread)
    && [c.title, c.agent, c.preview].join(' ').toLocaleLowerCase().includes(query));
  const signature = JSON.stringify([visible, selected, unreadOnly, query]);
  if (signature === listSignature) return; listSignature = signature;
  const focused = document.activeElement?.dataset.conversation, scroll = $('conversations').scrollTop;
  $('conversations').replaceChildren();
  for (const c of visible) {
    const item = el('div'); item.setAttribute('role', 'listitem');
    const row = el('button', undefined, 'conversation-row' + (c.unread ? ' unread' : '')); row.type = 'button';
    row.dataset.conversation = c.id; row.setAttribute('aria-current', String(c.id === selected));
    const character = el('span', undefined, 'companion ' + (c.character || 'pi')); character.setAttribute('aria-hidden', 'true');
    const copy = el('span', undefined, 'conversation-copy'); copy.append(el('span', c.title, 'conversation-name'));
    if (c.title !== c.agent) copy.append(el('span', c.agent, 'conversation-agent'));
    copy.append(el('span', preview(c.preview) || (c.connection === 'ready' ? 'Send a message' : states[c.connection]), 'conversation-preview'));
    const end = el('span', undefined, 'conversation-row-end');
    if (c.updated) end.append(el('time', shortTime(c.updated)));
    if (c.unread) { const count = el('span', String(c.unread), 'unread-mark'); count.setAttribute('aria-label', c.unread + ' unread'); end.append(count); }
    if (c.connection === 'busy' || c.attention) end.append(el('span', c.connection === 'busy' ? 'Working' : 'Needs you', 'conversation-state'));
    row.append(character, copy, end); row.onclick = () => choose(c.id, true); item.append(row); $('conversations').append(item);
  }
  if (!visible.length) {
    const empty = el('div', undefined, 'empty-state');
    empty.append(el('h2', query ? 'No matching conversations' : unreadOnly ? 'No unread conversations' : 'No conversations yet'));
    if (query || unreadOnly) { const reset = el('button', 'Show all', 'text-button'); reset.onclick = () => { $('search').value = ''; setFilter(false); }; empty.append(reset); }
    else { const start = el('button', 'New conversation', 'text-button'); start.onclick = openNew; empty.append(start); }
    $('conversations').append(empty);
  }
  $('conversations').scrollTop = scroll;
  if (focused) [...$('conversations').querySelectorAll('button')].find(row => row.dataset.conversation === focused)?.focus({ preventScroll: true });
}
function renderConnection() {
  const c = current(), busy = sending.has(selected) || followRequest?.conversation === selected, isConnecting = connecting.has(selected);
  $('no-selection').hidden = !!c;
  for (const id of ['thread-header', 'history-scroll', 'reply-area']) $(id).hidden = !c;
  if (!c) return;
  $('thread-title').textContent = c.title;
  $('thread-meta').textContent = (c.title !== c.agent ? c.agent + ' · ' : '') + (c.id.startsWith('new:') && c.connection === 'ready' ? 'Ready to start' : states[c.connection]);
  $('thread-character').className = 'companion ' + (c.character || 'pi');
  $('recipient').textContent = 'Reply to ' + c.agent;
  $('message').placeholder = c.id.startsWith('new:') ? 'Message…' : 'Reply…';
  $('message').disabled = c.connection === 'watch';
  $('send').disabled = c.connection !== 'ready' || busy || !c.target?.available || !$('message').value.trim();
  $('send').textContent = busy ? 'Sending…' : 'Send';
  $('send-hint').textContent = c.connection === 'ready' ? '⌘ Return to send' : '';
  $('reply-connection').hidden = c.connection === 'ready';
  const canConnect = c.connection === 'connect' && /^(codex|claude|pi):/.test(c.id);
  $('connect-session').hidden = !canConnect && c.connection !== 'attention';
  $('connect-session').disabled = isConnecting;
  $('connect-session').textContent = isConnecting ? 'Connecting…' : c.connection === 'attention' ? 'Open session' : 'Connect session';
  $('setup-agent').hidden = !['connect', 'setup'].includes(c.connection);
  const copy = {
    busy: ['Agent is working', 'You can draft your next reply while you wait.'],
    attention: ['Continue on your Mac', c.agent + ' needs your attention in its session before it can continue.'],
    connect: ['Connect this session to reply', 'Your history is saved. Connecting opens this ' + c.agent + ' session on your Mac.'],
    setup: ['Connect ' + c.agent + ' to reply', c.target?.status === 'Sign in on Mac' ? 'Sign in from Agent setup, then return to this conversation.' : 'Check this agent’s connection in Agent setup.'],
    watch: ['Reply from your StopWatch', 'Muse messages can be read here. Replies go through your StopWatch.'],
    ready: ['', ''],
  }[c.connection];
  $('reply-state').textContent = copy[0]; $('reply-help').textContent = copy[1];
  if (c.connection === 'connect' && !canConnect) $('reply-help').textContent = 'Reconnect this agent in Agent setup to reply. Your saved messages stay here.';
}
function choose(id, focus = false) {
  if (selected !== id) {
    saveDraft(selected, $('message').value); selected = id; epoch++; controller?.abort(); controller = new AbortController();
    stopSpeech(); reads.disconnect(); entries = new Map(); nodes = new Map(); $('history').replaceChildren();
    dbCursor = nativeCursor = null; loadedOlder = historyInitialized = historyBusy = nativeBusy = false;
    $('history-status').textContent = 'Loading messages…'; $('error').textContent = ''; $('older').hidden = true;
    selectedWasUnread = !!current()?.unread; $('message').value = draft(id);
    void loadHistory();
    if (/^(codex|claude|pi):/.test(id)) void syncNative();
  }
  if (focus) document.body.dataset.threadOpen = 'true';
  renderList(); renderConnection(); syncSidebar(); url();
  if (focus) $('thread-title').focus({ preventScroll: true });
}
function setFilter(unread) {
  unreadOnly = unread; selectedWasUnread = !!current()?.unread;
  showSidebar(); renderList(); url();
}
const reads = new IntersectionObserver(events => {
  if (document.visibilityState !== 'visible') return;
  for (const event of events) if (event.isIntersecting) void acknowledge(event.target);
}, { root: $('history-scroll'), threshold: 0 });
async function acknowledge(element) {
  const ids = JSON.parse(element.dataset.receipts || '[]').filter(id => !readIds.has(id) && !pendingReads.has(id));
  if (!ids.length || document.visibilityState !== 'visible') return;
  for (const id of ids) pendingReads.add(id);
  try {
    for (let offset = 0; offset < ids.length; offset += 64) await post('/api/inbox/ack', { ids: ids.slice(offset, offset + 64), kind: 'read' });
    for (const id of ids) readIds.add(id);
    void refresh();
  } catch { /* Retry only when the answer is visible again. */ }
  finally { for (const id of ids) pendingReads.delete(id); }
}
function renderEntry(entry, c) {
  const card = el('article', undefined, 'exchange'); card.dataset.entry = entry.id;
  if (entry.text) card.append(el('div', entry.text, 'message message-user'));
  if (entry.reply) {
    const answer = el('div', undefined, 'message message-assistant');
    const meta = el('div', undefined, 'message-meta'), time = el('time', shortTime(entry.updated));
    time.dateTime = new Date(entry.updated).toISOString(); time.title = new Date(entry.updated).toLocaleString();
    meta.append(el('span', c.agent), time);
    const text = el('div', undefined, 'markdown'); if (entry.replyHtml !== undefined) text.innerHTML = entry.replyHtml; else text.textContent = entry.reply;
    const actions = el('div', undefined, 'message-actions'), listenButton = el('button', 'Listen', 'listen'); listenButton.type = 'button';
    listenButton.dataset.voice = entry.id; listenButton.onclick = () => listen(entry.reply, listenButton, entry.id);
    actions.append(listenButton); answer.append(meta, text, actions); card.append(answer);
  }
  if (entry.error) card.append(el('p', entry.error, 'error'));
  else if (turnStates[entry.state]) card.append(el('p', turnStates[entry.state], 'turn-state' + (['needs_attention', 'uncertain', 'failed'].includes(entry.state) ? ' attention' : '')));
  if (entry.output) { const details = el('details'), summary = el('summary', 'Terminal output'); details.append(summary, el('pre', entry.output)); card.append(details); }
  return card;
}
function renderHistory(older = false, previousHeight = 0, previousTop = 0, stick = false) {
  const c = current(); if (!c) return;
  const sorted = [...entries.values()].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  const history = $('history'); reads.disconnect();
  history.querySelector('[data-empty]')?.remove();
  for (let index = 0; index < sorted.length; index++) {
    const entry = sorted[index], signature = JSON.stringify([entry.text, entry.reply, entry.output, entry.error, entry.state, entry.updated]);
    let record = nodes.get(entry.id);
    if (!record || record.signature !== signature) {
      const node = renderEntry(entry, c); if (record) record.node.replaceWith(node);
      record = { node, signature }; nodes.set(entry.id, record);
    }
    if (history.children[index] !== record.node) history.insertBefore(record.node, history.children[index] || null);
    const answer = record.node.querySelector('.message-assistant') || record.node;
    answer.dataset.receipts = JSON.stringify(entry.receipts); if (entry.receipts.length) reads.observe(answer);
  }
  if (!sorted.length) {
    const empty = el('div', undefined, 'empty-state'); empty.dataset.empty = 'true';
    empty.append(el('h3', c.id.startsWith('new:') ? 'Start a conversation' : 'No messages yet'));
    if (c.connection === 'ready') empty.append(el('p', 'Send a message below.'));
    history.append(empty);
  }
  $('older').hidden = !dbCursor && !nativeCursor;
  const scroll = $('history-scroll');
  if (older) scroll.scrollTop = previousTop + scroll.scrollHeight - previousHeight;
  else if (stick) scroll.scrollTop = scroll.scrollHeight;
}
async function loadHistory(older = false, cursor) {
  if (!selected || historyBusy) return;
  const ticket = epoch, id = selected, scroll = $('history-scroll');
  const previousHeight = scroll.scrollHeight, previousTop = scroll.scrollTop;
  const stick = !historyInitialized || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  historyBusy = true; $('older').disabled = true;
  try {
    const query = new URLSearchParams({ id }); if (older && (cursor || dbCursor)) query.set('before', cursor || dbCursor);
    historyTask = api('/api/conversations/history?' + query, { signal: controller.signal });
    const page = await historyTask;
    if (ticket !== epoch) return;
    for (const entry of page.entries) entries.set(entry.id, entry);
    if (older || !loadedOlder) dbCursor = page.next;
    if (older) loadedOlder = true;
    historyInitialized = true; $('history-status').textContent = nativeBusy ? 'Loading earlier history…' : '';
    renderHistory(older, previousHeight, previousTop, stick);
  } catch (error) { if (ticket === epoch && error.name !== 'AbortError') $('history-status').textContent = error.message; }
  finally { if (ticket === epoch) { historyBusy = false; $('older').disabled = false; } }
}
async function syncNative(cursor) {
  if (nativeBusy || !selected) return;
  const ticket = epoch, id = selected; nativeBusy = true;
  const first = [...entries.values()].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))[0];
  const before = first && btoa(JSON.stringify({ created: first.created, id: first.id }));
  try {
    const result = await post('/api/conversations/sync', { id, ...(cursor ? { cursor } : {}) }, { signal: controller.signal });
    if (ticket !== epoch) return;
    nativeCursor = result.next;
    nativeBusy = false;
    await historyTask.catch(() => {}); if (ticket !== epoch) return;
    await loadHistory(!!cursor, cursor ? before : undefined);
    if (result.warning) $('history-status').textContent = result.warning;
    void refresh();
  } catch (error) { if (ticket === epoch && error.name !== 'AbortError') $('history-status').textContent = 'Earlier messages could not be loaded. Your saved messages are still here.'; }
  finally { if (ticket === epoch) { nativeBusy = false; $('older').disabled = false; $('older').hidden = !dbCursor && !nativeCursor; } }
}
async function refresh() {
  if (listBusy) return; listBusy = true; $('refresh').disabled = true;
  try {
    const value = await api('/api/conversations'); conversations = value.conversations;
    $('connection').textContent = 'Mac connected'; $('list-error').textContent = '';
    $('conversations').setAttribute('aria-busy', 'false');
    const warnings = [...new Set(value.warnings)]; $('warnings').hidden = !warnings.length;
    $('warning-text').replaceChildren(...warnings.map(w => el('p', w)));
    if (followRequest && selected === followRequest.conversation) {
      const turn = await api('/api/turns/' + followRequest.id);
      const actual = turn.target.session || turn.target.id;
      if (actual !== selected && conversations.some(c => c.id === actual)) {
        const previous=selected,unsent=$('message').value;
        if (unsent&&!draft(actual)) saveDraft(actual,unsent);
        choose(actual,true);saveDraft(previous,'');followRequest=null;
      }
    }
    if (requested) { if (conversations.some(c => c.id === requested)) choose(requested, true); requested = null; }
    if (!selected && matchMedia('(min-width: 761px)').matches) {
      const first = conversations.find(c => !c.id.startsWith('new:') && (!unreadOnly || c.unread)); if (first) choose(first.id);
    }
    renderList(); renderConnection();
    if (params.has('new')) { params.delete('new'); openNew(); url(); }
    if (selected) await loadHistory();
  } catch (error) { $('connection').textContent = 'Mac offline'; $('list-error').textContent = error.message; $('conversations').setAttribute('aria-busy', 'false'); }
  finally { listBusy = false; $('refresh').disabled = false; }
}
$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  const c = current(), raw = $('message').value, text = raw.trim();
  if (!c || !c.target?.available || c.connection !== 'ready' || sending.has(c.id) || !text) return;
  const origin = c.id, id = crypto.randomUUID(); sending.add(origin); renderConnection(); $('error').textContent = '';
  if (origin.startsWith('new:')) followRequest = { id, conversation: origin };
  let accepted = false;
  try { await post('/api/turns', { id, target: c.target.id, text }); accepted = true; }
  catch (error) {
    if (!error.status || error.status >= 500) {
      try { accepted = !!(await api('/api/turns/' + id)); } catch { /* Never replay an uncertain request. */ }
    }
    if (!accepted && selected === origin) $('error').textContent = error.status && error.status < 500 ? error.message
      : error.message + ' Check the conversation before sending again; delivery may be unclear.';
    if (!accepted) followRequest = null;
  } finally {
    sending.delete(origin);
    if (accepted) {
      if (draft(origin) === raw) saveDraft(origin, '');
      if (selected === origin && $('message').value === raw) { $('message').value = ''; saveDraft(origin, ''); }
      if (selected === origin) $('history-scroll').scrollTop = $('history-scroll').scrollHeight;
    }
    renderConnection(); await refresh();
  }
});
$('message').addEventListener('input', () => { saveDraft(selected, $('message').value); renderConnection(); });
$('message').addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !$('send').disabled) { event.preventDefault(); $('composer').requestSubmit(); }
});
$('connect-session').onclick = async () => {
  const c = current(); if (!c || connecting.has(c.id)) return;
  const origin = c.id; connecting.add(origin); renderConnection(); $('error').textContent = '';
  try {
    await post(c.connection === 'attention' ? '/api/conversations/focus' : '/api/conversations/connect', { id: origin });
    await refresh(); if (selected === origin) $('message').focus();
  } catch (error) { if (selected === origin) $('error').textContent = error.message; }
  finally { connecting.delete(origin); renderConnection(); }
};
function openNew() {
  $('new-targets').replaceChildren();
  const choices = conversations.filter(c => c.id.startsWith('new:') || !c.updated && ['dot', 'grok'].includes(c.id));
  for (const c of choices) {
    const button = el('button', c.agent, 'new-target'); button.type = 'button';
    const project = c.title !== c.agent ? c.title : c.target?.project;
    if (project) button.append(el('span', project));
    button.onclick = () => { $('new-dialog').close(); choose(c.id, true); $('message').focus(); };
    $('new-targets').append(button);
  }
  if (!choices.length) $('new-targets').append(el('p', 'Connect an agent and choose a project in Setup.'));
  if (!$('new-dialog').open) $('new-dialog').showModal();
}
$('new-conversation').onclick = openNew;
window.addEventListener('maestro:new-conversation', openNew);
$('new-dialog').addEventListener('click', event => { if (event.target === $('new-dialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
$('older').onclick = () => { if (dbCursor) void loadHistory(true); else if (nativeCursor) void syncNative(nativeCursor); };
$('back').onclick = () => { showSidebar(); ([...$('conversations').querySelectorAll('button')].find(row => row.dataset.conversation === selected) || $('search')).focus(); };
$('filter-all').onclick = () => setFilter(false); $('filter-unread').onclick = () => setFilter(true);
$('search').addEventListener('input', renderList); $('refresh').onclick = () => { void refresh(); if (/^(codex|claude|pi):/.test(selected)) void syncNative(); };
$('conversations').addEventListener('keydown', event => {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !event.target.matches('[data-conversation]')) return;
  const rows = [...$('conversations').querySelectorAll('[data-conversation]')], index = rows.indexOf(event.target);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
  event.preventDefault(); rows[next]?.focus(); if (rows[next]) choose(rows[next].dataset.conversation);
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === '2') { event.preventDefault(); setFilter(true); $('search').focus(); }
  if ((event.metaKey || event.ctrlKey) && event.key === 'f') { event.preventDefault(); showSidebar(); $('search').focus(); }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'n') { event.preventDefault(); openNew(); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { for (const node of $('history').querySelectorAll('[data-receipts]')) { reads.unobserve(node); reads.observe(node); } void refresh(); } });
window.addEventListener('pagehide', () => { saveDraft(selected, $('message').value); stopSpeech(); controller?.abort(); });
function pcmWav(pcm) {
  const bytes = new Uint8Array(44 + pcm.byteLength), view = new DataView(bytes.buffer);
  const str = (offset, text) => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i); };
  str(0, 'RIFF'); view.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, pcm.byteLength, true); bytes.set(new Uint8Array(pcm), 44); return bytes;
}
function stopSpeech() {
  playback++; speechController?.abort(); speechController = null;
  if (playing) { playing.pause(); playing = null; } if (playingUrl) { URL.revokeObjectURL(playingUrl); playingUrl = null; }
  document.querySelectorAll('[data-voice]').forEach(button => { button.textContent = 'Listen'; }); playingTurn = '';
}
async function listen(text, button, id) {
  const stop = playingTurn === id; stopSpeech(); if (stop) return;
  playingTurn = id; const generation = playback; speechController = new AbortController(); button.textContent = 'Cancel voice';
  try {
    const response = await fetch('/api/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, format: 'pcm' }), signal: speechController.signal });
    if (!response.ok) throw new Error('Speech is unavailable. The text is still here.');
    const pcm = await response.arrayBuffer(); if (generation !== playback) return;
    playingUrl = URL.createObjectURL(new Blob([pcmWav(pcm)], { type: 'audio/wav' })); playing = new Audio(playingUrl);
    playing.onended = () => { if (generation === playback) stopSpeech(); };
    playing.onerror = () => { if (generation === playback) { $('error').textContent = 'Playback stopped. The text is still here.'; stopSpeech(); } };
    button.textContent = 'Stop'; await playing.play();
  } catch (error) { if (generation === playback) { if (error.name !== 'AbortError') $('error').textContent = error.message; stopSpeech(); } }
}
void refresh(); setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
