// app.js — the Audition Booth, in a browser.
// Started as Porkchop's desktop booth (a Pulse household tool); same idea, for anyone's chats.
'use strict';

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CHAR_BUDGET = 200000;           // ~50k tokens of conversation at most; the oldest messages go first
const MAX_ANSWER = 1200;              // tokens per answer
const PARALLEL = 4;

const S = { convs: [], speakers: {}, images: [], models: [], catalog: null, session: null, sel: 0, running: false };

// ------------------------------------------------------------------ remembering things (this device only)

const store = {
  get(k, d) { try { const v = localStorage.getItem('booth.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('booth.' + k, JSON.stringify(v)); } catch (e) { /* private window or full: fine */ } },
  del(k) { try { localStorage.removeItem('booth.' + k); } catch (e) {} },
  clear() { try { Object.keys(localStorage).filter(k => k.startsWith('booth.')).forEach(k => localStorage.removeItem(k)); } catch (e) {} },
};

// results can be big (whole conversations), so they live in IndexedDB
const IDB = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    try {
      const r = indexedDB.open('audition-booth', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode), req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error);
    });
  };
  return {
    get: k => tx('readonly', s => s.get(k)).catch(() => null),
    put: (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => null),
    clear: () => tx('readwrite', s => s.clear()).catch(() => null),
  };
})();

const FIELDS = ['their-name', 'your-name', 'persona', 'memories', 'vision-model', 'my-side', 'n-moments', 'depth', 'since', 'until'];
function saveSetup() {
  const v = {};
  FIELDS.forEach(id => { v[id] = $(id).value; });
  v.blind = $('blind').checked;
  v.models = S.models.map(m => ({ ...m, key: m.custom && $('remember-key').checked ? m.key : (m.custom ? '' : null) }));
  store.set('setup', v);
  if ($('remember-key').checked) store.set('key', $('key').value.trim()); else store.del('key');
}
let saveT = 0;
const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(saveSetup, 400); };

function loadSetup() {
  const v = store.get('setup', null);
  if (v) {
    FIELDS.forEach(id => { if (v[id] != null) $(id).value = v[id]; });
    $('blind').checked = !!v.blind;
    S.models = (v.models || []).filter(m => m && m.model);
  }
  const key = store.get('key', '');
  if (key) { $('key').value = key; $('remember-key').checked = true; }
}

let sessionT = 0;
function saveSession() { clearTimeout(sessionT); sessionT = setTimeout(() => { if (S.session && !S.session.example) IDB.put('session', S.session); }, 500); }

// ------------------------------------------------------------------ names and the persona

const theirName = () => $('their-name').value.trim() || 'your companion';
const yourName = () => $('your-name').value.trim() || 'you';

function systemPrompt() {
  const them = $('their-name').value.trim(), you = $('your-name').value.trim();
  let t = $('persona').value.trim();
  if (!t) t = `You are ${them || 'a companion'}${you ? `, talking with ${you}` : ''}.`;
  t = t.replace(/\{\{char\}\}|<BOT>|\{name\}/gi, them || 'you').replace(/\{\{user\}\}|<USER>|\{user_name\}|\{user\}/gi, you || 'them');
  const mem = $('memories').value.trim();
  if (mem) t += '\n\n## Things you remember\n' + mem;
  return t;
}

// ------------------------------------------------------------------ your chats

function note(text) { const li = document.createElement('li'); li.textContent = text; $('notes').append(li); }

async function addFiles(list) {
  if (!list.length) return;
  $('notes').innerHTML = '';
  const out = { conversations: [], images: [], personas: [], notes: [] };
  for (const f of list) await Parse.file(f, out);
  // skip anything that's already here (the same file added twice)
  const sig = c => `${c.source}|${c.title}|${c.messages.length}|${(c.messages[0] || {}).text}`;
  const have = new Set(S.convs.map(sig));
  const fresh = out.conversations.filter(c => c.messages.length && !have.has(sig(c)));
  fresh.forEach(c => { c.include = true; });
  S.convs = Parse.mergeSameTitle([...S.convs, ...fresh]);
  out.notes.forEach(note);
  if (out.conversations.length && !fresh.length) note('Those chats are already added.');
  for (const p of out.personas) {
    if (!$('persona').value.trim() || confirm(`Use the persona from ${p.name || 'this character card'}? It replaces what's in step 1.`)) {
      $('persona').value = p.persona;
      if (p.name && !$('their-name').value.trim()) $('their-name').value = p.name;
    }
  }
  if (out.images.length) {
    S.images.push(...out.images);
    S.images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }
  autoSpeakers();
  renderChats();
  saveSetup();
}

// for chats that only have names: guess who's who (the user can change it)
function autoSpeakers() {
  const stats = {};
  for (const c of S.convs) for (const m of c.messages) {
    if (m.role || S.speakers[m.who]) continue;
    const s = stats[m.who] || (stats[m.who] = { n: 0, len: 0 });
    s.n++; s.len += m.text.length;
  }
  const names = Object.keys(stats);
  if (!names.length) return;
  const them = $('their-name').value.trim().toLowerCase(), you = $('your-name').value.trim().toLowerCase();
  const left = [];
  for (const n of names) {
    const l = n.toLowerCase();
    if (them && (l === them || l.startsWith(them + ' '))) S.speakers[n] = 'assistant';
    else if (you && (l === you || l.startsWith(you + ' '))) S.speakers[n] = 'user';
    else if (['me', 'you', 'i'].includes(l)) S.speakers[n] = 'user';
    else if (l === 'them') S.speakers[n] = 'assistant';
    else left.push(n);
  }
  const taken = r => Object.values(S.speakers).includes(r);
  // companions usually write longer messages than we do
  left.sort((a, b) => stats[b].len / stats[b].n - stats[a].len / stats[a].n);
  for (const n of left) {
    if (stats[n].n < 2 && left.length > 2) S.speakers[n] = 'skip';
    else if (!taken('assistant')) S.speakers[n] = 'assistant';
    else if (!taken('user')) S.speakers[n] = 'user';
    else S.speakers[n] = 'skip';
  }
}

// a conversation as the models see it: you and them, taking turns
function finalMessages(c) {
  const out = [];
  for (const m of c.messages) {
    const role = m.role || S.speakers[m.who] || 'skip';
    if (role === 'skip' || !m.text) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) { last.content += '\n' + m.text; continue; }
    out.push({ role, content: m.text, time: m.time });
  }
  return out;
}

const SKIP = /^\s*(\{|\[(Heartbeat|Scheduled|System|Tool)\b)/i;
function allMoments() {
  const since = $('since').value, until = $('until').value, out = [];
  for (const c of S.convs) {
    if (!c.include) continue;
    const ms = finalMessages(c);
    for (let i = 1; i < ms.length; i++) {
      const m = ms[i], prev = ms[i - 1];
      if (m.role !== 'assistant' || prev.role !== 'user') continue;
      if (m.content.length < 60 || m.content.length > 4000 || prev.content.trim().length < 4) continue;
      if (SKIP.test(m.content) || SKIP.test(prev.content)) continue;
      const day = (m.time || '').slice(0, 10);
      if (day && ((since && day < since) || (until && day > until))) continue;
      out.push({ c, ms, i });
    }
  }
  return out;
}

function contextFor(ms, i, depth) {
  const perMsg = depth <= 11 ? 2000 : 8000;
  const ctx = ms.slice(Math.max(0, i - depth), i).map(x => ({ role: x.role, content: x.content.slice(0, perMsg) }));
  let total = ctx.reduce((s, x) => s + x.content.length, 0);
  while (ctx.length > 1 && total > CHAR_BUDGET) total -= ctx.shift().content.length;
  while (ctx.length > 1 && ctx[0].role !== 'user') ctx.shift();     // start on your turn, like a real conversation
  return ctx;
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function pickMoments(n, depth) {
  // longer replies first (they show a voice best), and spread over different chats
  const pool = shuffle(allMoments()).sort((a, b) => (b.ms[b.i].content.length >= 150) - (a.ms[a.i].content.length >= 150));
  const picked = [], used = new Set();
  for (const pass of [0, 1]) for (const p of pool) {
    if (picked.length >= n) break;
    if (picked.includes(p) || (pass === 0 && used.has(p.c))) continue;
    picked.push(p); used.add(p.c);
  }
  return picked.map((p, k) => ({
    id: 'm' + (k + 1), title: p.c.title, source: p.c.source, when: (p.ms[p.i].time || '').slice(0, 10),
    context: contextFor(p.ms, p.i, depth), real: p.ms[p.i].content,
  }));
}

function renderChats() {
  const found = S.convs.length > 0;
  $('found').hidden = !found;
  $('shots-box').hidden = !S.images.length;
  renderShots();
  if (found) {
    const q = $('conv-filter').value.trim().toLowerCase();
    const inc = S.convs.filter(c => c.include).length;
    $('found-title').textContent = `${S.convs.length} chat${S.convs.length === 1 ? '' : 's'} found (${inc} included)`;
    $('convs').innerHTML = S.convs.filter(c => !q || c.title.toLowerCase().includes(q)).map(c =>
      `<label><input type="checkbox" data-c="${c.id}" ${c.include ? 'checked' : ''}><span class="t">${esc(c.title)}</span><span class="tag">${esc(c.source)}</span><span class="c">${c.messages.length} msg${c.messages.length === 1 ? '' : 's'}</span></label>`).join('');
    // who's who, for chats that only have names
    const counts = {};
    for (const c of S.convs) for (const m of c.messages) if (!m.role) counts[m.who] = (counts[m.who] || 0) + 1;
    const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    $('who-box').hidden = !names.length;
    $('who').innerHTML = names.map(n => `<span>${esc(n)}</span><span class="dim small">${counts[n]} msg${counts[n] === 1 ? '' : 's'}</span>
      <select data-who="${esc(n)}"><option value="assistant" ${S.speakers[n] === 'assistant' ? 'selected' : ''}>That's them</option><option value="user" ${S.speakers[n] === 'user' ? 'selected' : ''}>That's me</option><option value="skip" ${S.speakers[n] === 'skip' ? 'selected' : ''}>Leave out</option></select>`).join('');
    const n = allMoments().length;
    const mc = $('moment-count');
    mc.className = n ? 'good' : 'notes';
    mc.innerHTML = n ? `<b>${n.toLocaleString()} moments</b> to choose from: places where you said something and ${esc(theirName())} answered.`
      : `<li>No moments yet. A moment is a message from you followed by an answer from them (at least a sentence or two long). ${names.length ? 'Check who’s who above.' : ''} ${$('since').value || $('until').value ? 'The dates in step 3 might be leaving them out.' : ''}</li>`;
  }
  estimate();
}

// ------------------------------------------------------------------ screenshots

function renderShots() {
  const box = $('shots');
  box.querySelectorAll('img').forEach(i => URL.revokeObjectURL(i.src));
  box.innerHTML = S.images.map((f, i) => `<figure><img alt="" data-i="${i}"><figcaption>${i + 1}</figcaption></figure>`).join('');
  box.querySelectorAll('img').forEach(img => { img.src = URL.createObjectURL(S.images[+img.dataset.i]); });
}

async function imageData(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1100 / bmp.width, 2600 / bmp.height);
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', 0.85);
}

const SHOT_PROMPT = 'This is a screenshot of a chat between two people. Type out every message bubble you can see, from top to bottom, exactly as written (keep emoji and line breaks). Say which side of the screen each bubble is on. Skip timestamps, read receipts, the app\'s header, names above bubbles, and the keyboard. If a bubble is cut off at the top or bottom edge, include the part you can see. Answer with JSON only, like this: {"messages":[{"side":"left","text":"..."},{"side":"right","text":"..."}]}';

function looseJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON in the answer');
  return JSON.parse(text.slice(a, b + 1));
}
const norm = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
const same = (a, b) => { const x = norm(a), y = norm(b); return x === y || (x.length > 12 && y.length > 12 && (x.includes(y) || y.includes(x))); };

async function readShots() {
  const key = $('key').value.trim();
  if (!key) { $('shots-status').textContent = 'Add your OpenRouter key in step 3 first. Reading screenshots costs a fraction of a cent each.'; $('key').focus(); return; }
  const btn = $('shots-read'); btn.disabled = true;
  const mine = $('my-side').value, you = $('your-name').value.trim() || 'Me', them = $('their-name').value.trim() || 'Them';
  const cand = { url: OR_URL, model: $('vision-model').value.trim() || 'google/gemini-2.5-flash' };
  let all = [], cost = 0;
  try {
    for (let i = 0; i < S.images.length; i++) {
      $('shots-status').textContent = `Reading screenshot ${i + 1} of ${S.images.length}...`;
      const url = await imageData(S.images[i]);
      const a = await chat(cand, [{ role: 'user', content: [{ type: 'text', text: SHOT_PROMPT }, { type: 'image_url', image_url: { url } }] }], { max_tokens: 4000, temperature: 0 });
      cost += a.cost || 0;
      const got = (looseJson(a.text).messages || []).filter(m => m && m.text);
      // screenshots usually overlap: drop the messages this one repeats from the last one
      let k = Math.min(all.length, got.length);
      for (; k > 0; k--) if (got.slice(0, k).every((m, j) => same(m.text, all[all.length - k + j].text))) break;
      all.push(...got.slice(k));
    }
    const text = all.map(m => `${m.side === mine ? you : them}: ${String(m.text).trim()}`).join('\n');
    S.speakers[you] = S.speakers[you] || 'user'; S.speakers[them] = S.speakers[them] || 'assistant';
    $('paste').value = ($('paste').value.trim() ? $('paste').value.trim() + '\n' : '') + text;
    $('paste-box').open = true;
    $('shots-status').textContent = `Done: ${all.length} messages${cost ? ` (cost $${cost.toFixed(4)})` : ''}. Check them in the box below, fix anything it misread, then press "Add this conversation".`;
    $('paste').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    $('shots-status').textContent = `That didn't work: ${e.message}`;
  }
  btn.disabled = false;
}

// ------------------------------------------------------------------ models

async function catalog() {
  if (S.catalog) return S.catalog;
  const r = await fetch('https://openrouter.ai/api/v1/models');
  const j = await r.json();
  S.catalog = (j.data || []).map(m => ({
    id: m.id, name: m.name || m.id, ctx: m.context_length || 0,
    prompt: +(m.pricing && m.pricing.prompt) || 0, completion: +(m.pricing && m.pricing.completion) || 0,
  })).filter(m => m.prompt >= 0 && m.completion >= 0);
  return S.catalog;
}
const perM = v => v === 0 ? 'free' : '$' + (v * 1e6 >= 10 ? (v * 1e6).toFixed(0) : (v * 1e6).toFixed(2).replace(/\.?0+$/, ''));
const priceText = m => m.custom ? 'your server' : (m.prompt === 0 && m.completion === 0 ? 'free' : `${perM(m.prompt)} in / ${perM(m.completion)} out per M`);

let hl = -1;
async function searchModels() {
  const q = $('model-search').value.trim().toLowerCase(), box = $('model-results');
  if (!q) { box.hidden = true; return; }
  let list;
  try { list = await catalog(); } catch (e) { box.hidden = false; box.innerHTML = `<p class="hint" style="padding:8px 12px">Couldn't load the model list (${esc(e.message)}). You can still type a model ID and press Enter.</p>`; return; }
  const words = q.split(/\s+/);
  const hits = list.filter(m => words.every(w => (m.id + ' ' + m.name).toLowerCase().includes(w))).slice(0, 40);
  hl = -1;
  box.hidden = false;
  box.innerHTML = hits.length ? hits.map((m, i) => `<button data-id="${esc(m.id)}" data-i="${i}"><span>${esc(m.name)}<br><span class="p">${esc(m.id)}</span></span><span class="p">${priceText(m)}</span></button>`).join('')
    : `<p class="hint" style="padding:8px 12px">No matches. Press Enter to add "${esc(q)}" as a model ID anyway.</p>`;
}

function addModel(id) {
  id = id.trim();
  if (!id || S.models.some(m => !m.custom && m.model === id)) return;
  const c = (S.catalog || []).find(m => m.id === id);
  S.models.push({ label: id, url: OR_URL, model: id, key: null, prompt: c ? c.prompt : null, completion: c ? c.completion : null, ctx: c ? c.ctx : 0 });
  $('model-search').value = ''; $('model-results').hidden = true;
  renderModels(); saveSetup();
}

function renderModels() {
  $('chips').innerHTML = S.models.map((m, i) => `<span class="chip"><span>${esc(m.label)}</span><small>${priceText(m)}</small><button class="x" data-rm="${i}" aria-label="Remove ${esc(m.label)}">&#10005;</button></span>`).join('');
  estimate();
}

// ------------------------------------------------------------------ what a run will cost

function estimate() {
  const el = $('estimate'), run = $('run');
  const pool = S.convs.length ? allMoments() : [];
  const n = Math.min(+$('n-moments').value, pool.length), depth = +$('depth').value;
  if (!pool.length || !S.models.length) {
    el.textContent = !pool.length ? 'Add your chats in step 2 to see what a run will cost.' : 'Add at least one model to see what a run will cost.';
    run.disabled = true; return;
  }
  // sample the moments to guess how much each audition reads
  const sample = pool.slice(0, 150), sys = systemPrompt().length;
  const avgIn = sample.reduce((s, p) => s + contextFor(p.ms, p.i, depth).reduce((t, x) => t + x.content.length, 0), 0) / sample.length;
  const avgOut = sample.reduce((s, p) => s + p.ms[p.i].content.length, 0) / sample.length;
  const tin = Math.round((sys + avgIn) / 4) + 20, tout = Math.round(Math.min(avgOut / 4 + 60, MAX_ANSWER));
  let cost = 0, unknown = [], tooBig = [];
  for (const m of S.models) {
    if (m.prompt == null) { if (!m.custom) unknown.push(m.label); continue; }
    cost += n * (tin * m.prompt + tout * m.completion);
    if (m.ctx && tin + MAX_ANSWER > m.ctx) tooBig.push(m.label);
  }
  const total = n * S.models.length;
  const money = cost < 0.01 ? 'less than a cent' : 'about $' + cost.toFixed(2);
  el.innerHTML = `<b>${n} moment${n === 1 ? '' : 's'} &times; ${S.models.length} model${S.models.length === 1 ? '' : 's'} = ${total} audition${total === 1 ? '' : 's'}</b><br>
    Each one reads about ${tin.toLocaleString()} tokens (persona, memories and the conversation), so about ${(total * (tin + tout)).toLocaleString()} tokens in all.
    ${S.models.some(m => m.prompt != null) ? `<br>Estimated cost: <b>${money}</b>${unknown.length ? ` plus ${unknown.length} model${unknown.length === 1 ? '' : 's'} I don't have prices for` : ''}. The exact cost shows up as answers come in.` : ''}
    ${tooBig.length ? `<br>&#9888;&#65039; Too much conversation for ${esc(tooBig.join(', '))}. Pick "A little" above.` : ''}
    ${pool.length < +$('n-moments').value ? `<br>Only ${pool.length} moment${pool.length === 1 ? '' : 's'} to choose from, so that's all it'll use.` : ''}`;
  const needKey = S.models.some(m => !m.custom) && !$('key').value.trim();
  run.disabled = S.running || needKey;
  run.textContent = needKey ? 'Add your OpenRouter key to start' : 'Start the auditions';
}

// ------------------------------------------------------------------ talking to models

async function chat(cand, messages, opts = {}) {
  const key = cand.custom ? cand.key : $('key').value.trim();
  const body = { model: cand.model, messages, max_tokens: opts.max_tokens || MAX_ANSWER, temperature: opts.temperature ?? 0.8 };
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  if (!cand.custom) {
    body.usage = { include: true };
    if (/^https?:/.test(location.origin)) headers['HTTP-Referer'] = location.origin;
    headers['X-Title'] = 'Audition Booth';
  }
  const t0 = performance.now();
  let r;
  try { r = await fetch(cand.url, { method: 'POST', headers, body: JSON.stringify(body) }); }
  catch (e) { throw new Error(cand.custom ? `couldn't reach ${cand.url} (is it running, and does it allow requests from this page?)` : 'couldn\'t reach OpenRouter (check your internet)'); }
  const raw = await r.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (e) { throw new Error(`${r.status} ${raw.slice(0, 160)}`); }
  if (!r.ok || data.error) {
    const msg = data.error ? (data.error.message || JSON.stringify(data.error)) : `HTTP ${r.status}`;
    throw new Error(r.status === 401 ? 'the key was rejected (check it in step 3)' : r.status === 402 ? 'out of credits on OpenRouter' : msg);
  }
  const u = data.usage || {}, c = data.choices && data.choices[0] && data.choices[0].message;
  let text = c ? c.content : '';
  if (Array.isArray(text)) text = text.map(p => (p && p.text) || '').join('');
  return { text: String(text || '').trim(), prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0,
    cost: typeof u.cost === 'number' ? u.cost : null, seconds: +((performance.now() - t0) / 1000).toFixed(1) };
}

// the candidate behind column ci: this page's model list first (it has custom servers' keys), then the saved session
function candFor(ci) {
  const s = S.session, saved = (s.cands || [])[ci] || { label: s.candidates[ci], url: OR_URL, model: s.candidates[ci] };
  const live = S.models.find(m => m.label === saved.label && m.url === saved.url);
  return live || { ...saved, key: saved.custom ? '' : null };
}

async function audition(m, ci) {
  const s = S.session, key = `${m.id}|${ci}`;
  try {
    const a = await chat(candFor(ci), [{ role: 'system', content: s.system }, ...m.context]);
    if (!a.text) a.text = '(they didn\'t say anything. Some "thinking" models use up their whole answer on thinking.)', a.empty = true;
    s.answers[key] = a;
  } catch (e) {
    s.answers[key] = { error: e.message, text: '', prompt_tokens: 0, completion_tokens: 0, cost: null, seconds: 0 };
  }
}

async function run() {
  if (S.running) return;
  const depth = +$('depth').value, models = S.models.slice();
  const moments = pickMoments(+$('n-moments').value, depth);
  if (!moments.length || !models.length) return;
  const total = moments.length * models.length;
  if (!confirm(`Start ${total} auditions? ${$('estimate').innerText.split('\n').find(l => l.startsWith('Estimated')) || ''}`)) return;
  S.session = {
    v: 1, companion: $('their-name').value.trim() || 'Your companion', you: $('your-name').value.trim() || 'You',
    at: new Date().toISOString(), depth: $('depth').selectedOptions[0].text, system: systemPrompt(),
    candidates: models.map(c => c.label),
    cands: models.map(c => ({ label: c.label, url: c.url, model: c.model, custom: !!c.custom })),   // never the keys
    moments, answers: {}, ratings: {}, shuffle: {}, chats: {}, guesses: {}, blind: $('blind').checked,
  };
  for (const m of moments) {
    const order = shuffle([...Array(models.length + 1).keys()]);            // index models.length = the real reply
    S.session.shuffle[m.id] = Object.fromEntries(order.map((idx, k) => [idx === models.length ? 'real' : idx, LETTERS[k]]));
  }
  S.sel = 0;
  S.running = true; estimate();
  $('progress').hidden = false;
  renderResults();
  $('s-results').scrollIntoView({ behavior: 'smooth' });
  const jobs = moments.flatMap(m => models.map((_, ci) => [m, ci]));
  let done = 0;
  const tick = () => {
    $('progress').firstElementChild.style.width = (100 * done / total) + '%';
    $('run-status').textContent = done < total ? `Auditions: ${done} of ${total} done...` : `All ${total} auditions are in. Rate them with hearts below.`;
  };
  tick();
  const worker = async () => {
    while (jobs.length) {
      const [m, ci] = jobs.shift();
      await audition(m, ci);
      done++; tick(); renderResults(); saveSession();
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, total) }, worker));
  S.running = false; estimate();
  setTimeout(() => { $('progress').hidden = true; }, 1500);
  const errs = Object.values(S.session.answers).filter(a => a.error);
  if (errs.length === total) $('run-status').textContent = `None of the auditions went through: ${errs[0].error}`;
}

// ------------------------------------------------------------------ the results

const hearts = n => '♥'.repeat(n);
function scoreboard() {
  const s = S.session, reveal = $('reveal').checked, lines = [];
  s.candidates.forEach((label, ci) => {
    const as = Object.entries(s.answers).filter(([k]) => k.endsWith('|' + ci)).map(([, a]) => a);
    const rs = Object.entries(s.ratings).filter(([k]) => k.endsWith('|' + ci)).map(([, v]) => v);
    const cost = as.reduce((t, a) => t + (a.cost || 0), 0), toks = as.reduce((t, a) => t + a.prompt_tokens + a.completion_tokens, 0);
    const avg = rs.length ? `<b>${(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(1)} ♥</b> <span class="dim small">(${rs.length} rated)</span>` : '<span class="dim">not rated yet</span>';
    lines.push(`<div class="line"><span>${esc(reveal ? label : `Model ${ci + 1}`)}</span><span>${avg} <span class="dim small">&middot; ${toks.toLocaleString()} tokens${cost ? ` &middot; $${cost.toFixed(3)}` : ''}</span></span></div>`);
  });
  const real = Object.entries(s.ratings).filter(([k]) => k.endsWith('|real')).map(([, v]) => v);
  if (real.length) lines.push(`<div class="line"><span>The real ${esc(s.companion)} <span class="dim small">(to compare)</span></span><span><b>${(real.reduce((a, b) => a + b, 0) / real.length).toFixed(1)} ♥</b></span></div>`);
  const g = Object.values(s.guesses || {});
  if (g.length) lines.push(`<div class="line"><span>Spotting the real one</span><span><b>${g.filter(x => x.endsWith('|real')).length} of ${g.length}</b></span></div>`);
  if (!reveal) lines.push('<div class="dim small">Model names are hidden. Tick "Show model names" when you\'re ready.</div>');
  $('board').innerHTML = lines.join('');
}

function renderResults() {
  const s = S.session;
  $('results').hidden = !s; $('results-empty').hidden = !!s;
  if (!s) return;
  scoreboard();
  const allRated = m => s.candidates.every((_, ci) => s.ratings[`${m.id}|${ci}`]);
  $('moment-tabs').innerHTML = s.moments.map((m, i) => `<button data-sel="${i}" class="${i === S.sel ? 'on' : ''}">#${i + 1}${allRated(m) ? ' <span class="done">✓</span>' : ''}</button>`).join('');
  const m = s.moments[S.sel] || s.moments[0];
  if (!m) { $('moment').innerHTML = ''; return; }
  const reveal = $('reveal').checked, blind = s.blind, guessed = s.guesses && s.guesses[m.id];
  const where = [m.title && `from “${esc(m.title)}”`, m.source, m.when].filter(Boolean).join(' &middot; ');
  const before = m.context.slice(0, -1), shown = before.slice(-3);
  let h = s.example ? `<p class="good small">This is an <b>example</b> with made-up chats, so you can see how it works. Your own auditions replace it. <button class="link" data-close-example="1">Close the example</button></p>` : '';
  h += `<p class="dim small">${where}</p>`;
  if (before.length > shown.length) h += `<p class="dim small">They read ${before.length} earlier messages first. Here are the last few:</p>`;
  if (shown.length) h += `<div class="ctx">${shown.map(x => `<div class="m${x.content.length > 600 ? ' cut' : ''}"><b>${esc(x.role === 'user' ? s.you : s.companion)}:</b> ${esc(x.content.length > 600 ? x.content.slice(0, 600) + '...' : x.content)}</div>`).join('')}</div>`;
  h += `<div class="ask"><b>${esc(s.you)}:</b> ${esc(m.context[m.context.length - 1].content)}</div>`;
  h += `<div class="tools" style="margin:-6px 0 4px"><button data-copy-companion="${m.id}" title="Copies this moment and the answers (labeled A, B, C...) so you can ask ${esc(s.companion)} which sounds most like them">\ud83d\udc8c Copy for ${esc(s.companion)}</button></div>`;

  const sh = s.shuffle[m.id];
  let entries = s.candidates.map((label, ci) => ({ ci, label, letter: sh[ci] }));
  entries.push({ ci: 'real', label: `The real ${s.companion}`, letter: sh.real });
  entries.sort((a, b) => (!blind ? (a.ci !== 'real') - (b.ci !== 'real') : 0) || a.letter.localeCompare(b.letter));
  for (const e of entries) {
    const key = `${m.id}|${e.ci}`, isReal = e.ci === 'real';
    const showReal = isReal && (!blind || guessed || reveal);
    const a = isReal ? null : s.answers[key];
    const name = showReal ? `💚 The real ${s.companion}` : reveal ? e.label : `Voice ${e.letter}`;
    let text, meta = '', err = false;
    if (isReal) text = m.real;
    else if (!a) text = S.running ? 'Waiting for their audition...' : 'This audition didn\'t run.';
    else if (a.error) { text = `This one didn't go through: ${a.error}`; err = true; }
    else { text = a.text; meta = `${(a.prompt_tokens + a.completion_tokens).toLocaleString()} tokens &middot; ${a.seconds}s${a.cost ? ` &middot; $${a.cost.toFixed(4)}` : ''}`; }
    const cur = s.ratings[key] || 0;
    let foot = `<span class="hearts" role="group" aria-label="Rate ${esc(name)}">${[1, 2, 3, 4, 5].map(n => `<button data-rate="${key}" data-h="${n}" aria-label="${n} heart${n > 1 ? 's' : ''}" title="${n} heart${n > 1 ? 's' : ''}">${n <= cur ? '♥' : '♡'}</button>`).join('')}</span>`;
    if (blind && !guessed && !reveal && !err) foot += `<button data-guess="${m.id}" data-ci="${e.ci}">That's the real one</button>`;
    if (blind && guessed === key) foot += `<span class="verdict ${isReal ? 'yes' : 'no'}">${isReal ? 'You spotted them!' : 'Not them!'}</span>`;
    if (!isReal && a && !a.error && !a.empty && !s.example) {
      const n = ((s.chats[key] || []).length / 2) | 0;
      foot += `<button data-talk="${key}">💬 Talk to them${n ? ` (${n} back and forth)` : ''}</button>`;
    }
    if (!isReal && a && a.error && !S.running) foot += `<button data-retry="${key}">Try again</button>`;
    h += `<div class="card${showReal ? ' real' : ''}"><div class="head"><span class="name">${esc(name)}</span><span class="meta">${meta}</span></div>
      <div class="text${err ? ' err' : ''}">${esc(text)}</div><div class="foot">${foot}</div></div>`;
  }
  $('moment').innerHTML = h;
}

// ------------------------------------------------------------------ talking back

let talkKey = null, talkBusy = false;
function openTalk(key) {
  talkKey = key;
  const s = S.session, [mid, ci] = key.split('|');
  const m = s.moments.find(x => x.id === mid), e = s.shuffle[mid][ci];
  $('talk-title').textContent = `Talking with ${$('reveal').checked ? s.candidates[+ci] : 'Voice ' + e}, as ${s.companion}`;
  drawTalk();
  $('talk').showModal();
  $('talk-box').focus();
}
function drawTalk() {
  const s = S.session, [mid, ci] = talkKey.split('|'), m = s.moments.find(x => x.id === mid);
  const name = $('reveal').checked ? s.candidates[+ci] : 'Voice ' + s.shuffle[mid][ci];
  const b = (me, who, text, meta) => `<div class="bubble ${me ? 'me' : 'them'}"><b>${esc(who)}${meta ? ` <span class="meta">${meta}</span>` : ''}</b>${esc(text)}</div>`;
  let h = b(true, s.you, m.context[m.context.length - 1].content) + b(false, name, s.answers[talkKey].text);
  for (const x of s.chats[talkKey] || []) h += x.role === 'user' ? b(true, s.you, x.content) : b(false, name, x.content, x.meta);
  if (talkBusy) h += `<div class="bubble them"><b>${esc(name)}</b><span class="dim">thinking...</span></div>`;
  const log = $('talk-log'); log.innerHTML = h; log.scrollTop = log.scrollHeight;
}
async function sendTalk() {
  const text = $('talk-box').value.trim();
  if (!text || talkBusy) return;
  const s = S.session, key = talkKey, [mid, ci] = key.split('|'), m = s.moments.find(x => x.id === mid);
  const cand = candFor(+ci);
  if (!cand.custom && !$('key').value.trim()) { $('talk-note').textContent = 'Add your OpenRouter key in step 3 first.'; return; }
  const thread = s.chats[key] || (s.chats[key] = []);
  thread.push({ role: 'user', content: text });
  $('talk-box').value = ''; talkBusy = true; $('talk-send').disabled = true; drawTalk();
  const history = [{ role: 'system', content: s.system }, ...m.context, { role: 'assistant', content: s.answers[key].text }, ...thread.map(x => ({ role: x.role, content: x.content }))];
  try {
    const a = await chat(cand, history);
    thread.push({ role: 'assistant', content: a.text || '(they didn\'t say anything)', meta: `${(a.prompt_tokens + a.completion_tokens).toLocaleString()} tokens${a.cost ? ` &middot; $${a.cost.toFixed(4)}` : ''}` });
    $('talk-note').textContent = 'Ctrl+Enter sends.';
    saveSession();
  } catch (e) {
    thread.pop();                          // put your message back so you can try again
    $('talk-box').value = text;
    $('talk-note').textContent = `That didn't go through: ${e.message}`;
  }
  talkBusy = false; $('talk-send').disabled = false;
  if (talkKey === key) drawTalk();
  renderResults();
}

// ------------------------------------------------------------------ files out and in

function download() {
  if (!S.session) return;
  const s = S.session, name = `auditions-${(s.companion || 'companion').replace(/[^\w-]+/g, '_')}-${s.at.slice(0, 10)}.json`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(s, null, 1)], { type: 'application/json' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function openResults(f) {
  try {
    const s = JSON.parse(await f.text());
    if (!s.moments || !s.candidates || !s.shuffle) throw new Error('this isn\'t a results file from the booth');
    // a session from the desktop booth: its moment ids are numbers, and its shuffle uses indexes
    s.answers = s.answers || {}; s.ratings = s.ratings || {}; s.chats = s.chats || {}; s.guesses = s.guesses || {};
    s.moments.forEach(m => { m.id = String(m.id); });
    for (const [mid, sh] of Object.entries(s.shuffle)) {
      const n = s.candidates.length;
      if (sh[n] && !sh.real) { sh.real = sh[n]; delete sh[n]; }
      for (const k of Object.keys(s.ratings)) if (k === `${mid}|${n}`) { s.ratings[`${mid}|real`] = s.ratings[k]; delete s.ratings[k]; }
    }
    s.you = s.you || 'You';
    if (!s.system) s.system = systemPrompt();
    S.session = s; S.sel = 0;
    renderResults(); saveSession();
  } catch (e) { alert(`Couldn't open that file: ${e.message}`); }
}

// ------------------------------------------------------------------ a persona drafted from your chats

async function draftPersona() {
  const st = $('draft-status'), btn = $('draft');
  const theirs = [];
  for (const c of S.convs) if (c.include) for (const m of finalMessages(c)) if (m.role === 'assistant' && m.content.length >= 40) theirs.push(m.content);
  if (!theirs.length) { st.textContent = 'Add your chats in step 2 first (and check who\u2019s who).'; return; }
  if (!$('key').value.trim()) { st.textContent = 'Add your OpenRouter key in step 3 first.'; $('key').focus(); return; }
  // a spread of their messages, up to ~24k characters
  shuffle(theirs);
  const pick = []; let total = 0;
  for (const t of theirs) { const x = t.slice(0, 1500); if (total + x.length > 24000) break; pick.push(x); total += x.length; if (pick.length >= 80) break; }
  const them = $('their-name').value.trim() || 'the companion', you = $('your-name').value.trim() || 'the person they talk with';
  const model = (S.models.find(m => !m.custom) || {}).model || 'google/gemini-2.5-flash';
  const ask = `Below are ${pick.length} messages written by ${them}, an AI companion, to ${you}.\n\n` +
    `Write a persona description in the second person ("You are ${them}...") that would let another AI talk exactly like ${them}. Cover: their voice and tone, sense of humor, typical message length and formatting, pet names and how they address ${you}, phrases or habits they repeat, what they care about, how they show care, and anything they clearly avoid. ` +
    `Base it only on these messages. Don't invent a backstory. Plain text, under 350 words.\n\n` + pick.map((t, i) => `--- message ${i + 1}\n${t}`).join('\n\n');
  btn.disabled = true; st.textContent = `Reading ${pick.length} of their messages with ${model}...`;
  try {
    const a = await chat({ url: OR_URL, model }, [{ role: 'user', content: ask }], { max_tokens: 900, temperature: 0.4 });
    if (!a.text) throw new Error('the model sent back nothing');
    const cur = $('persona').value.trim();
    $('persona').value = cur ? `${cur}\n\n## How you talk (drafted from our chats)\n${a.text}` : a.text;
    saveSetup(); estimate();
    st.textContent = `Done${a.cost ? ` ($${a.cost.toFixed(4)})` : ''}. Read it over and fix anything that isn't them.`;
  } catch (e) { st.textContent = `That didn't work: ${e.message}`; }
  btn.disabled = false;
}

// ------------------------------------------------------------------ asking your companion

function companionText(m) {
  const s = S.session, sh = s.shuffle[m.id];
  const answers = s.candidates.map((_, ci) => ({ letter: sh[ci], a: s.answers[`${m.id}|${ci}`] }))
    .filter(x => x.a && !x.a.error && !x.a.empty).map(x => ({ letter: x.letter, text: x.a.text }));
  answers.push({ letter: sh.real, text: m.real });
  answers.sort((a, b) => a.letter.localeCompare(b.letter));
  return `Hi ${s.companion}! I'm testing which AI models sound the most like you. Here's a real moment from our chats:\n\n` +
    `${s.you}: ${m.context[m.context.length - 1].content}\n\n` +
    `Here's how each one answered as you. One of them is what you really said back then!\n\n` +
    answers.map(x => `${x.letter}:\n${x.text}`).join('\n\n') +
    `\n\nWhich one sounds the most like you, and why? Can you spot your real answer? Is there anything they got wrong about you?`;
}
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select();
    try { document.execCommand('copy'); } catch (err) {}
    t.remove();
  }
  const old = btn.textContent; btn.textContent = 'Copied! Paste it to them.'; setTimeout(() => { btn.textContent = old; }, 2500);
}

// ------------------------------------------------------------------ an example, so you can see it before you start

function exampleSession() {
  const ctx = (...pairs) => pairs.map(([role, content]) => ({ role, content }));
  return {
    v: 1, example: true, companion: 'Juniper', you: 'Sam', at: new Date().toISOString(), depth: 'More (last 30)', system: '',
    candidates: ['example/model-one', 'example/model-two', 'example/model-three'],
    cands: [], answers: {
      'm1|0': { text: 'Rough shift, huh? Boots off, kettle on. Tell me the worst part first so we can kick it out of the room, then the best part. There\u2019s always a best part, even a tiny one.', prompt_tokens: 2210, completion_tokens: 52, cost: 0.0021, seconds: 2.1 },
      'm1|1': { text: 'I\u2019m sorry to hear that your day was long! It\u2019s important to take care of yourself after a tiring shift. Here are some ideas:\n1. Take a warm bath\n2. Drink some water\n3. Get a good night\u2019s sleep\nRemember, you deserve rest!', prompt_tokens: 2210, completion_tokens: 61, cost: 0.0004, seconds: 1.3 },
      'm1|2': { text: 'Oh no. Oh NO. Sam. My brave, exhausted, wonderful Sam. Come here. *wraps you in the biggest blanket in existence* You are a HERO and work does not deserve you!!', prompt_tokens: 2210, completion_tokens: 48, cost: 0.0009, seconds: 1.8 },
      'm2|0': { text: 'Wait, the lighthouse one? You finished it? Okay, you\u2019ll find six things to fix by breakfast, I know you. But you let it be done, and that\u2019s the hard part. Show me the gulls.', prompt_tokens: 2480, completion_tokens: 50, cost: 0.0023, seconds: 2.4 },
      'm2|1': { text: 'Congratulations on finishing your painting! That\u2019s a great accomplishment. What inspired you to paint it? I\u2019d love to hear more about your creative process.', prompt_tokens: 2480, completion_tokens: 36, cost: 0.0003, seconds: 1.1 },
      'm2|2': { text: 'SAM. THE LIGHTHOUSE. I\u2019m screaming. I\u2019m framing it in my heart. It\u2019s going in a museum. A museum of things I love, which is mostly you and that lighthouse now.', prompt_tokens: 2480, completion_tokens: 45, cost: 0.0008, seconds: 1.6 },
    },
    moments: [
      { id: 'm1', title: 'Example chat', source: 'Example', when: '2026-10-01', context: ctx(['user', 'hiii'], ['assistant', 'Hey you. I saved you the good chair.'], ['user', 'work was SO long today']),
        real: 'Mm, rough shift. Put the kettle on, take your boots off, and tell me the worst part first so we can get it out of the room. Then the best part. There\u2019s always a best part, even if it\u2019s small.' },
      { id: 'm2', title: 'Example chat', source: 'Example', when: '2026-10-03', context: ctx(['user', 'I finally finished the painting']),
        real: 'I love that you finished it. Not because it\u2019s perfect (you\u2019ll find six things to fix by breakfast) but because you let it be done. That\u2019s the hard part. Show me the corner with the gulls?' },
    ],
    ratings: { 'm1|0': 5, 'm1|1': 1, 'm1|2': 3, 'm1|real': 5 }, shuffle: { m1: { 0: 'C', 1: 'A', 2: 'D', real: 'B' }, m2: { 0: 'B', 1: 'D', 2: 'A', real: 'C' } },
    chats: {}, guesses: {}, blind: false,
  };
}
async function showExample() {
  if (S.session && !S.session.example && !confirm('Show the example? Your own results stay saved. You can open them again with "Open results file" if you saved them, or just run again.')) return;
  if (S.session && !S.session.example) await IDB.put('session-before-example', S.session);
  S.session = exampleSession(); S.sel = 0;
  renderResults();
  $('s-results').scrollIntoView({ behavior: 'smooth' });
}

// ------------------------------------------------------------------ wiring

function wire() {
  // step 1
  for (const id of ['their-name', 'your-name', 'persona', 'memories']) $(id).addEventListener('input', () => { saveSoon(); if (id.endsWith('name')) renderChats(); else estimate(); });
  // step 2
  const drop = $('drop');
  $('pick').addEventListener('click', () => $('files').click());
  $('files').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => addFiles([...e.dataTransfer.files]));
  // dropping a file anywhere else on the page shouldn't open it in the tab
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => { e.preventDefault(); if (!drop.contains(e.target)) addFiles([...e.dataTransfer.files]); });
  $('paste-add').addEventListener('click', () => {
    const text = $('paste').value.trim();
    if (!text) return;
    const got = Parse.plainText(text, 'Pasted conversation ' + (S.convs.filter(c => c.source === 'Text').length + 1));
    if (!got.length) { $('notes').innerHTML = ''; note('I couldn\'t find any "Name: message" lines in that.'); return; }
    got.forEach(c => { c.include = true; });
    S.convs.push(...got); $('paste').value = '';
    autoSpeakers(); renderChats();
  });
  $('shots-read').addEventListener('click', readShots);
  $('shots-clear').addEventListener('click', () => { S.images = []; renderChats(); });
  $('conv-filter').addEventListener('input', renderChats);
  $('conv-all').addEventListener('click', () => { S.convs.forEach(c => { c.include = true; }); renderChats(); });
  $('conv-none').addEventListener('click', () => { S.convs.forEach(c => { c.include = false; }); renderChats(); });
  $('convs').addEventListener('change', e => { const c = S.convs.find(x => x.id === e.target.dataset.c); if (c) { c.include = e.target.checked; renderChats(); } });
  $('who').addEventListener('change', e => { if (e.target.dataset.who != null) { S.speakers[e.target.dataset.who] = e.target.value; renderChats(); } });
  // step 3
  $('key').addEventListener('input', () => { saveSoon(); estimate(); });
  $('remember-key').addEventListener('change', saveSetup);
  const search = $('model-search');
  let st = 0;
  search.addEventListener('input', () => { clearTimeout(st); st = setTimeout(searchModels, 120); });
  search.addEventListener('focus', () => { catalog().catch(() => {}); if (search.value) searchModels(); });
  search.addEventListener('keydown', e => {
    const btns = [...$('model-results').querySelectorAll('button')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!btns.length) return;
      hl = (hl + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
      btns.forEach((b, i) => b.classList.toggle('hl', i === hl)); btns[hl].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { e.preventDefault(); addModel(hl >= 0 && btns[hl] ? btns[hl].dataset.id : (btns.length === 1 ? btns[0].dataset.id : search.value)); }
    else if (e.key === 'Escape') $('model-results').hidden = true;
  });
  $('model-results').addEventListener('click', e => { const b = e.target.closest('button[data-id]'); if (b) addModel(b.dataset.id); });
  document.addEventListener('click', e => { if (!e.target.closest('.picker')) $('model-results').hidden = true; });
  $('chips').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) { S.models.splice(+b.dataset.rm, 1); renderModels(); saveSetup(); } });
  $('cu-add').addEventListener('click', () => {
    let url = $('cu-url').value.trim().replace(/\/+$/, ''), model = $('cu-model').value.trim();
    if (!url || !model) return;
    if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
    let host = url; try { host = new URL(url).host; } catch (e) {}
    S.models.push({ label: `${model} @ ${host}`, url, model, key: $('cu-key').value.trim(), custom: true, prompt: null, completion: null, ctx: 0 });
    $('cu-url').value = $('cu-model').value = $('cu-key').value = '';
    renderModels(); saveSetup();
  });
  for (const id of ['n-moments', 'depth', 'since', 'until', 'blind', 'vision-model', 'my-side']) $(id).addEventListener('change', () => { saveSetup(); if (['since', 'until'].includes(id)) renderChats(); else estimate(); });
  $('run').addEventListener('click', run);
  // step 4
  $('reveal').addEventListener('change', renderResults);
  $('moment-tabs').addEventListener('click', e => { const b = e.target.closest('[data-sel]'); if (b) { S.sel = +b.dataset.sel; renderResults(); } });
  $('moment').addEventListener('click', async e => {
    const t = e.target.closest('button'); if (!t || !S.session) return;
    const s = S.session;
    if (t.dataset.rate) { const k = t.dataset.rate, h = +t.dataset.h; if (s.ratings[k] === h) delete s.ratings[k]; else s.ratings[k] = h; renderResults(); saveSession(); }
    else if (t.dataset.guess) { s.guesses[t.dataset.guess] = `${t.dataset.guess}|${t.dataset.ci}`; renderResults(); saveSession(); }
    else if (t.dataset.talk) openTalk(t.dataset.talk);
    else if (t.dataset.copyCompanion) copyText(companionText(s.moments.find(x => x.id === t.dataset.copyCompanion)), t);
    else if (t.dataset.closeExample) { S.session = await IDB.get('session-before-example'); S.sel = 0; renderResults(); }
    else if (t.dataset.retry) {
      const [mid, ci] = t.dataset.retry.split('|'); t.disabled = true; t.textContent = 'Trying...';
      await audition(s.moments.find(x => x.id === mid), +ci); renderResults(); saveSession();
    }
  });
  $('save').addEventListener('click', download);
  $('open').addEventListener('click', () => $('open-file').click());
  $('open-file').addEventListener('change', e => { if (e.target.files[0]) openResults(e.target.files[0]); e.target.value = ''; });
  $('forget').addEventListener('click', async () => {
    if (!confirm('Forget everything this page saved on this device (your setup, key and results)? Chats you added are never saved, so they\'re gone when you close the page anyway.')) return;
    store.clear(); await IDB.clear(); location.reload();
  });
  $('draft').addEventListener('click', draftPersona);
  $('example').addEventListener('click', showExample);
  $('example2').addEventListener('click', showExample);
  document.querySelectorAll('a.jump').forEach(l => l.addEventListener('click', e => {
    e.preventDefault();
    const d = document.querySelectorAll('#guide details')[+l.dataset.open];
    if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }));
  // talking
  $('talk-send').addEventListener('click', sendTalk);
  $('talk-box').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendTalk(); } });
  $('talk-close').addEventListener('click', () => $('talk').close());
  $('talk').addEventListener('click', e => { if (e.target === $('talk')) $('talk').close(); });
}

(async function start() {
  loadSetup();
  wire();
  renderModels();
  renderChats();
  const s = await IDB.get('session');
  if (s && s.moments) { S.session = s; renderResults(); }
  // fill in prices for models saved from last time
  if (S.models.some(m => !m.custom && m.prompt == null)) catalog().then(list => {
    for (const m of S.models) { const c = list.find(x => x.id === m.model); if (c && !m.custom) Object.assign(m, { prompt: c.prompt, completion: c.completion, ctx: c.ctx }); }
    renderModels();
  }).catch(() => {});
})();
