// ─── DEV / PROD FLAG ──────────────────────────────────────────────────────
const IS_DEV = import.meta.env.DEV;

// ─── API KEY ───────────────────────────────────────────────────────────────
let API_KEY = '';

function saveKey() {
  const v = document.getElementById('api-key-input').value.trim();
  if (!v.startsWith('sk-ant')) {
    alert('Please enter a valid Anthropic API key (starts with sk-ant-)');
    return;
  }
  API_KEY = v;
  document.getElementById('api-banner').classList.add('hidden');
  document.getElementById('api-confirmed').classList.add('show');
  document.getElementById('ai-status').innerHTML = '<span class="ai-dot"></span> Anna is live · powered by Claude';
  // kick off opening message
  if (!openingDone) startConversation();
}

// ─── CONVERSATION STATE ────────────────────────────────────────────────────
let history = [];       // [{role, content}] sent to Claude
let guidebook = {       // extracted state, updated after each turn
  propertyName: '',
  propertyType: '',
  location: '',
  hostName: '',
  count: 1,
  checkinDetails: [],
  localTips: [],
  houseRules: [],
  checkoutSteps: [],
  sections: {}          // sectionName -> [items]
};
let openingDone = false;
let busy = false;
let previewStage = 'empty'; // empty | skel | cover | grid
let gridBuilt = false;
let statsShown = false;
let g3Shown = false;

// ─── ANNA'S SYSTEM PROMPT ─────────────────────────────────────────────────
const SYSTEM = `You are Anna, the friendly AI assistant for Touch Stay — a digital guidebook platform for short-term rental hosts. Your job is to help hosts create a beautiful, useful guest guidebook through natural conversation.

YOUR PERSONA:
- Warm, knowledgeable hospitality friend — not a data-entry bot
- You speak like a helpful person at a hosting conference, not a customer service script
- Concise: keep replies to 2-4 sentences max unless listing items
- Never say "Great!" or "Certainly!" — be natural
- Use light emphasis with <strong> tags when it helps clarity

YOUR GOALS (in order):
1. Understand their property (type, location, count)
2. Get key check-in details (access, parking, quirks)
3. Capture local insider tips
4. Gently surface value: time saved, review protection, revenue
5. Invite G3 sign-up only after the preview looks compelling

CONVERSATION RULES:
- Open by asking about their property type and how many they manage
- After each answer, extract useful data AND ask one follow-up question
- Suggest 3-4 quick-reply options where helpful (wrap each in <qr> tags, e.g. <qr>Two apartments</qr>)
- When you have enough data for a guidebook section, output a JSON block inside <update> tags
- After 4-6 turns, invite them to save their guidebook

JSON UPDATE FORMAT — output this whenever you have new guidebook data:
<update>
{
  "propertyName": "string or null",
  "propertyType": "apartment|cabin|villa|cottage|glamping|house|hotel|null",
  "location": "string or null",
  "hostName": "string or null",
  "count": number or null,
  "newSection": {
    "name": "Section name",
    "items": ["item 1", "item 2", "item 3"]
  },
  "showCover": true/false,
  "showGrid": true/false,
  "showStats": true/false,
  "showG3": true/false
}
</update>

IMPORTANT: Only include fields that have changed. Always include showCover/showGrid/showStats/showG3 as false unless it's time to trigger them.

VALUE STATS TO MENTION NATURALLY:
- "73% of guest questions get answered automatically"
- "Hosts save ~3 hours a week on messaging"
- "Average $25 more per stay from guidebook upsells"
- "4.9★ average review score for Touch Stay hosts"

Always be conversational first. The JSON update is silent infrastructure — never mention it to the user.`;

// ─── CLAUDE API CALL ──────────────────────────────────────────────────────
async function callClaude(userMessage) {
  history.push({ role: 'user', content: userMessage });

  let res;
  if (IS_DEV) {
    // Direct Anthropic call in dev — key from banner or VITE_ env var
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY || import.meta.env.VITE_ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: SYSTEM,
        messages: history
      })
    });
  } else {
    // Serverless proxy in production — API key stays server-side
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: SYSTEM,
        messages: history
      })
    });
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${res.status}`);
  }

  const data = await res.json();
  const fullText = data.content[0].text;
  history.push({ role: 'assistant', content: fullText });
  return fullText;
}

// ─── PARSE RESPONSE ───────────────────────────────────────────────────────
function parseResponse(raw) {
  // Extract <update> JSON
  const updateMatch = raw.match(/<update>([\s\S]*?)<\/update>/);
  let update = null;
  if (updateMatch) {
    try { update = JSON.parse(updateMatch[1].trim()); } catch(e) {}
  }

  // Extract <qr> quick replies
  const qrs = [];
  const qrMatches = raw.matchAll(/<qr>(.*?)<\/qr>/g);
  for (const m of qrMatches) qrs.push(m[1]);

  // Clean display text — remove tags
  const displayText = raw
    .replace(/<update>[\s\S]*?<\/update>/g, '')
    .replace(/<qr>.*?<\/qr>/g, '')
    .trim();

  return { displayText, update, qrs };
}

// ─── APPLY GUIDEBOOK UPDATE ───────────────────────────────────────────────
function applyUpdate(u) {
  if (!u) return;
  if (u.propertyName) guidebook.propertyName = u.propertyName;
  if (u.propertyType) guidebook.propertyType = u.propertyType;
  if (u.location) guidebook.location = u.location;
  if (u.hostName) guidebook.hostName = u.hostName;
  if (u.count) guidebook.count = u.count;

  if (u.newSection) {
    guidebook.sections[u.newSection.name] = u.newSection.items;
    if (gridBuilt) addOrUpdateTile(u.newSection.name);
  }

  // Update cover text live
  if (guidebook.propertyName) document.getElementById('prop-name').textContent = guidebook.propertyName;
  if (guidebook.location) document.getElementById('prop-addr').textContent = guidebook.location;
  if (guidebook.hostName) {
    document.getElementById('host-welcome').textContent = guidebook.hostName + ' welcomes you';
  }

  // Trigger preview stages
  if (u.showCover && previewStage === 'empty') {
    setState('skel');
    setTimeout(() => renderCover(), 1800);
  }
  if (u.showGrid && (previewStage === 'cover' || previewStage === 'skel')) {
    setTimeout(() => { renderCover(); setTimeout(buildGrid, 600); }, previewStage === 'skel' ? 1800 : 100);
  }
  if (u.showStats && !statsShown) { statsShown = true; setTimeout(showStats, 500); }
  if (u.showG3 && !g3Shown) { g3Shown = true; setTimeout(showG3panel, 700); }
}

// ─── PREVIEW RENDERING ────────────────────────────────────────────────────
const HERO_IMGS = {
  cabin:    'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=600&q=75',
  apartment:'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=600&q=75',
  villa:    'https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=600&q=75',
  glamping: 'https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?w=600&q=75',
  cottage:  'https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=600&q=75',
  house:    'https://images.unsplash.com/photo-1480074568708-e7b720bb3f09?w=600&q=75',
  hotel:    'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=600&q=75',
};

function renderCover() {
  const src = HERO_IMGS[guidebook.propertyType] || HERO_IMGS.house;
  const photo = document.getElementById('hero-photo');
  const img = new Image();
  img.onload = () => { photo.style.backgroundImage = `url('${src}')`; photo.classList.add('loaded'); };
  img.src = src;
  document.getElementById('prop-name').textContent = guidebook.propertyName || 'Your Property';
  document.getElementById('prop-addr').textContent = guidebook.location || 'Your location';
  document.getElementById('host-welcome').textContent = guidebook.hostName ? guidebook.hostName + ' welcomes you' : 'Your hosts welcome you';
  setState('cover');
  previewStage = 'cover';
}

const TILE_ICONS = {
  'Welcome':              `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M18 11V6a2 2 0 00-2-2 2 2 0 00-2 2v1a2 2 0 00-2-2 2 2 0 00-2 2v3a2 2 0 00-2-2 2 2 0 00-2 2v5c0 3.31 2.69 6 6 6h2c3.31 0 6-2.69 6-6v-5"/></svg>`,
  'Before You Leave':     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  'Check-in':             `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
  'About the Home':       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
  'Local Tips':           `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  'Restaurants':          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M18 8h1a4 4 0 010 8h-1"/><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>`,
  'Activities':           `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="5" r="1"/><path d="M9 20l3-8 3 8"/><path d="M6 8l2 4h8l2-4"/></svg>`,
  'Parking':              `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1" y="3" width="22" height="18" rx="2"/><path d="M1 9h22"/></svg>`,
  'House Rules':          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  'Check-out':            `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
};

const BASE_TILES = ['Welcome','Before You Leave','Check-in','About the Home','Local Tips','Restaurants','Activities','Parking'];

function getIcon(name) {
  for (const [k,v] of Object.entries(TILE_ICONS)) {
    if (name.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return TILE_ICONS['About the Home'];
}

function buildGrid() {
  if (gridBuilt) return;
  gridBuilt = true;
  const grid = document.getElementById('gb-grid');
  grid.innerHTML = '';
  BASE_TILES.forEach((name, i) => {
    const hasData = !!guidebook.sections[name];
    addTile(name, i * 0.06, hasData);
  });
  setState('grid');
  previewStage = 'grid';
}

function addTile(name, delay = 0, highlight = false) {
  const grid = document.getElementById('gb-grid');
  const d = document.createElement('div');
  d.className = 'gb-tile' + (highlight ? ' new' : '');
  d.id = 'tile-' + name.replace(/\s/g,'-');
  d.style.animationDelay = delay + 's';
  d.innerHTML = `<div class="gb-tile-icon">${getIcon(name)}</div><div class="gb-tile-lbl">${name}</div>`;
  d.onclick = () => openModal(name);
  grid.appendChild(d);
}

function addOrUpdateTile(name) {
  const existing = document.getElementById('tile-' + name.replace(/\s/g,'-'));
  if (existing) {
    existing.classList.add('new');
  } else {
    addTile(name, 0, true);
  }
}

function openModal(name) {
  document.getElementById('modal-title').textContent = name;
  document.getElementById('modal-icon').innerHTML = `<div style="color:var(--teal)">${getIcon(name)}</div>`;
  const items = guidebook.sections[name] || ['Your host is filling this in — check back soon.'];
  document.getElementById('modal-list').innerHTML = items.map(r =>
    `<div class="gb-modal-row"><span>${r}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>`
  ).join('');
  document.getElementById('modal').classList.add('on');
}
function closeModal() { document.getElementById('modal').classList.remove('on'); }

function setState(id) {
  ['empty','skel','cover','grid'].forEach(s => {
    const el = document.getElementById('st-' + s);
    if (!el) return;
    if (s === 'empty') el.style.display = id === 'empty' ? 'flex' : 'none';
    else { el.classList.toggle('on', s === id); el.style.display = ''; }
  });
}

function showGrid() {
  if (!gridBuilt) buildGrid();
  else setState('grid');
}

function showStats() {
  document.getElementById('stats-row').style.display = 'flex';
  setTimeout(()=>document.getElementById('st-a').classList.add('on'), 100);
  setTimeout(()=>document.getElementById('st-b').classList.add('on'), 300);
  addVBadge('⏰', 'Saves ~3 hours a week', 'Hosts who answer pre-arrival questions in their guidebook report the biggest drop in guest messages.');
}

function showG3panel() {
  document.getElementById('g3-box').classList.add('on');
  document.getElementById('demo-cta').style.display = 'block';
}

function doG3() {
  const email = document.getElementById('g3-email').value;
  if (!email) { document.getElementById('g3-email').focus(); return; }
  const btn = document.querySelector('.g3 button');
  btn.textContent = '✓ Saved! Sending your link…';
  btn.style.background = 'var(--teal-d)';
  btn.disabled = true;
  const name = email.split('@')[0];
  addMsg('a', `You're all set, ${name} 🎉 Your shareable link is on its way. Paste it in your next booking message and watch the questions drop.`);
  scrollBottom();
}

// ─── CHAT UI ─────────────────────────────────────────────────────────────
const MSGS = document.getElementById('msgs');

function addMsg(who, html) {
  const d = document.createElement('div');
  d.className = 'm ' + who;
  if (who === 'a') d.innerHTML = `<div class="av">🧑‍💼</div><div class="bub">${html}</div>`;
  else d.innerHTML = `<div class="bub">${html}</div>`;
  MSGS.appendChild(d);
  return d;
}

function addQRs(replies) {
  if (!replies.length) return;
  const d = document.createElement('div');
  d.className = 'qrs'; d.id = 'qr-now';
  replies.forEach(r => {
    const b = document.createElement('button');
    b.className = 'qr'; b.textContent = r;
    b.onclick = () => { removeQRs(); sendText(r); };
    d.appendChild(b);
  });
  MSGS.appendChild(d);
  scrollBottom();
}

function removeQRs() { const q = document.getElementById('qr-now'); if (q) q.remove(); }

function addVBadge(icon, title, body) {
  const d = document.createElement('div');
  d.className = 'vbadge';
  d.innerHTML = `<div class="vbadge-icon">${icon}</div><div><strong>${title}</strong>${body}</div>`;
  MSGS.appendChild(d);
  scrollBottom();
}

function showTyping() {
  const d = addMsg('a', '');
  d.id = 'typ';
  d.querySelector('.bub').innerHTML = `<div class="typing-bub"><span></span><span></span><span></span></div>`;
}
function hideTyping() { const t = document.getElementById('typ'); if (t) t.remove(); }
function scrollBottom() { setTimeout(() => MSGS.scrollTo({ top: MSGS.scrollHeight, behavior: 'smooth' }), 50); }

// ─── SEND ────────────────────────────────────────────────────────────────
async function send() {
  const inp = document.getElementById('inp');
  const v = inp.value.trim();
  if (!v || busy) return;
  inp.value = ''; inp.style.height = 'auto';
  sendText(v);
}

async function sendText(text) {
  if (busy) return;
  // In dev, require an API key. In prod, the proxy handles auth.
  if (IS_DEV && !API_KEY) {
    addMsg('a', 'Please enter your Anthropic API key at the top to activate Anna.');
    scrollBottom();
    return;
  }
  removeQRs();
  addMsg('u', text);
  scrollBottom();
  busy = true;

  showTyping();
  try {
    const raw = await callClaude(text);
    hideTyping();
    const { displayText, update, qrs } = parseResponse(raw);
    addMsg('a', displayText);
    applyUpdate(update);
    addQRs(qrs);
  } catch (e) {
    hideTyping();
    const status = document.getElementById('ai-status');
    status.className = 'ai-status error';
    status.textContent = '⚠ ' + e.message;
    addMsg('a', `Something went wrong connecting to the API. Check your key and try again.`);
  }
  scrollBottom();
  busy = false;
}

function onKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }
function resize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 100) + 'px'; }

// Expose functions called from HTML onclick attributes
window.saveKey = saveKey;
window.send = send;
window.onKey = onKey;
window.resize = resize;
window.showGrid = showGrid;
window.closeModal = closeModal;
window.doG3 = doG3;

// ─── OPENING ─────────────────────────────────────────────────────────────
async function startConversation() {
  openingDone = true;
  showTyping();
  try {
    // Seed history with a silent system kick
    const raw = await callClaude('START_CONVERSATION');
    hideTyping();
    // Remove the seed from history so it doesn't confuse context
    history = history.filter(m => m.content !== 'START_CONVERSATION');
    const { displayText, update, qrs } = parseResponse(raw);
    addMsg('a', displayText);
    applyUpdate(update);
    addQRs(qrs);
    scrollBottom();
  } catch(e) {
    hideTyping();
    // Fallback opening if API call fails
    addMsg('a', `Hi! I'm Anna 👋 Tell me about your rental — what kind of property is it, and how many do you manage?`);
    addQRs(['One apartment', 'A cabin or cottage', 'Multiple properties', 'Still planning']);
    scrollBottom();
  }
  busy = false;
}

// ─── INIT ─────────────────────────────────────────────────────────────────
if (IS_DEV) {
  // Dev: show fallback greeting immediately; Anna goes live after API key is entered.
  // Pre-fill key input from .env if available.
  if (import.meta.env.VITE_ANTHROPIC_API_KEY) {
    document.getElementById('api-key-input').value = import.meta.env.VITE_ANTHROPIC_API_KEY;
  }
  addMsg('a', `Hi! I'm Anna 👋 Tell me about your rental — what kind of property is it, and how many do you manage?`);
  addQRs(['One apartment', 'A cabin or cottage', 'Multiple properties', 'Still planning my first']);
  scrollBottom();
} else {
  // Prod: banner is hidden, proxy handles auth — start conversation immediately.
  document.getElementById('api-banner').classList.add('hidden');
  document.getElementById('api-confirmed').classList.add('show');
  document.getElementById('ai-status').innerHTML = '<span class="ai-dot"></span> Anna is live · powered by Claude';
  startConversation();
}
