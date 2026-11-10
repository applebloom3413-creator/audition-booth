// parse.js — turns whatever people have into one shape:
//   conversation = { id, title, source, messages: [{ who, role, text, time }] }
// `role` is 'user' (you) or 'assistant' (your companion) when the file says so (Claude, ChatGPT,
// SillyTavern). Otherwise it's null and `who` holds a name, and you say who's who on the page.
'use strict';

const Parse = (() => {
  let nextId = 1;
  const conv = (source, title, messages) => ({ id: 'c' + nextId++, source, title: title || 'Untitled', messages });
  const msg = (who, role, text, time) => ({ who: who == null ? '' : String(who), role, text: String(text || '').trim(), time: time || null });
  const iso = d => { const t = d instanceof Date ? d : new Date(d); return isNaN(t) ? null : t.toISOString(); };

  // ------------------------------------------------------------ Claude (claude.ai export: conversations.json)
  function claude(list) {
    return list.map(c => {
      const ms = (c.chat_messages || []).map(m => {
        let text = '';
        if (Array.isArray(m.content) && m.content.length) text = m.content.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
        if (!text.trim()) text = m.text || '';
        return msg(m.sender === 'human' ? 'You' : 'Claude', m.sender === 'human' ? 'user' : 'assistant', text, iso(m.created_at));
      }).filter(m => m.text);
      return conv('Claude', c.name, ms);
    });
  }

  // ------------------------------------------------------------ ChatGPT (chatgpt.com export: conversations.json)
  // Each conversation is a tree (edits make branches). Follow the branch that was showing last.
  function chatgpt(list) {
    return list.map(c => {
      const map = c.mapping || {};
      let node = c.current_node, path = [];
      if (!node || !map[node]) {          // no pointer: take the newest leaf
        const leaves = Object.values(map).filter(n => !n.children || !n.children.length);
        leaves.sort((a, b) => ((b.message && b.message.create_time) || 0) - ((a.message && a.message.create_time) || 0));
        node = leaves[0] && leaves[0].id;
      }
      const seen = new Set();
      while (node && map[node] && !seen.has(node)) { seen.add(node); path.push(map[node]); node = map[node].parent; }
      path.reverse();
      const ms = [];
      for (const n of path) {
        const m = n.message;
        if (!m || !m.author || !['user', 'assistant'].includes(m.author.role)) continue;
        if (m.metadata && (m.metadata.is_visually_hidden_from_conversation || m.metadata.is_user_system_message)) continue;
        const ct = m.content || {};
        if (ct.content_type && !['text', 'multimodal_text'].includes(ct.content_type)) continue;
        const text = (ct.parts || []).filter(p => typeof p === 'string').join('\n');
        if (!text.trim()) continue;
        ms.push(msg(m.author.role === 'user' ? 'You' : 'ChatGPT', m.author.role, text, m.create_time ? iso(m.create_time * 1000) : null));
      }
      return conv('ChatGPT', c.title, ms);
    });
  }

  // ------------------------------------------------------------ Telegram Desktop (JSON: result.json)
  function tgText(t) {
    if (typeof t === 'string') return t;
    if (Array.isArray(t)) return t.map(p => typeof p === 'string' ? p : (p && p.text) || '').join('');
    return '';
  }
  function telegramJson(data) {
    const chats = data.chats && data.chats.list ? data.chats.list : (data.messages ? [data] : []);
    return chats.filter(c => c.messages && c.messages.length).map(c => conv('Telegram', c.name || 'Telegram chat',
      c.messages.filter(m => m.type === 'message').map(m => msg(m.from || m.actor || 'Unknown', null, tgText(m.text), iso(m.date))).filter(m => m.text)));
  }

  // ------------------------------------------------------------ Telegram Desktop (HTML: messages.html, messages2.html...)
  function textOf(el) {
    if (!el) return '';
    const c = el.cloneNode(true);
    c.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
    return c.textContent.replace(/[ \t]+\n/g, '\n').trim();
  }
  function tgDate(title) {
    // "09.11.2026 12:58:00 UTC-05:00" (or without the zone)
    const m = /(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})(?: UTC([+-]\d{2}):?(\d{2}))?/.exec(title || '');
    if (!m) return null;
    const zone = m[7] ? `${m[7]}:${m[8]}` : '';
    return iso(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}${zone}`);
  }
  function telegramHtml(html, fileName) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = textOf(doc.querySelector('.page_header .text')) || fileName;
    const ms = [];
    let last = 'Unknown';
    for (const el of doc.querySelectorAll('.message.default')) {
      const body = el.querySelector(':scope > .body') || el.querySelector('.body');
      if (!body) continue;
      const from = body.querySelector(':scope > .from_name');
      if (from) last = textOf(from).replace(/\s+via @\S+$/, '');
      const text = textOf(body.querySelector(':scope > .text'));
      if (!text) continue;
      ms.push(msg(last, null, text, tgDate((body.querySelector(':scope > .date') || {}).title)));
    }
    return ms.length ? [conv('Telegram', title, ms)] : [];
  }

  // ------------------------------------------------------------ Discord (DiscordChatExporter JSON)
  function discord(data) {
    const name = (data.channel && data.channel.name) || 'Discord chat';
    return [conv('Discord', name, data.messages.map(m => msg((m.author && (m.author.nickname || m.author.name)) || 'Unknown', null, m.content, iso(m.timestamp))).filter(m => m.text))];
  }

  // ------------------------------------------------------------ SillyTavern chats (.jsonl)
  function sillyTavern(text, fileName) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const rows = lines.map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    const head = rows[0] && rows[0].user_name !== undefined && rows[0].mes === undefined ? rows.shift() : {};
    const ms = rows.filter(r => r.mes !== undefined && !r.is_system).map(r =>
      msg(r.name || (r.is_user ? head.user_name : head.character_name), r.is_user ? 'user' : 'assistant', r.mes, iso(r.send_date)));
    return [conv('SillyTavern', head.character_name ? `${head.character_name} — ${fileName}` : fileName, ms.filter(m => m.text))];
  }

  // ------------------------------------------------------------ plain text (pasted, WhatsApp .txt, anything "Name: message")
  // Leading dates/times are stripped: "12/03/2025, 10:15 - Name: hi", "[12/03/25, 10:15:22] Name: hi", "[10:15] Name: hi"
  const STAMP = /^\s*\[?\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?\]?\s*(?:-\s*)?|^\s*\[\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?\]\s*/;
  const LINE = /^([^:\n]{1,40}?):\s?(.*)$/;
  function plainText(text, title = 'Pasted conversation') {
    const raw = text.replace(/\r/g, '').split('\n');
    // in a file with timestamps (WhatsApp), only a stamped line starts a new message
    const stamped = raw.some(l => STAMP.test(l) && LINE.test(l.replace(STAMP, '')));
    const parsed = raw.map(l => {
      const stamp = STAMP.exec(l);
      if (stamped && !stamp) return { text: l };
      const rest = stamp ? l.slice(stamp[0].length) : l;
      const m = LINE.exec(rest);
      return m && !/https?$/i.test(m[1]) && !/^\s/.test(rest) ? { who: m[1].trim(), text: m[2] } : { text: l };
    });
    // only names that show up again count as speakers ("So: yes..." inside a message doesn't),
    // unless it's a tiny paste where nobody repeats
    const counts = {};
    parsed.forEach(p => { if (p.who) counts[p.who] = (counts[p.who] || 0) + 1; });
    const names = Object.keys(counts), repeat = names.filter(n => counts[n] >= 2);
    const ok = new Set(repeat.length >= 2 ? repeat : names);
    const ms = [];
    for (const p of parsed) {
      if (p.who && ok.has(p.who)) ms.push(msg(p.who, null, p.text));
      else if (ms.length) ms[ms.length - 1].text += '\n' + (p.who ? `${p.who}: ${p.text}` : p.text);
    }
    ms.forEach(m => { m.text = m.text.trim(); });
    return ms.length ? [conv('Text', title, ms.filter(m => m.text))] : [];
  }

  // ------------------------------------------------------------ character cards (persona), JSON or PNG
  function cardPersona(card) {
    const d = card.data || card;
    if (!d || !(d.description || d.personality || d.system_prompt)) return null;
    const parts = [];
    if (d.system_prompt) parts.push(d.system_prompt);
    if (d.description) parts.push(d.description);
    if (d.personality) parts.push('Personality: ' + d.personality);
    if (d.scenario) parts.push('Scenario: ' + d.scenario);
    if (d.mes_example) parts.push('Examples of how you talk:\n' + d.mes_example);
    return { name: d.name || '', persona: parts.join('\n\n') };
  }
  async function pngCard(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;
    let i = 8;
    const dv = new DataView(buf.buffer);
    while (i + 8 < buf.length) {
      const len = dv.getUint32(i), type = String.fromCharCode(...buf.slice(i + 4, i + 8));
      if (type === 'tEXt') {
        const chunk = buf.slice(i + 8, i + 8 + len), z = chunk.indexOf(0);
        const key = new TextDecoder('latin1').decode(chunk.slice(0, z));
        if (key === 'chara' || key === 'ccv3') {
          try {
            const bin = atob(new TextDecoder('latin1').decode(chunk.slice(z + 1)));
            const json = new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0)));
            return cardPersona(JSON.parse(json));
          } catch (e) { return null; }
        }
      }
      if (type === 'IEND') break;
      i += 12 + len;
    }
    return null;
  }

  // ------------------------------------------------------------ one JSON file: which kind is it?
  function json(data, fileName) {
    if (Array.isArray(data)) {
      const first = data.find(x => x && typeof x === 'object') || {};
      if ('chat_messages' in first) return { conversations: claude(data) };
      if ('mapping' in first) return { conversations: chatgpt(data) };
      return { note: `${fileName}: I didn't recognise this list.` };
    }
    if (data && typeof data === 'object') {
      if (data.chats || (Array.isArray(data.messages) && data.messages.length && 'from' in (data.messages.find(m => m.type === 'message') || {}))) return { conversations: telegramJson(data) };
      if (Array.isArray(data.messages) && data.messages.length && data.messages[0].author) return { conversations: discord(data) };
      if (data.mapping) return { conversations: chatgpt([data]) };
      if (data.chat_messages) return { conversations: claude([data]) };
      const p = cardPersona(data);
      if (p) return { persona: p };
    }
    return { note: `${fileName}: I didn't recognise this file.` };
  }

  // ------------------------------------------------------------ any file (zips get opened)
  const IMAGE = /\.(png|jpe?g|webp|gif|heic)$/i;
  async function file(f, out = { conversations: [], images: [], personas: [], notes: [] }) {
    const name = f.name || 'file';
    try {
      if (/\.zip$/i.test(name)) {
        if (typeof JSZip === 'undefined') { out.notes.push(`${name}: couldn't open zip files (the zip helper didn't load). Unzip it and add the files inside.`); return out; }
        const zip = await JSZip.loadAsync(f);
        const inside = Object.values(zip.files).filter(z => !z.dir && /(\.json|\.jsonl|\.html?|\.txt)$/i.test(z.name) && !/(^|\/)(users|projects|memories|shared_conversations|user|message_feedback|model_comparisons)\.json$/i.test(z.name));
        if (!inside.length) out.notes.push(`${name}: no chats inside.`);
        for (const z of inside) {
          const blob = await z.async('blob');
          await file(new File([blob], z.name.split('/').pop()), out);
        }
        return out;
      }
      if (IMAGE.test(name) || (f.type || '').startsWith('image/')) {
        const card = /\.png$/i.test(name) ? await pngCard(f) : null;
        if (card) out.personas.push(card); else out.images.push(f);
        return out;
      }
      const text = await f.text();
      if (/\.jsonl$/i.test(name)) { out.conversations.push(...sillyTavern(text, name)); return out; }
      if (/\.json$/i.test(name)) {
        const r = json(JSON.parse(text), name);
        if (r.conversations) out.conversations.push(...r.conversations);
        if (r.persona) out.personas.push(r.persona);
        if (r.note) out.notes.push(r.note);
        return out;
      }
      if (/\.html?$/i.test(name)) {
        const got = telegramHtml(text, name);
        if (got.length) out.conversations.push(...got); else out.notes.push(`${name}: I couldn't find any messages in this page.`);
        return out;
      }
      const got = plainText(text, name);
      if (got.length) out.conversations.push(...got); else out.notes.push(`${name}: I couldn't find "Name: message" lines.`);
    } catch (e) {
      out.notes.push(`${name}: couldn't read it (${e.message}).`);
    }
    return out;
  }

  // Telegram HTML exports split one chat over messages.html, messages2.html... Glue chats with the same title back together.
  function mergeSameTitle(list) {
    const out = [], byKey = new Map();
    for (const c of list) {
      if (c.source !== 'Telegram') { out.push(c); continue; }
      const k = c.title;
      if (byKey.has(k)) byKey.get(k).messages.push(...c.messages);
      else { byKey.set(k, c); out.push(c); }
    }
    for (const c of byKey.values()) c.messages.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    return out;
  }

  return { file, plainText, mergeSameTitle, cardPersona };
})();
