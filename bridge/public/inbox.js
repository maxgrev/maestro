const $ = id => document.getElementById(id);
let next = null, newest = 0, busy = false, selected = 0, opener, items = [], unreadOnly = false;
const node = (tag, text, cls) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (cls) element.className = cls;
  return element;
};
async function api(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (!response.ok) throw new Error('Could not load the inbox. Try again.');
  return response.json();
}
async function status() {
  try {
    const value = await api('/api/inbox/status');
    const unread = value.counts.reduce((count, item) => count + item.unread, 0);
    $('unread').textContent = unread ? `${unread} unread` : '';
    $('connection').textContent = 'Mac connected';
    $('arrivals').textContent = value.latest > newest ? 'New replies available' : '';
    $('warnings').textContent = value.warnings.length ? 'Could not check ' + value.warnings.join(', ') + '. Saved replies are still here.' : '';
  } catch { $('connection').textContent = 'Mac offline'; }
}
function renderItems() {
  const query = $('inbox-search').value.trim().toLocaleLowerCase();
  const visible = items.filter(item => (!unreadOnly || !item.read) && [item.target.name, item.target.detail, item.reply].join(' ').toLocaleLowerCase().includes(query));
  $('replies').replaceChildren();
  for (const item of visible) {
    const button = node('button', undefined, 'inbox-card' + (item.read ? '' : ' unread'));
    button.type = 'button'; button.dataset.reply = item.id;
    const face = node('span', undefined, 'companion ' + (item.target.character || 'pi'));
    face.setAttribute('aria-hidden', 'true');
    const meta = node('span', undefined, 'agent-meta');
    meta.append(node('span', item.target.name, 'agent-name'), node('span', item.reply, 'agent-detail'));
    button.append(face, meta, node('span', item.attention ? 'Needs you' : item.read ? '' : 'Unread', 'receipt-state'));
    button.addEventListener('click', () => void openReply(item, button));
    $('replies').append(button);
  }
  if (!visible.length) {
    const empty = node('div', undefined, 'empty-state');
    const caughtUp = items.length && unreadOnly && !query;
    empty.append(node('h2', caughtUp ? 'No unread replies' : items.length ? 'No matching replies' : 'No replies'));
    if (items.length) {
      const reset = node('button', 'Show all replies', 'text-button');
      reset.onclick = () => { $('inbox-search').value = ''; setFilter(false); $('inbox-search').focus(); };
      empty.append(reset);
    } else {
      const link = node('a', 'Open conversations'); link.href = '/'; empty.append(link);
    }
    $('replies').append(empty);
  }
}
function setFilter(unread) {
  unreadOnly = unread;
  $('filter-all').setAttribute('aria-pressed', String(!unread));
  $('filter-unread').setAttribute('aria-pressed', String(unread));
  renderItems();
}
async function openReply(item, button) {
  selected = item.id; opener = item.id; $('error').textContent = ''; button.disabled = true;
  try {
    const reply = await api('/api/inbox/' + item.id);
    if (selected !== item.id) return;
    $('reply-title').textContent = reply.target.detail || reply.target.name;
    $('reply-meta').textContent = reply.target.name + ' · ' + new Date(reply.created).toLocaleString() + (reply.attention ? ' | Needs you' : '');
    if (reply.replyHtml !== undefined) $('reply-text').innerHTML = reply.replyHtml;
    else $('reply-text').textContent = reply.reply;
    $('inbox-list').hidden = true; $('reader').hidden = false; $('reply-title').focus();
    await api('/api/inbox/ack', { ids: [item.id], kind: 'read' });
    item.read = true;
    void status();
  } catch (error) { $('error').textContent = error.message; }
  finally { button.disabled = false; }
}
async function load(older = false) {
  if (busy) return;
  const focused = document.activeElement;
  busy = true; $('refresh').disabled = true; $('older').disabled = true;
  $('replies').setAttribute('aria-busy', 'true'); $('error').textContent = '';
  try {
    const page = await api('/api/inbox' + (older && next ? '?before=' + next : ''));
    if (!older) { items = []; newest = page.items[0]?.id || 0; }
    const existing = new Set(items.map(item => item.id));
    items.push(...page.items.filter(item => !existing.has(item.id)));
    next = page.next; $('older').hidden = !next; $('arrivals').textContent = '';
    renderItems(); void status();
  } catch (error) {
    $('error').textContent = error.message;
    if (!items.length) $('replies').replaceChildren();
  } finally {
    busy = false; $('refresh').disabled = false; $('older').disabled = false;
    $('replies').setAttribute('aria-busy', 'false');
    if (document.activeElement === document.body && focused?.isConnected && !focused.disabled) focused.focus({ preventScroll: true });
  }
}
$('back').onclick = () => {
  selected = 0; $('reader').hidden = true; $('inbox-list').hidden = false; renderItems();
  const previous = [...$('replies').querySelectorAll('[data-reply]')].find(button => Number(button.dataset.reply) === opener);
  (previous || $('filter-unread')).focus();
};
$('filter-all').onclick = () => setFilter(false);
$('filter-unread').onclick = () => setFilter(true);
$('inbox-search').addEventListener('input', renderItems);
$('refresh').onclick = () => void load(); $('older').onclick = () => void load(true);
void load(); setInterval(() => { if (!document.hidden) void status(); }, 3000);
