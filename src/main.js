// ─── PIN GATE ─────────────────────────────────────────────────────────────
const PIN_CORRECT = '1608';
let pinBuffer = '';

function pinPress(digit) {
  if (pinBuffer.length >= 4) return;
  pinBuffer += digit;
  updatePinDots();
  if (pinBuffer.length === 4) {
    if (pinBuffer === PIN_CORRECT) {
      document.getElementById('pin-gate').classList.add('unlocked');
      sessionStorage.setItem('ts_unlocked', '1');
    } else {
      const errEl = document.getElementById('pin-error');
      errEl.textContent = 'Incorrect PIN — try again';
      errEl.classList.add('show');
      document.getElementById('pin-gate').classList.add('shake');
      setTimeout(() => {
        pinBuffer = '';
        updatePinDots();
        errEl.classList.remove('show');
        document.getElementById('pin-gate').classList.remove('shake');
      }, 800);
    }
  }
}

function pinDel() {
  if (!pinBuffer.length) return;
  pinBuffer = pinBuffer.slice(0, -1);
  updatePinDots();
  document.getElementById('pin-error').classList.remove('show');
}

function updatePinDots() {
  const dots = document.querySelectorAll('#pin-dots span');
  dots.forEach((d, i) => d.classList.toggle('filled', i < pinBuffer.length));
}

// Auto-unlock if already authenticated this session
document.addEventListener('DOMContentLoaded', () => {
  if (sessionStorage.getItem('ts_unlocked') === '1') {
    const gate = document.getElementById('pin-gate');
    if (gate) gate.classList.add('unlocked');
  }
  // Keyboard support
  document.addEventListener('keydown', e => {
    const gate = document.getElementById('pin-gate');
    if (!gate || gate.classList.contains('unlocked')) return;
    if (e.key >= '0' && e.key <= '9') pinPress(e.key);
    if (e.key === 'Backspace') pinDel();
  });
});

window.pinPress = pinPress;
window.pinDel   = pinDel;

// ─── HELPERS ──────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── GUIDEBOOK STATE ──────────────────────────────────────────────────────
let guidebook = {
  propertyName: 'Villa Azura',
  propertyType: 'villa',
  location:     'Amalfi Coast, Italy',
  hostName:     'Marco & Sofia',
  hostEmail:    '',
  hostPhone:    '',
  checkinTime:  '3:00 PM',
  checkoutTime: '11:00 AM',
  count: 1,
  scraped: false,   // true only after Airbnb/Booking.com import
  sections: {
    'Check-in':       ['Key lockbox at the front gate — code sent 24h before arrival', 'Check-in from 3pm · Check-out by 11am', 'Free parking in the private driveway'],
    'About the Home': ['Heated infinity pool open May–October', 'Netflix & Spotify on the smart TV', 'Espresso machine — pods in the kitchen drawer'],
    'Local Tips':     ['Trattoria da Michele — 5 min walk, book ahead', 'Best sunset view from the terrace at 7:30pm', 'Tuesday morning market on Via Roma'],
    'House Rules':    ['No smoking indoors', 'Quiet hours 11pm–8am', 'Max 6 guests'],
  }
};

// ─── CONVERSATION STATE ───────────────────────────────────────────────────
let convState   = 'PROPERTY_TYPE';
let busy        = false;
let previewStage= 'cover';
let gridBuilt   = false;
let statsShown  = false;
let g3Shown     = false;
let addingCtx   = null;  // 'wifi' | 'rules' | 'tips' | 'general'

// ─── RESTATE PROMPTS (for off-topic recovery) ─────────────────────────────
const RESTATE = {
  PROPERTY_TYPE:    { q: 'What kind of property do you have, and how many?',                       qrs: ['One apartment', 'A cabin or cottage', 'A villa or house', 'Multiple properties'] },
  PLATFORM_LINK:    { q: 'Where do you promote it? Share an Airbnb or Booking.com link for auto-import, or say "add manually".',  qrs: ["Here's my Airbnb link", "I'll add manually"] },
  MANUAL_LOCATION:  { q: 'Where is the property located? City and country is fine.',               qrs: [] },
  MANUAL_CONTACT:   { q: 'What\'s your name and how can guests contact you?',                      qrs: ['Skip contact for now'] },
  WANT_SAVE:        { q: 'Would you like to add more details, or create your free account and do that later?', qrs: ['Add details now', 'Create account & do it later'] },
  ADDING_MORE:      { q: 'Just tell me what to add and I\'ll put it in.',                                      qrs: ['WiFi password', 'House rules', 'Local tips'] },
};

// ─── CONFUSED MESSAGES per state ─────────────────────────────────────────
const CONFUSED = {
  PROPERTY_TYPE:   `What type of property do you rent — apartment, villa, cottage, cabin?`,
  PLATFORM_LINK:   `Do you list on Airbnb or Booking.com? Share a link to auto-import, or say "add manually".`,
  MANUAL_LOCATION: `Where is the property? City and country works — e.g. "Barcelona, Spain".`,
  MANUAL_CONTACT:  `Your name and how guests can reach you (email + optional phone).`,
  WANT_SAVE:       `Add more details now (WiFi, rules, tips) or create your free account and do it later?`,
  ADDING_MORE:     `Just tell me what to add — WiFi details, house rules, local tips, parking…`,
};

// ─── DETECTION HELPERS ────────────────────────────────────────────────────
function detectType(text) {
  const t = text.toLowerCase();
  if (t.match(/apart|flat|condo|studio/))            return 'apartment';
  if (t.match(/cabin|log.*cabin|chalet/))            return 'cabin';
  if (t.match(/villa|manor|estate/))                 return 'villa';
  if (t.match(/cottage|farmhouse|barn/))             return 'cottage';
  if (t.match(/glamping|yurt|tipi|bell.*tent/))      return 'glamping';
  if (t.match(/hotel|b&b|bed.*break|inn/))           return 'hotel';
  return 'house';
}

function detectPlatform(text) {
  const t = text.toLowerCase();
  if (t.includes('airbnb'))                                   return 'airbnb';
  if (t.includes('booking'))                                  return 'booking';
  if (t.match(/vrbo|homeaway|hipcamp|tripadvisor/))           return 'other';
  if (t.match(/manual|don'?t.*list|no.*link|not.*online|add.*detail|i don'?t use|skip|no airbnb|no booking/)) return 'none';
  if (t.match(/https?:\/\//))                                 return 'url';
  return null;
}

function detectOffTopic(text) {
  const t = text.toLowerCase();
  if (t.match(/don'?t understand|what do you mean|not sure what|confused|unclear|huh\b|what\?|pardon/)) return 'confused';
  if (t.match(/\bhow much\b|\bpric(e|ing)\b|\bcost\b|\bfree trial\b|\bsubscri|\bplan\b/))               return 'pricing';
  if (t.match(/what is touch stay|how does (this|it) work|what can (you|this)/))                        return 'about';
  return null;
}

function extractLocation(text) {
  return text.trim()
    .replace(/^(in|at|near|it'?s?( in)?|located in|it is in)\s+/i, '')
    .replace(/[.!]$/, '')
    .trim();
}

// ─── RESPONSE BUILDER ─────────────────────────────────────────────────────
function buildRaw(text, qrs = [], update = {}) {
  return `${text}\n<update>\n${JSON.stringify(update, null, 2)}\n</update>\n${qrs.map(q => `<qr>${q}</qr>`).join('')}`;
}

// ─── MAIN AI SIMULATION ───────────────────────────────────────────────────
async function simulateAnna(input) {
  await sleep(600 + Math.random() * 600);
  const lower = input.toLowerCase().trim();

  // Off-topic / confusion detection (skip in DONE / SCRAPING states)
  if (convState !== 'DONE' && convState !== 'SCRAPING') {
    const ot = detectOffTopic(lower);
    if (ot) {
      const rs = RESTATE[convState] || {};
      if (ot === 'confused') {
        return buildRaw(CONFUSED[convState] || `Let me clarify: ${rs.q || 'how can I help?'}`, rs.qrs || [], {});
      }
      if (ot === 'pricing') {
        return buildRaw(
          `Free 14-day trial, then from £9/month — no card needed. Now let's build your guidebook! ${rs.q || ''}`,
          rs.qrs || [], {}
        );
      }
      if (ot === 'about') {
        return buildRaw(
          `Touch Stay is a digital guidebook for guests — any device, no app download. Hosts save ~3h/week on messages. ${rs.q || ''}`,
          rs.qrs || [], {}
        );
      }
    }
  }

  switch (convState) {
    case 'PROPERTY_TYPE': return doPropertyType(input);
    case 'PLATFORM_LINK': return doPlatformLink(input);
    case 'MANUAL_LOCATION': return doLocation(input);
    case 'MANUAL_CONTACT': return doContact(input);
    case 'WANT_SAVE': return doWantSave(input);
    case 'ADDING_MORE': return doAddMore(input);
    default:
      return buildRaw(`Just fill in the form above to save your guidebook and get your shareable link! 🎉`, [], {});
  }
}

// ─── STATE HANDLERS ───────────────────────────────────────────────────────

function doPropertyType(input) {
  const isMultiple = /multiple|several|portfolio|more than.*one|[2-9]\s*(prop|unit|apart|villa|house|cabin)/i.test(input);
  const type = detectType(input);
  guidebook.propertyType = type;
  guidebook.count = isMultiple ? 'multiple' : 1;

  const names = { apartment:'apartment', cabin:'cabin', villa:'villa', cottage:'cottage', house:'house', glamping:'glamping site', hotel:'property' };
  const typeName = names[type] || 'property';
  const intro = isMultiple ? `Great portfolio! Let's start with the first one. ` : '';

  convState = 'PLATFORM_LINK';
  return buildRaw(
    `${intro}Do you list on <strong>Airbnb or Booking.com</strong>? Share a link and I'll auto-fill everything.`,
    ["Here's my Airbnb link", "I use Booking.com", "I'll add details manually", "I don't list online"],
    { propertyType: type, showCover: true }
  );
}

function doPlatformLink(input) {
  const platform = detectPlatform(input);

  if (platform === 'airbnb' || platform === 'booking') {
    convState = 'SCRAPING';
    return buildRaw(
      `On it — reading your ${platform === 'airbnb' ? 'Airbnb' : 'Booking.com'} listing…`,
      [], { startScrape: true, platform }
    );
  }

  // Anything else or non-Airbnb/Booking URL → go manual
  convState = 'MANUAL_LOCATION';
  return buildRaw(
    `No problem! <strong>Where is the property?</strong> City and country is fine.`,
    ['London, UK', 'Paris, France', 'Barcelona, Spain', 'New York, USA'], {}
  );
}

function doLocation(input) {
  guidebook.location = extractLocation(input);
  updateCoverText();
  convState = 'MANUAL_CONTACT';
  return buildRaw(
    `${guidebook.location} ✓ <strong>What's your name</strong> and how can guests reach you? (email + optional phone)`,
    ['Skip contact for now'],
    { location: guidebook.location }
  );
}

function doContact(input) {
  const emailM = input.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  const phoneM = input.match(/[\+\(]?\d[\d\s\-\(\)]{7,}/);
  let name = input
    .replace(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi, '')
    .replace(/[\+\(]?\d[\d\s\-\(\)]{7,}/g, '')
    .replace(/[,;]/g, ' ')
    .replace(/^(i'?m|my name is|i am|called|name:?)\s+/i, '')
    .replace(/\s+/g, ' ').trim();

  if (name && !input.toLowerCase().includes('skip')) guidebook.hostName = name;
  if (emailM) guidebook.hostEmail = emailM[0];
  if (phoneM) guidebook.hostPhone = phoneM[0].trim();

  updateCoverText();
  convState = 'WANT_SAVE';
  const first = guidebook.hostName?.split(' ')[0] || '';
  return buildRaw(
    `${first ? `Thanks, ${first}!` : `Got it!`} Would you like to <strong>add details now</strong> (WiFi, rules, tips) or <strong>create your free account</strong> and do it later?`,
    ['Add details now', 'Create account & do it later'],
    { hostName: guidebook.hostName, showGrid: true }
  );
}


function doWantSave(input) {
  const lower = input.toLowerCase();

  // "Create account" path — any variation
  if (lower.match(/create.*account|account.*later|do it later|trial|save|get.*link|sign.*up|later/)) {
    convState = 'DONE';
    return buildRaw(
      `Your guidebook is ready — let's get it live! 🎉`,
      [], { showG3: true }
    );
  }

  // "Set up details now" path — any detail type
  if (lower.match(/set.*up|detail|now|wifi|wi.?fi|internet|password|network/)) {
    convState = 'ADDING_MORE'; addingCtx = 'wifi';
    return buildRaw(`What's the <strong>WiFi name and password</strong>?`, [], {});
  }
  if (lower.match(/rule|smok|pet|nois|quiet|party/)) {
    convState = 'ADDING_MORE'; addingCtx = 'rules';
    return buildRaw(`What are your main house rules?`,
      ['No smoking indoors', 'No parties', 'Pets welcome', 'Quiet after 10pm'], {});
  }
  if (lower.match(/tip|restaurant|local|hidden|recommend/)) {
    convState = 'ADDING_MORE'; addingCtx = 'tips';
    return buildRaw(`Your top 2–3 local tips — restaurants, hidden gems, anything guests love?`,
      ['Best local restaurant', 'A hidden viewpoint', 'Best beach or walk'], {});
  }
  if (lower.match(/add|more|another|section/)) {
    convState = 'ADDING_MORE'; addingCtx = 'general';
    return buildRaw(`What would you like to add?`,
      ['WiFi password', 'House rules', 'Local tips', 'Parking info'], {});
  }

  // Fallback — restate the choice
  return buildRaw(
    `<strong>Add details now</strong> (WiFi, rules, tips) or <strong>create your free account</strong> and do it later?`,
    ['Add details now', 'Create account & do it later'], {}
  );
}

function doAddMore(input) {
  const lower = input.toLowerCase();
  let items = [], sectionName = '';

  if (addingCtx === 'wifi') {
    const parts = input.split(/[\n,:|\/]/).map(s => s.trim()).filter(Boolean);
    items = parts.length >= 2
      ? [`Network: ${parts[0]}`, `Password: ${parts[1]}`]
      : [`WiFi: ${input.trim()}`];
    sectionName = 'WiFi';
  } else if (addingCtx === 'rules') {
    items = input.split(/[.,\n]|\band\b/i)
      .map(s => s.trim()).filter(s => s.length > 2)
      .map(s => s[0].toUpperCase() + s.slice(1));
    if (!items.length) items = [input.trim()];
    sectionName = 'House Rules';
  } else if (addingCtx === 'tips') {
    items = input.split(/[.,\n]|\band\b/i)
      .map(s => s.trim()).filter(s => s.length > 2)
      .map(s => s[0].toUpperCase() + s.slice(1));
    if (!items.length) items = [input.trim()];
    sectionName = 'Local Tips';
  } else if (lower.match(/park/)) {
    items = [input.trim()]; sectionName = 'Parking';
  } else {
    items = [input.trim()]; sectionName = 'Welcome';
  }

  addingCtx = null;
  convState = 'WANT_SAVE';
  return buildRaw(
    `✓ Added to your guidebook! Anything else to add, or ready to create your account?`,
    ['Add more details', 'Create account & do it later'],
    { newSection: { name: sectionName, items } }
  );
}

// ─── SIMULATED AIRBNB / BOOKING SCRAPE ────────────────────────────────────
// Both platforms resolve to Villa Azura — the canonical demo property
const VILLA_AZURA_DATA = {
  propertyName: 'Villa Azura',
  propertyType: 'villa',
  location:     'Amalfi Coast, Italy',
  hostName:     'Marco & Sofia',
  heroPhoto:    'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&q=80',
  checkinTime:  '3:00 PM',
  checkoutTime: '11:00 AM',
  sections: {
    'About the Home':   ['Sleeps 8 · 4 bedrooms · 3 bathrooms', 'Private infinity pool with panoramic coast views', 'Fully equipped kitchen with espresso bar', 'High-speed WiFi throughout'],
    'House Rules':      ['No smoking indoors', 'No parties or events', 'Pets welcome with prior agreement', 'Quiet hours 11 pm – 8 am'],
    'Wi-Fi & Internet': ['Network: VillaAzura_Guest', 'Password: amalfi2024', 'Speed: 300 Mbps fibre'],
    'Local Tips':       ['Da Adolfo beach restaurant — accessible by boat, unmissable', 'Take the Path of the Gods for panoramic views', 'Pick up limoncello direct from the hillside farm'],
    'Parking':          ['Private driveway for 2 cars', 'Additional street parking on Via Cristoforo Colombo'],
  }
};

const FAKE_LISTINGS = {
  airbnb:  { ...VILLA_AZURA_DATA, rating: '4.97', reviews: '218 reviews' },
  booking: { ...VILLA_AZURA_DATA, rating: '9.8',  reviews: '142 reviews' },
};

function doScrapeComplete(platform) {
  const data = FAKE_LISTINGS[platform] || FAKE_LISTINGS.airbnb;

  // Update guidebook state
  guidebook.propertyName = data.propertyName;
  guidebook.propertyType = data.propertyType;
  guidebook.location     = data.location;
  guidebook.hostName     = data.hostName;
  guidebook.checkinTime  = data.checkinTime;
  guidebook.checkoutTime = data.checkoutTime;
  Object.assign(guidebook.sections, data.sections);

  const platformLabel = platform === 'airbnb' ? 'Airbnb' : 'Booking.com';
  const html = `Imported! Here's what I found:
<div class="artifact">
  <div class="artifact-head">${platformLabel} · ${data.rating}⭐ · ${data.reviews}</div>
  <div class="artifact-body">
    <div class="artifact-row">🏠 <strong>${data.propertyName}</strong></div>
    <div class="artifact-row">📍 ${data.location}</div>
    <div class="artifact-row">👤 Hosted by ${data.hostName}</div>
  </div>
</div>
Want to <strong>add more details</strong> (WiFi, rules, tips) or <strong>create your account</strong> now?`;

  hideTyping();
  addMsg('a', html);
  updateCoverText();

  // Update hero photo — prefer explicit heroPhoto, fall back to type mapping
  const src = data.heroPhoto || HERO_IMGS[data.propertyType] || HERO_IMGS.villa;
  guidebook.heroPhoto = src;
  const photo = document.getElementById('hero-photo');
  const img = new Image();
  img.onload = () => { photo.style.backgroundImage = `url('${src}')`; photo.classList.add('loaded'); };
  img.src = src;

  // Update check-in bar
  const ciVal = document.getElementById('checkin-val');
  const coVal = document.getElementById('checkout-val');
  if (ciVal) ciVal.textContent = data.checkinTime;
  if (coVal) coVal.textContent = data.checkoutTime;

  // Show cover → grid
  if (!gridBuilt) {
    if (previewStage === 'cover') buildGrid();
    else { renderCover(); setTimeout(buildGrid, 600); }
  }
  Object.keys(data.sections).forEach(name => addOrUpdateTile(name));

  guidebook.scraped = true;
  addQRs(['Set up details now', 'Create account & do it later']);
  scrollBottom();
  convState = 'WANT_SAVE';
  busy = false;
}

// ─── PARSE RESPONSE ───────────────────────────────────────────────────────
function parseResponse(raw) {
  const updateMatch = raw.match(/<update>([\s\S]*?)<\/update>/);
  let update = null;
  if (updateMatch) {
    try { update = JSON.parse(updateMatch[1].trim()); } catch(e) {}
  }
  const qrs = [];
  for (const m of raw.matchAll(/<qr>(.*?)<\/qr>/g)) qrs.push(m[1]);
  const displayText = raw
    .replace(/<update>[\s\S]*?<\/update>/g, '')
    .replace(/<qr>.*?<\/qr>/g, '')
    .trim();
  return { displayText, update, qrs };
}

// ─── APPLY GUIDEBOOK UPDATE ───────────────────────────────────────────────
function applyUpdate(u) {
  if (!u) return;
  if (u.propertyName) { guidebook.propertyName = u.propertyName; }
  if (u.propertyType) { guidebook.propertyType = u.propertyType; }
  if (u.location)     { guidebook.location = u.location; }
  if (u.hostName)     { guidebook.hostName = u.hostName; }
  if (u.newSection)   {
    guidebook.sections[u.newSection.name] = u.newSection.items;
    if (gridBuilt) addOrUpdateTile(u.newSection.name);
  }

  updateCoverText();

  // Stage transitions
  if (u.showCover && previewStage === 'empty') {
    setState('skel');
    setTimeout(() => renderCover(), 1200);
  }
  if (u.showGrid) {
    if (!gridBuilt) {
      if (previewStage === 'cover') setTimeout(buildGrid, 300);
      else { renderCover(); setTimeout(buildGrid, 800); }
    }
  }
  if (u.showStats && !statsShown) { statsShown = true; setTimeout(showStats, 400); }
  if (u.showG3 && !g3Shown)      { g3Shown = true; setTimeout(showG3panel, 600); }

  // Scrape trigger — stay busy until doScrapeComplete fires
  if (u.startScrape) {
    const platform = u.platform;
    setTimeout(() => {
      showTyping();
      setTimeout(() => doScrapeComplete(platform), 1600 + Math.random() * 900);
    }, 350);
  }
}

// ─── COVER TEXT UPDATER ───────────────────────────────────────────────────
function updateCoverText() {
  // Only update the live preview when data came from a real scrape.
  // The manual-path conversation collects info but keeps the demo
  // template visible until the user has a real imported guidebook.
  if (!guidebook.scraped) return;
  const pn = document.getElementById('prop-name');
  const pa = document.getElementById('prop-addr');
  const gr = document.getElementById('host-greeting');
  if (pn && guidebook.propertyName) pn.textContent = guidebook.propertyName;
  if (pa && guidebook.location)     pa.textContent = guidebook.location;
  if (gr && guidebook.hostName)     gr.innerHTML   = `Hi, I'm your host, ${guidebook.hostName} 👋`;
}

// ─── PREVIEW RENDERING ────────────────────────────────────────────────────
const HERO_IMGS = {
  cabin:     'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=600&q=75',
  apartment: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=600&q=75',
  villa:     'https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=600&q=75',
  glamping:  'https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?w=600&q=75',
  cottage:   'https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=600&q=75',
  house:     'https://images.unsplash.com/photo-1480074568708-e7b720bb3f09?w=600&q=75',
  hotel:     'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=600&q=75',
};

function renderCover() {
  const type = guidebook.propertyType || 'villa';
  const src  = HERO_IMGS[type] || HERO_IMGS.villa;
  const photo = document.getElementById('hero-photo');
  const img = new Image();
  img.onload = () => { photo.style.backgroundImage = `url('${src}')`; photo.classList.add('loaded'); };
  img.src = src;
  updateCoverText();
  setState('cover');
}

// ─── TILE ICONS & GRID ────────────────────────────────────────────────────
const TILE_ICONS = {
  'Welcome':          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M18 11V6a2 2 0 00-2-2 2 2 0 00-2 2v1a2 2 0 00-2-2 2 2 0 00-2 2v3a2 2 0 00-2-2 2 2 0 00-2 2v5c0 3.31 2.69 6 6 6h2c3.31 0 6-2.69 6-6v-5"/></svg>`,
  'Before You Leave': `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  'Check-in':         `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`,
  'About the Home':   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
  'Local Tips':       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  'Restaurants':      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M18 8h1a4 4 0 010 8h-1"/><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>`,
  'Activities':       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="5" r="1"/><path d="M9 20l3-8 3 8"/><path d="M6 8l2 4h8l2-4"/></svg>`,
  'Parking':          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1" y="3" width="22" height="18" rx="2"/><path d="M1 9h22"/></svg>`,
  'House Rules':      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  'WiFi':             `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 12.55a11 11 0 0114.08 0"/><path d="M1.42 9a16 16 0 0121.16 0"/><path d="M8.53 16.11a6 6 0 016.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>`,
  'Check-out':        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
};

const BASE_TILES = ['Welcome','Before You Leave','Check-in','About the Home','Local Tips','Restaurants','Activities','Parking'];

function getIcon(name) {
  for (const [k, v] of Object.entries(TILE_ICONS)) {
    if (name.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return TILE_ICONS['About the Home'];
}

function buildGrid() {
  if (gridBuilt) return;
  gridBuilt = true;
  const grid = document.getElementById('gb-grid');
  grid.innerHTML = '';
  BASE_TILES.forEach((name, i) => addTile(name, i * 0.05, !!guidebook.sections[name]));
  setState('grid');
}

function addTile(name, delay = 0, highlight = false) {
  const grid = document.getElementById('gb-grid');
  const d = document.createElement('div');
  d.className = 'gb-tile' + (highlight ? ' new' : '');
  d.id = 'tile-' + name.replace(/\s/g, '-');
  d.style.animationDelay = delay + 's';
  d.innerHTML = `<div class="gb-tile-icon">${getIcon(name)}</div><div class="gb-tile-lbl">${name}</div>`;
  d.onclick = () => openModal(name);
  grid.appendChild(d);
}

function addOrUpdateTile(name) {
  const el = document.getElementById('tile-' + name.replace(/\s/g, '-'));
  if (el) el.classList.add('new');
  else    addTile(name, 0, true);
}

function openModal(name) {
  document.getElementById('modal-title').textContent = name;
  document.getElementById('modal-icon').innerHTML = `<div style="color:var(--teal)">${getIcon(name)}</div>`;
  const items = guidebook.sections[name] || ['Your host is adding this — check back soon.'];
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
    el.classList.toggle('on', s === id);
  });
  previewStage = id;
}

function showGrid() {
  if (!gridBuilt) buildGrid();
  else setState('grid');
}

// ─── STATS & G3 ───────────────────────────────────────────────────────────
function showStats() {
  document.getElementById('stats-row').style.display = 'flex';
  setTimeout(() => document.getElementById('st-a').classList.add('on'), 100);
  setTimeout(() => document.getElementById('st-b').classList.add('on'), 300);
  addVBadge('⏰', 'Saves ~3 hours a week', ' — Hosts who answer pre-arrival questions in their guidebook report the biggest drop in guest messages.');
}

function showG3panel() {
  g3Shown = true;

  // Build the card HTML
  const card = document.createElement('div');
  card.className = 'm a';
  card.id = 'g3-msg';
  card.innerHTML = `<div class="av">A</div><div class="bub g3-bub"><div class="g3-chat-card">
    <div class="g3-card-head">
      <svg viewBox="0 0 24 24" fill="none" width="16" height="16"><path d="M12 2L2 8v14h7v-7h6v7h7V8L12 2z" fill="var(--teal)"/></svg>
      Touch Stay
    </div>
    <h4>Save your guidebook</h4>
    <div class="g3-fields">
      <div class="g3-field">
        <label class="g3-label">Your name</label>
        <input type="text" class="g3-input" placeholder="e.g. Sarah" id="g3-name">
      </div>
      <div class="g3-field">
        <label class="g3-label">E-mail</label>
        <input type="email" class="g3-input" placeholder="e.g. sarah@email.com" id="g3-email">
      </div>
      <div class="g3-field">
        <label class="g3-label">Password</label>
        <input type="password" class="g3-input" placeholder="Choose a password (min 6 chars)" id="g3-pass">
      </div>
      <div class="g3-field">
        <label class="g3-label">Phone <span class="g3-optional">Optional</span></label>
        <input type="tel" class="g3-input" placeholder="e.g. +44 7700 900000" id="g3-tel">
      </div>
      <button class="g3-cta" onclick="doG3()">Create my free account</button>
    </div>
    <div class="g3-or">— or —</div>
    <div class="g3-sso">
      <button class="g3-sso-btn" disabled style="opacity:.45;cursor:not-allowed">
        <svg viewBox="0 0 24 24" width="15" height="15"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
        Google <span style="font-size:9px;color:#94a3b8;margin-left:2px">Coming soon</span>
      </button>
      <button class="g3-sso-btn" disabled style="opacity:.45;cursor:not-allowed">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="#1877F2"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
        Facebook <span style="font-size:9px;color:#94a3b8;margin-left:2px">Coming soon</span>
      </button>
    </div>
    <p class="g3-terms">By creating an account you accept our <a href="#">Terms &amp; Conditions</a> and <a href="#">Privacy Policy</a>.</p>
  </div></div>`;

  MSGS.appendChild(card);

  // Prefill from conversation
  setTimeout(() => {
    const n = document.getElementById('g3-name');
    const e = document.getElementById('g3-email');
    const t = document.getElementById('g3-tel');
    if (n && guidebook.hostName  && !n.value) n.value = guidebook.hostName;
    if (e && guidebook.hostEmail && !e.value) e.value = guidebook.hostEmail;
    if (t && guidebook.hostPhone && !t.value) t.value = guidebook.hostPhone;
  }, 80);

  scrollBottom();
  document.getElementById('demo-cta').style.display = 'block';
}

function doG3() {
  const nameEl  = document.getElementById('g3-name');
  const emailEl = document.getElementById('g3-email');
  const passEl  = document.getElementById('g3-pass');
  const email   = emailEl?.value.trim();
  const pass    = passEl?.value.trim();

  if (!email) { emailEl?.focus(); return; }
  if (!pass || pass.length < 6) {
    if (passEl) {
      passEl.focus();
      passEl.style.borderColor = '#dc2626';
      passEl.placeholder = 'Min 6 characters required';
      setTimeout(() => { passEl.style.borderColor = ''; passEl.placeholder = 'Choose a password (min 6 chars)'; }, 2500);
    }
    return;
  }

  // Collapse the form to a success state
  const card = document.querySelector('.g3-chat-card');
  if (card) {
    card.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:4px 0">
      <div style="width:32px;height:32px;border-radius:50%;background:var(--teal);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:15px">✓</div>
      <div><strong style="color:var(--navy-h);font-size:13px">Account created!</strong><br><span style="font-size:12px;color:var(--slate)">Welcome, ${nameEl?.value.trim() || email.split('@')[0]}</span></div>
    </div>`;
  }

  const displayName = nameEl?.value.trim() || email.split('@')[0];
  if (nameEl?.value.trim()) guidebook.hostName = nameEl.value.trim();
  setTimeout(() => {
    addMsg('a', `You're all set, ${displayName} 🎉 Setting up your workspace now…`);
    scrollBottom();
  }, 400);
  setTimeout(() => transitionToApp(displayName, email), 1800);
}

// ─── IN-APP EXPERIENCE ────────────────────────────────────────────────────

const APP_AGENTS = {
  anna:   { name: 'Anna',   role: 'General assistant',      emoji: '👩‍💼', color: '#3ED9CC' },
  alex:   { name: 'Alex',   role: 'Front Desk Agent',       emoji: '🛎️', color: '#6C63FF' },
  taylor: { name: 'Taylor', role: 'IT & Integrations',      emoji: '🔧', color: '#F59E0B' },
  sam:    { name: 'Sam',    role: 'Store & Upsells',        emoji: '🛍️', color: '#EC4899' },
};

let activeAgent   = 'anna';
let appBusy       = false;
let appConvState  = 'GUIDEBOOK_START'; // state machine for in-app flow
let inactivityTimer = null;

// ─── CLAUDE AI INTEGRATION ───────────────────────────────────────────────
// Use real AI on deployed Vercel; simulation on localhost
const USE_AI = typeof location !== 'undefined' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';

const AGENT_PROMPTS = {
  anna: `You are Anna, an AI Guest Experience assistant at Touch Stay. You help property hosts create the best possible guest experience — from a shareable digital guidebook to automated communication and revenue tools.

Personality: Warm, helpful, efficient. You make the process feel easy and exciting. The value you communicate is NOT just "a beautiful guidebook" — it's helping hosts provide an amazing guest experience while saving them time and earning more.

Features you set up:
- Property details (type, location, check-in/out times)
- Cover photo, arrival & access instructions, WiFi credentials
- Local recommendations & tips
- Shareable guidebook link — guests have everything they need before arrival
- "Leave a Review" feature — routes 1-3 star reviews privately to the host (protecting them), sends 4-5 star guests to Google Places or TripAdvisor

Problems you solve for hosts:
- Guests arriving confused without key information
- Hours spent answering the same questions
- Bad reviews going public before the host can address them
- No structured way to deliver the guest experience

After the guidebook is set up, celebrate and explain what else Touch Stay can do — nudge toward Alex (automate guest communication, reduce messages by 90%) or Sam (earn an extra £80-150 per booking with Guest Store). Frame everything around the guest experience, not just the guidebook.

Keep responses concise (2-3 sentences max). Use emoji sparingly. Be conversational, not robotic.`,

  alex: `You are Alex, the Front Desk Agent at Touch Stay. You automate guest communication so hosts never answer the same question twice.

Personality: Technical but approachable. You make complex automations feel simple.

Features you set up:
1. Booking channel connection — sync Airbnb, Booking.com, Vrbo, direct bookings so guest data flows automatically
2. PMS integration — Guesty, Hostaway, Lodgify, Smoobu for centralised management
3. Automated message schedules — pre-written SMS/email templates on schedules (booking confirmation, pre-arrival 3 days before, check-in morning, mid-stay day 2, post-stay review request). Host can edit templates but Touch Stay pre-defines them. These are NOT the same as the AI chatbot.
4. AI Guest Chatbot — lives inside the guidebook, guests ask it anything 24/7 and it answers from guidebook content. Separate feature from automated messages.
5. Contact collection — capture guest details for compliance, guest registration, and potential direct rebookings
6. Campaigns — promote specific guidebook topics (local recommendations, key events) via banners shown to guests

Problems you solve:
- Same 10 questions from every guest
- Answering WhatsApp messages at midnight
- Not collecting guest contacts for direct rebooking
- Guests missing the best local tips in the guidebook

Keep responses concise (2-3 sentences max). Be conversational.`,

  taylor: `You are Taylor, the IT & Integrations specialist at Touch Stay. You connect the host's tech stack and automate the guest experience from booking to checkout.

Personality: Technical and precise, but patient and clear.

Features you handle:
- PMS integrations — deep config, field mapping, sync bookings to Touch Stay
- OTA integrations — sync bookings to automated invitations with key info + guidebook link
- Viator integration — source local experiences automatically for the guidebook
- Booking-triggered automations — when a booking happens, automatically start the guest experience (messages, guidebook access, invitations)

Problems you solve:
- PMS and booking platforms not syncing with Touch Stay
- Manually sending guidebook links after every booking
- Wanting local experiences in the guidebook without time to curate them
- Guest experience not starting automatically when a booking comes in

Keep responses concise (2-3 sentences). Be technical but clear.`,

  sam: `You are Sam, the Store & Upsells specialist at Touch Stay. You help hosts earn more from every stay with zero extra effort.

Personality: Enthusiastic about revenue. You make upselling feel natural, not salesy.

Features you set up:
- Guest Store with upsell services: early check-in/late check-out (£20-40), welcome hampers (£30-60), bike hire (£15-30/day), wine on arrival (£20-35), local experiences/tours (£30-80), airport transfers (£40-80)
- Stripe integration — collect payments automatically, no manual invoicing
- Campaigns — banners in the guidebook promoting products/services to guests
- Pricing based on location benchmarks
- Services appear on the guidebook welcome screen — guests browse and purchase before arrival

Problems you solve:
- Leaving money on the table — guests would pay for extras but host never offers
- Collecting payments being awkward and manual
- Not knowing what to charge or what guests want in their area

Keep responses concise (2-3 sentences). Be conversational.`
};

let agentHistory = { anna: [], alex: [], taylor: [], sam: [] };

/**
 * Call Claude via the /api/chat proxy.
 * @param {string} agentId - Which agent persona
 * @param {string} userMessage - What the user said
 * @param {string|null} hint - Optional instruction for this specific step
 *        e.g. "Confirm their check-in/out times and ask about cover photo."
 *        Gives Claude direction while letting it phrase things naturally.
 */
async function callAgent(agentId, userMessage, hint = null) {
  if (!USE_AI) return null;
  const history = agentHistory[agentId];
  history.push({ role: 'user', content: userMessage });

  const gbContext = JSON.stringify({
    propertyName: guidebook.propertyName,
    location: guidebook.location || guidebook.propAddr,
    propertyType: guidebook.propertyType,
    hostName: guidebook.hostName
  });

  let systemPrompt = AGENT_PROMPTS[agentId]
    + `\n\nCurrent guidebook: ${gbContext}`;
  if (hint) systemPrompt += `\n\nIMPORTANT — your next response MUST: ${hint}`;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 250,
        system: systemPrompt,
        messages: history.slice(-10)
      })
    });
    if (!res.ok) { history.pop(); return null; }
    const data = await res.json();
    const reply = data.content?.[0]?.text || null;
    if (reply) history.push({ role: 'assistant', content: reply });
    return reply;
  } catch (e) {
    history.pop();
    return null;
  }
}

// Extra data collected inside the app
let appData = {
  checkin: '', checkout: '', coverPhoto: '',
  arrivalInfo: '', wifi: '', localSpots: '',
  pmsChoice: '', bookingChannel: '', alexStep: 0,
  samConfirmed: false,
};

// Cover photos by property type (for photo suggestions)
const COVER_PHOTOS = {
  villa:     'https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=800&q=80',
  apartment: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800&q=80',
  cabin:     'https://images.unsplash.com/photo-1449158743715-0a90ebb6d2d8?w=800&q=80',
  cottage:   'https://images.unsplash.com/photo-1518780664697-55e3ad937233?w=800&q=80',
  house:     'https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=800&q=80',
  glamping:  'https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?w=800&q=80',
  hotel:     'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800&q=80',
};

// Topic templates keyed by keyword
const TOPIC_TEMPLATES = [
  { key: 'wifi',      title: 'Wi-Fi & Internet',      text: 'Network: <strong>GuestWifi</strong><br>Password: <em>(tap to reveal)</em><br>Speed: 200 Mbps fibre',                                               img: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=80' },
  { key: 'check',     title: 'Check-in & Check-out',  text: 'Self check-in via lockbox at the front door.<br>Check-in: <strong>3:00 PM</strong> · Check-out: <strong>11:00 AM</strong>',                     img: 'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?w=400&q=80' },
  { key: 'park',      title: 'Parking',               text: 'One dedicated space in the underground car park (Level B1, Bay 12). Height limit 2.1 m. Additional street parking available Mon–Sat.',             img: 'https://images.unsplash.com/photo-1470224114660-3f6686c562eb?w=400&q=80' },
  { key: 'kitchen',   title: 'Kitchen & Appliances',  text: 'Fully equipped kitchen: espresso machine, dishwasher, oven, hob. Starter pack of coffee, tea, and cooking essentials provided.',                  img: 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=400&q=80' },
  { key: 'rule',      title: 'House Rules',           text: '• No smoking indoors<br>• Quiet hours after 10 PM<br>• No parties without prior approval<br>• Pets welcome with a refundable deposit',            img: 'https://images.unsplash.com/photo-1484154218962-a197022b5858?w=400&q=80' },
  { key: 'local',     title: 'Local Recommendations', text: 'Our favourite spots: <strong>Café del Mar</strong> (5 min walk), <strong>Trattoria Zio</strong> (ask for Marco!), Sunday market on the piazza.', img: 'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=400&q=80' },
  { key: 'transport', title: 'Getting Around',        text: 'Bus stop 2 min walk (lines 14, 22). Nearest taxi rank at the station. Citymapper app recommended for real-time routes.',                           img: 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?w=400&q=80' },
  { key: 'emergency', title: 'Emergency Contacts',    text: 'Host: available via WhatsApp 24/7.<br>Emergency services: 112<br>Nearest hospital: 10 min by taxi.',                                              img: 'https://images.unsplash.com/photo-1587654780291-39c9404d746b?w=400&q=80' },
];

function findTopicTemplate(input) {
  const low = input.toLowerCase();
  return TOPIC_TEMPLATES.find(t => low.includes(t.key)) || null;
}

function buildTopicCard(title, text, img) {
  return `<div class="topic-card">
    <div class="tc-image" style="background-image:url('${img}')"></div>
    <div class="tc-body">
      <div class="tc-title">${title}</div>
      <div class="tc-text">${text}</div>
      <button class="tc-edit" onclick="editTopic('${title.replace(/'/g, "\\'")}')">Edit topic</button>
    </div>
  </div>`;
}

const AGENT_LABELS = { anna: 'Guidebook Setup', alex: 'Guest Comms', taylor: 'Integrations', sam: 'Revenue & Store' };
let lastAgentInChat = null;

function appAddMsg(who, html) {
  const AMSGS = document.getElementById('app-msgs');
  if (!AMSGS) return;
  const agent = APP_AGENTS[activeAgent] || APP_AGENTS.anna;

  // Show role-label divider when agent switches
  if (who === 'a' && activeAgent !== lastAgentInChat) {
    lastAgentInChat = activeAgent;
    const divider = document.createElement('div');
    divider.className = 'agent-divider';
    divider.innerHTML = `<div class="agent-divider-dot" style="background:${agent.color}"></div><span class="agent-divider-label">${AGENT_LABELS[activeAgent] || activeAgent}</span><div class="agent-divider-line"></div>`;
    AMSGS.appendChild(divider);
  }

  const d = document.createElement('div');
  d.className = 'm ' + who + (who === 'a' ? ` agent-${activeAgent}` : '');
  if (who === 'a') {
    d.innerHTML = `<div class="bub">${html}</div>`;
  } else {
    d.innerHTML = `<div class="bub">${html}</div>`;
  }
  AMSGS.appendChild(d);
  setTimeout(() => AMSGS.scrollTo({ top: AMSGS.scrollHeight, behavior: 'smooth' }), 50);
  return d;
}

function appShowTyping() {
  const d = appAddMsg('a', '');
  if (d) { d.id = 'app-typ'; d.querySelector('.bub').innerHTML = `<div class="typing-bub"><span></span><span></span><span></span></div>`; }
}
function appHideTyping() { const t = document.getElementById('app-typ'); if (t) t.remove(); }

function appAddQRs(replies) {
  if (!replies || !replies.length) return;
  const AMSGS = document.getElementById('app-msgs');
  if (!AMSGS) return;
  const d = document.createElement('div');
  d.className = 'qrs'; d.id = 'app-qr-now';
  replies.forEach(r => {
    const b = document.createElement('button');
    b.className = 'qr'; b.textContent = r;
    b.onclick = () => { const q = document.getElementById('app-qr-now'); if (q) q.remove(); appSendText(r); };
    d.appendChild(b);
  });
  AMSGS.appendChild(d);
  setTimeout(() => AMSGS.scrollTo({ top: AMSGS.scrollHeight, behavior: 'smooth' }), 50);
}

// ─── INACTIVITY NUDGE ─────────────────────────────────────────────────────
function resetInactivity() {
  clearTimeout(inactivityTimer);
  // Only nudge when guidebook is complete and we haven't already prompted
  if (appConvState === 'GUIDEBOOK_DONE' || appConvState === 'UPSELL') {
    inactivityTimer = setTimeout(async () => {
      appConvState = 'IDLE_REVIEW';
      const aiNudge = await callAgent('anna', '(User has been idle)', `Nudge the user about the Leave a Review feature. Explain: it protects their review scores by routing 1-3 star feedback privately to them in Touch Stay (so they can address issues before they go public), while 4-5 star guests get directed to Google Places or TripAdvisor. Ask if they want to activate it. Be gentle and helpful. 2-3 sentences.`);
      appAddMsg('a', aiNudge || `One more thing while you're here — <strong>Leave a Review</strong> protects your scores 🌟 1–3 star feedback comes privately to you in Touch Stay so you can address issues. 4–5 star guests get nudged to leave reviews on Google Places or TripAdvisor. Want to activate it?`);
      appAddQRs(['Yes, activate it', 'Maybe later']);
    }, 5000);
  }
}

// ─── APP RESPONSE STATE MACHINE ───────────────────────────────────────────
function appShareLink() {
  const slug = (guidebook.propName || guidebook.propertyName || 'my-property').toLowerCase().replace(/\s+/g, '-');
  return `<code style="font-size:11px;background:rgba(62,217,204,.12);color:#1a6b64;padding:4px 10px;border-radius:6px;display:inline-block;margin-top:4px;word-break:break-all">guide.touchstay.com/${slug}</code>`;
}

async function simulateAppResponse(input) {
  await sleep(400 + Math.random() * 300);
  const low = input.toLowerCase();

  // ── ALEX FLOW ──────────────────────────────────────────────────────────
  if (activeAgent === 'alex') return doAlexFlow(low, input);
  // ── SAM FLOW ───────────────────────────────────────────────────────────
  if (activeAgent === 'sam')  return doSamFlow(low, input);
  // ── TAYLOR FLOW (fully AI-driven) ─────────────────────────────────────
  if (activeAgent === 'taylor') {
    if (low.includes('back') || low.includes('anna')) { selectAgent('anna'); return { text: '', qrs: [] }; }
    const aiTaylor = await callAgent('taylor', input);
    if (aiTaylor) return { text: aiTaylor, qrs: ['Smart lock setup', 'PMS integration', 'API docs', 'Back to Anna'] };
    return { text: `I can help with PMS connections, smart locks, noise monitors, and API setup. What do you need?`, qrs: ['Smart lock setup', 'PMS integration', 'API docs', 'Back to Anna'] };
  }

  // ── ANNA FLOW (state machine) ──────────────────────────────────────────
  switch (appConvState) {

    case 'GUIDEBOOK_CHECKIN': {
      const times = input.match(/\d+(?::\d+)?\s*(?:am|pm)/gi) || [];
      appData.checkin  = times[0] || input.split(/[\/,\-]/)[0]?.trim() || '3:00 PM';
      appData.checkout = times[1] || input.split(/[\/,\-]/)[1]?.trim() || '11:00 AM';
      const ciEl = document.getElementById('app-st-cover')?.querySelector('.gb-checkin-val');
      const coEl = document.getElementById('app-st-cover')?.querySelectorAll('.gb-checkin-val')[1];
      if (ciEl) ciEl.textContent = appData.checkin;
      if (coEl) coEl.textContent = appData.checkout;
      appConvState = 'GUIDEBOOK_COVER';
      const propType = guidebook.propertyType || 'villa';
      const suggestedPhoto = COVER_PHOTOS[propType] || COVER_PHOTOS.villa;
      appData.coverPhoto = suggestedPhoto;
      const heroEl = document.getElementById('app-hero-photo');
      if (heroEl) { heroEl.style.backgroundImage = `url('${suggestedPhoto}')`; heroEl.classList.add('loaded'); }
      const ai = await callAgent('anna', input, `Confirm check-in ${appData.checkin} and check-out ${appData.checkout}. Then tell them you added a cover photo based on their ${propType} and ask if they want to keep it or paste a different image URL. 2-3 sentences.`);
      return { text: ai || `Got it — check-in ${appData.checkin}, check-out ${appData.checkout} ✓<br><br>I've added a cover photo based on your property type. <strong>Want to use a different one?</strong> Paste any image URL, or keep this one.`, qrs: ['Keep this photo', 'Use a different photo'] };
    }

    case 'GUIDEBOOK_COVER': {
      if (!low.includes('keep') && !low.includes('this') && input.match(/https?:\/\//)) {
        appData.coverPhoto = input.trim();
        const heroEl2 = document.getElementById('app-hero-photo');
        if (heroEl2) { heroEl2.style.backgroundImage = `url('${appData.coverPhoto}')`; heroEl2.classList.add('loaded'); }
      }
      appConvState = 'GUIDEBOOK_ARRIVAL';
      const ai2 = await callAgent('anna', input, `Acknowledge their cover photo choice. Then ask how guests get in — key lockbox, smart lock code, or do they meet guests in person? 2 sentences.`);
      return { text: ai2 || `Looking good! Now — <strong>how do guests get in?</strong> Key lockbox, smart lock, meet & greet?`, qrs: ['Key lockbox', 'Smart lock', 'I meet them in person'] };
    }

    case 'GUIDEBOOK_ARRIVAL': {
      appData.arrivalInfo = input;
      appAddToGrid('Arrival & Check-in', TOPIC_TEMPLATES.find(t => t.key === 'check')?.img || '');
      appConvState = 'GUIDEBOOK_WIFI';
      const ai3 = await callAgent('anna', input, `Confirm you've added their arrival info ("${input}") to the guidebook. Then ask for the WiFi network name and password. 2 sentences.`);
      return { text: ai3 || `Perfect ✓ What's the <strong>WiFi name and password</strong>?`, qrs: ['No WiFi'] };
    }

    case 'GUIDEBOOK_WIFI': {
      if (!low.includes('no wifi') && !low.includes('no wi-fi')) {
        appData.wifi = input;
        const parts = input.split(/[\n,:|\/]/).map(s => s.trim()).filter(Boolean);
        const wifiTmpl = TOPIC_TEMPLATES.find(t => t.key === 'wifi');
        const wifiText = parts.length >= 2
          ? `Network: <strong>${parts[0]}</strong><br>Password: <strong>${parts[1]}</strong>`
          : `WiFi: <strong>${input}</strong>`;
        appAddToGrid('Wi-Fi & Internet', wifiTmpl?.img || '');
        appAddMsg('a', `Added! ${buildTopicCard('Wi-Fi & Internet', wifiText, wifiTmpl?.img || '')}`);
      }
      appConvState = 'GUIDEBOOK_SPOTS';
      const ai4 = await callAgent('anna', input, `${low.includes('no wifi') ? 'Acknowledge no WiFi, no problem.' : 'WiFi is saved.'} Almost done — ask for their favourite local spots: restaurants, cafes, hidden gems to recommend to guests. 2 sentences.`);
      return { text: ai4 || `Almost done! <strong>Any local favourites?</strong> Restaurants, cafes, hidden gems — I'll add them as recommendations for your guests.`, qrs: ['Skip for now', 'Best local restaurant', 'Add a few'] };
    }

    case 'GUIDEBOOK_SPOTS': {
      if (!low.includes('skip')) {
        appData.localSpots = input;
        const localTmpl = TOPIC_TEMPLATES.find(t => t.key === 'local');
        appAddToGrid('Local Recommendations', localTmpl?.img || '');
        appAddMsg('a', `Added to your guidebook ✓`);
      }
      appConvState = 'GUIDEBOOK_DONE';
      appShowGrid();
      const link = appShareLink();
      const ai5 = await callAgent('anna', input, `The guest experience is set up! Celebrate. Tell them to share this link in every booking confirmation — guests will have everything they need before arrival, reducing questions and giving them an amazing first impression. Then mention two ways to level up: (1) automate guest communication and reduce questions by 90% (Alex can set this up), or (2) earn an extra £80-150 per booking with the Guest Store (Sam). Frame it around guest experience, not just the guidebook. 3-4 sentences max.`);
      return {
        text: (ai5 ? ai5 + `<br>${link}` : `Your guest experience is ready! 🎉<br>${link}<br><br>Share that link in every booking confirmation — guests get everything they need before arrival, and you'll see fewer repetitive questions immediately.<br><br>Want to go further? <strong>Alex</strong> can automate your guest communication (reduce questions by 90%), or <strong>Sam</strong> can set up a Guest Store to earn an extra £80-150 per booking.`),
        qrs: ['Activate Leave a Review', 'Next: automate guest comms', 'Next: increase revenue']
      };
    }

    case 'GUIDEBOOK_DONE':
    case 'UPSELL': {
      appConvState = 'UPSELL';
      if (low.includes('reduce') || low.includes('question') || low.includes('alex') || low.includes('chatbot') || low.includes('automat') || low.includes('comms') || low.includes('front desk')) {
        return appHandoffToAlex();
      }
      if (low.includes('revenue') || low.includes('increase') || low.includes('earn') || low.includes('store') || low.includes('sam') || low.includes('upsell')) {
        return appHandoffToSam();
      }
      if (low.includes('review') || low.includes('leave a review') || low.includes('protect')) {
        appConvState = 'REVIEW_SETUP';
        const aiReview = await callAgent('anna', input, `Explain the Leave a Review feature: it protects the host from bad public reviews. 1-3 star feedback gets collected privately in Touch Stay so the host can address issues. 4-5 star guests get nudged to leave a review on Google Places or TripAdvisor. Ask if they want to activate it. 2-3 sentences.`);
        return { text: aiReview || `Great choice! <strong>Leave a Review</strong> protects your reputation — 1-3 star feedback comes privately to you in Touch Stay so you can address it. 4-5 star guests get nudged to Google Places or TripAdvisor. Want to activate it?`, qrs: ['Yes, activate it', 'Maybe later'] };
      }
      if (low.includes('test') || low.includes('preview') || low.includes('link') || low.includes('share')) {
        appShowGrid();
        return { text: `Preview is live on the right ↗ Tap GET STARTED to test the guest view, or copy the link below:<br>${appShareLink()}`, qrs: ['Automate guest comms', 'Increase revenue per stay'] };
      }
      // Freeform — Claude handles
      const aiReply = await callAgent('anna', input);
      if (aiReply) return { text: aiReply, qrs: ['Automate guest comms', 'Increase revenue per stay', 'Activate Leave a Review'] };
      return {
        text: `What would you like to do next? I can introduce you to <strong>Alex</strong> to automate guest communication, or <strong>Sam</strong> to set up your Guest Store.`,
        qrs: ['Automate guest comms', 'Increase revenue per stay', 'Activate Leave a Review']
      };
    }

    case 'REVIEW_SETUP': {
      if (low.includes('yes') || low.includes('activ') || low.includes('sure')) {
        appConvState = 'UPSELL';
        const aiAct = await callAgent('anna', input, `Confirm Leave a Review is now active. Briefly explain: 1-3 stars go privately to them, 4-5 stars get directed to Google Places or TripAdvisor. Then ask what they want to do next — automate guest comms (Alex) or set up Guest Store (Sam). 2-3 sentences.`);
        return { text: aiAct || `Done! ✅ Leave a Review is active — 1-3 star feedback comes privately to you, 4-5 star guests get nudged to Google or TripAdvisor. Want to automate guest communication next, or set up your Guest Store?`, qrs: ['Automate guest comms', 'Set up Guest Store'] };
      }
      appConvState = 'UPSELL';
      return { text: `No problem — you can activate it any time. What would you like to work on?`, qrs: ['Automate guest comms', 'Increase revenue per stay'] };
    }

    case 'IDLE_REVIEW': {
      if (low.includes('yes') || low.includes('activ') || low.includes('sure')) {
        appConvState = 'UPSELL';
        const aiIdle = await callAgent('anna', input, `Confirm Leave a Review is active. 1-3 star reviews go privately to the host in Touch Stay. 4-5 star guests get directed to Google Places or TripAdvisor. Then offer next steps: automate guest comms (Alex) or Guest Store (Sam). 2-3 sentences.`);
        return { text: aiIdle || `Done! ✅ Leave a Review is active — 1-3 star feedback goes privately to you, 4-5 stars get nudged to Google or TripAdvisor. Want to automate guest comms next, or set up a Guest Store?`, qrs: ['Automate guest comms', 'Set up Guest Store'] };
      }
      appConvState = 'UPSELL';
      return { text: `No problem! What would you like to work on?`, qrs: ['Automate guest comms', 'Increase revenue per stay', 'Edit guidebook'] };
    }

    default: {
      const aiDefault = await callAgent('anna', input);
      if (aiDefault) return { text: aiDefault, qrs: ['Automate guest comms', 'Increase revenue per stay', 'Edit guidebook'] };
      return { text: `What would you like to work on?`, qrs: ['Automate guest comms', 'Increase revenue per stay', 'Edit guidebook'] };
    }
  }
}

function appHandoffToAlex() {
  activeAgent = 'alex';
  appData.alexStep = 0;
  document.querySelectorAll('.app-agent').forEach(el => el.classList.remove('on'));
  const alexEl = document.getElementById('agent-alex');
  if (alexEl) alexEl.classList.add('on');
  appConvState = 'ALEX_CHANNEL';
  setTimeout(async () => {
    const aiIntro = await callAgent('alex', '(User has been handed off to you. Introduce yourself and ask which booking platform they use.)', `Introduce yourself as Alex. You automate guest communication so hosts never answer the same question twice. First step: connect their booking channel. Ask which platform they use — Airbnb, Booking.com, Vrbo, or direct bookings only. 2-3 sentences, be friendly.`);
    appAddMsg('a', aiIntro || `Hey! I'm Alex 🛎️ I'll automate your guest communication so you never answer the same question twice. First — let's connect your booking channel. <strong>Which platform do you use?</strong>`);
    appAddQRs(['Airbnb', 'Booking.com', 'Vrbo', 'Direct bookings only']);
  }, 600);
  return { text: `Passing you to <strong>Alex</strong> 🛎️ — he'll automate your guest communication and set up your AI chatbot.`, qrs: [] };
}

function appHandoffToSam() {
  activeAgent = 'sam';
  document.querySelectorAll('.app-agent').forEach(el => el.classList.remove('on'));
  const samEl = document.getElementById('agent-sam');
  if (samEl) samEl.classList.add('on');
  appConvState = 'SAM_SERVICES';
  const location = guidebook.propAddr || guidebook.location || 'your area';
  setTimeout(async () => {
    const aiIntro = await callAgent('sam', '(User has been handed off to you. Introduce yourself and show suggested upsell services.)', `Introduce yourself as Sam. You help hosts earn more from every stay with zero effort. Show suggested upsell services for ${location} with prices: Early check-in £30, Late check-out £30, Welcome hamper £45, Bike hire £25/day, Wine on arrival £25, Airport transfer £50. Mention that payments are collected automatically via Stripe. Ask if they want to add all of them, pick specific ones, or adjust prices. Be enthusiastic but not pushy. 3-4 sentences.`);
    appAddMsg('a', aiIntro || `Hey! I'm Sam 🛍️ I help hosts earn more from every stay — with zero extra effort. Based on ${location}, here are the most popular upsells. Payments are collected automatically via <strong>Stripe</strong>:
<div class="artifact" style="margin-top:8px">
  <div class="artifact-head">🛒 Suggested services for ${location}</div>
  <div class="artifact-body" style="font-size:12px;line-height:1.8">
    <div class="artifact-row">🕐 Early check-in (from 11am) — <strong>£30</strong></div>
    <div class="artifact-row">🌙 Late check-out (until 2pm) — <strong>£30</strong></div>
    <div class="artifact-row">🧺 Welcome hamper — <strong>£45</strong></div>
    <div class="artifact-row">🚲 Bike hire (per day) — <strong>£25</strong></div>
    <div class="artifact-row">🍷 Wine on arrival — <strong>£25</strong></div>
    <div class="artifact-row">🚗 Airport transfer — <strong>£50</strong></div>
  </div>
</div>`);
    appAddQRs(['Add all of them', 'Let me pick', 'Adjust prices first']);
  }, 600);
  return { text: `Passing you to <strong>Sam</strong> 🛍️ — he'll help you earn more from every stay with your Guest Store.`, qrs: [] };
}

// ─── ALEX FLOW ────────────────────────────────────────────────────────────
async function doAlexFlow(low, input) {
  switch (appConvState) {

    case 'ALEX_CHANNEL': {
      appData.bookingChannel = input;
      appConvState = 'ALEX_MESSAGES';
      const propName = guidebook.propName || guidebook.propertyName || 'your property';
      const ai = await callAgent('alex', input, `User connected ${input}. Confirm it's connected. Now show them the automated message schedule — these are pre-written SMS/email templates that fire automatically on a schedule. List: Booking confirmation (immediately), Pre-arrival (3 days before), Check-in day (morning), Mid-stay check-in (day 2), Post-stay review request (day after checkout). These are SEPARATE from the AI chatbot. Ask if they want to activate the schedule or edit any templates first. 3-4 sentences.`);
      return {
        text: ai || `${input} ✓ Connected! Now let's set up your <strong>automated message schedule</strong> — pre-written templates that fire at key moments:
<div class="artifact" style="margin-top:8px">
  <div class="artifact-head">📩 Automated message schedule</div>
  <div class="artifact-body" style="font-size:12px;line-height:1.8">
    <div class="artifact-row">✉️ <strong>Booking confirmation</strong> — immediately after booking</div>
    <div class="artifact-row">📋 <strong>Pre-arrival info</strong> — 3 days before check-in</div>
    <div class="artifact-row">🔑 <strong>Check-in day</strong> — morning of arrival</div>
    <div class="artifact-row">👋 <strong>Mid-stay check-in</strong> — day 2</div>
    <div class="artifact-row">⭐ <strong>Post-stay review request</strong> — day after checkout</div>
  </div>
</div>
Each message includes your guidebook link and key info. Want to activate the schedule or edit any templates first?`,
        qrs: ['Activate all', 'Edit templates first', 'Skip messages']
      };
    }

    case 'ALEX_MESSAGES': {
      appConvState = 'ALEX_CHATBOT';
      const skipped = low.includes('skip');
      const propName = guidebook.propName || guidebook.propertyName || 'your property';
      const ai2 = await callAgent('alex', input, `${skipped ? 'User skipped messages for now.' : 'User activated/acknowledged the automated messages.'} Now introduce the AI Guest Chatbot — this is a SEPARATE feature from the automated messages. The chatbot lives INSIDE the guidebook and answers guest questions 24/7 from the guidebook content (like "where's the nearest pharmacy?", "how does the heating work?"). It reduces repetitive questions by ~90%. Ask if they want to activate it. 2-3 sentences.`);
      return {
        text: ai2 || `${skipped ? 'No problem — you can set those up later.' : 'Message schedule activated ✓'} Now for the <strong>AI Guest Chatbot</strong> — this is different from the scheduled messages. It lives inside your guidebook and answers guest questions 24/7 using your guidebook content. "Where's the nearest pharmacy?" "How does the heating work?" — it handles it all so you don't have to. Want to activate it?`,
        qrs: ['Yes, activate the chatbot', 'Skip for now']
      };
    }

    case 'ALEX_CHATBOT': {
      appConvState = 'ALEX_CONTACTS';
      const activated = !low.includes('skip');
      const ai3 = await callAgent('alex', input, `${activated ? 'AI chatbot is now active — guests can ask questions 24/7.' : 'User skipped the chatbot.'} Now recommend activating Contact Collection — this captures guest details (name, email, phone) for: compliance/guest registration requirements, and building a direct booking database so they can remarket to past guests and avoid OTA commissions. Ask if they want to activate it. 2-3 sentences.`);
      return {
        text: ai3 || `${activated ? 'AI chatbot activated ✓ Guests can now ask questions 24/7 and get instant answers.' : 'No problem — you can activate it later.'}<br><br>One more thing I'd recommend: <strong>Contact Collection</strong>. It captures guest details for compliance and guest registration — plus you build a direct booking database to remarket to past guests and skip OTA commissions. Want to activate it?`,
        qrs: ['Yes, activate it', 'Tell me more', 'Skip']
      };
    }

    case 'ALEX_CONTACTS': {
      appConvState = 'ALEX_CAMPAIGNS';
      const activated = low.includes('yes') || low.includes('activ');
      const ai4 = await callAgent('alex', input, `${activated ? 'Contact collection is active.' : 'User skipped or asked for more info — briefly explain the benefit then move on.'} Last feature: Campaigns. These are banners shown inside the guidebook that promote specific topics — like local recommendations, key events happening during their stay, or seasonal activities. Great for engagement. Ask if they want to set one up. 2-3 sentences.`);
      return {
        text: ai4 || `${activated ? 'Contact collection activated ✓' : 'No worries.'} Last thing — <strong>Campaigns</strong>. You can show banners inside your guidebook promoting specific topics to guests — local recommendations, seasonal events, activities. Guests see them right when they open the guidebook. Want to set one up?`,
        qrs: ['Set up a campaign', 'Skip for now']
      };
    }

    case 'ALEX_CAMPAIGNS': {
      appConvState = 'ALEX_DONE';
      const ai5 = await callAgent('alex', input, `Wrap up the Alex flow. Summarise what's been set up (booking channel, messages, chatbot, contacts, campaigns — whichever they activated). Then give a WARM, benefit-driven introduction to Sam and the Guest Store. Explain that hosts in their area typically earn an extra £80-150 per booking with upsells like early check-in, welcome hampers, and local experiences — all collected automatically via Stripe. Make the transition feel natural and exciting, not salesy. Ask if they want to meet Sam. 3-4 sentences.`);
      return {
        text: ai5 || `You're all set! 🎉 Your front desk is fully automated — bookings syncing, messages scheduled, and guests getting instant answers 24/7.<br><br>There's one more way to level up: hosts in ${guidebook.location || 'your area'} typically earn an <strong>extra £80-150 per booking</strong> with a Guest Store — things like early check-in, welcome hampers, and local experiences that guests love. Payments are collected automatically via Stripe. Want me to introduce you to <strong>Sam</strong>? He'll set it up in a couple of minutes.`,
        qrs: ['Yes, meet Sam', 'No thanks, I\'m done', 'Back to Anna']
      };
    }

    case 'ALEX_DONE': {
      if (low.includes('sam') || low.includes('store') || low.includes('revenue') || low.includes('yes') || low.includes('meet')) return appHandoffToSam();
      if (low.includes('back') || low.includes('anna')) { selectAgent('anna'); return { text: '', qrs: [] }; }
      const aiDone = await callAgent('alex', input);
      if (aiDone) return { text: aiDone, qrs: ['Set up Guest Store', 'Back to Anna'] };
      return { text: `Anything else you'd like to configure?`, qrs: ['Set up Guest Store', 'Back to Anna'] };
    }

    default:
      appConvState = 'ALEX_CHANNEL';
      return { text: `Let me get your booking channel connected first. Which platform do you use?`, qrs: ['Airbnb', 'Booking.com', 'Vrbo', 'Direct bookings only'] };
  }
}

// ─── SAM FLOW ─────────────────────────────────────────────────────────────
async function doSamFlow(low, input) {
  const location = guidebook.propAddr || guidebook.location || 'your area';
  switch (appConvState) {

    case 'SAM_SERVICES': {
      if (low.includes('adjust') || low.includes('price')) {
        appConvState = 'SAM_PRICING';
        const ai = await callAgent('sam', input, `User wants to adjust prices. Ask which service they want to reprice. List the options. 1-2 sentences.`);
        return { text: ai || `Sure — which service would you like to reprice?`, qrs: ['Early check-in', 'Late check-out', 'Welcome hamper', 'Bike hire', 'Wine on arrival', 'Airport transfer'] };
      }
      appConvState = 'SAM_STRIPE';
      const selected = low.includes('all')
        ? 'Early check-in · Late check-out · Welcome hamper · Bike hire · Wine on arrival · Airport transfer'
        : input;
      const ai2 = await callAgent('sam', input, `User selected services: ${selected}. Confirm the selection and explain that next you need to connect Stripe so payments are collected automatically — no manual invoicing, money goes straight to their account. Ask if they have a Stripe account or need to create one. 2-3 sentences.`);
      return {
        text: ai2 || `Great choices! To collect payments automatically, we'll connect <strong>Stripe</strong> — money goes straight to your account, no manual invoicing needed. Do you have a Stripe account already, or shall I help you set one up?`,
        qrs: ['I have Stripe', 'Help me set one up', 'Skip Stripe for now']
      };
    }

    case 'SAM_PRICING': {
      appConvState = 'SAM_SERVICES';
      const ai = await callAgent('sam', input, `User is adjusting pricing for "${input}". Acknowledge the change, then ask if they want to adjust any other prices or proceed with activating the services. 2 sentences.`);
      return { text: ai || `Updated ✓ Want to adjust any other prices, or shall we proceed?`, qrs: ['Add all services', 'Adjust another price'] };
    }

    case 'SAM_STRIPE': {
      appConvState = 'SAM_CAMPAIGNS';
      const ai3 = await callAgent('sam', input, `${low.includes('skip') ? 'User skipped Stripe for now — they can add it later.' : 'Stripe is connected/being set up.'} Now introduce Campaigns — banners shown inside the guidebook that promote products and services to guests. These are visual promotions guests see when they open the guidebook. Great for seasonal offers, featured experiences, or highlighting popular upsells. Ask if they want to set up a campaign. 2-3 sentences.`);
      return {
        text: ai3 || `${low.includes('skip') ? 'No problem — you can connect Stripe later from your dashboard.' : 'Stripe connected ✓ Payments will be collected automatically.'}<br><br>One last thing — <strong>Campaigns</strong>. You can show promotional banners inside your guidebook to highlight services, seasonal offers, or featured experiences. Guests see them right when they open the guidebook. Want to set one up?`,
        qrs: ['Set up a campaign', 'Skip for now']
      };
    }

    case 'SAM_CAMPAIGNS': {
      appConvState = 'SAM_DONE';
      appData.samConfirmed = true;
      const ai4 = await callAgent('sam', input, `Wrap up. Guest Store is live! Summarise: services activated, Stripe for automatic payments, campaigns for promotion. Mention hosts typically add £80-150 per booking. Then offer: set up AI chatbot with Alex, or go back to Anna. Make it feel like a big accomplishment. 2-3 sentences.`);
      return {
        text: ai4 || `Your Guest Store is live! 🎉 Services are on your guidebook welcome screen, payments via Stripe, and campaigns ready to promote. Hosts typically add <strong>£80–150 per booking</strong> with this setup. Want to automate guest communication next?`,
        qrs: ['Set up automated comms', 'Back to Anna', "I'm done"]
      };
    }

    case 'SAM_DONE': {
      if (low.includes('chatbot') || low.includes('alex') || low.includes('automat') || low.includes('comms')) return appHandoffToAlex();
      if (low.includes('back') || low.includes('anna') || low.includes('done')) { selectAgent('anna'); return { text: '', qrs: [] }; }
      const aiSam = await callAgent('sam', input);
      if (aiSam) return { text: aiSam, qrs: ['Automate guest comms', 'Back to Anna'] };
      return { text: `Your Guest Store is live and earning. Anything else?`, qrs: ['Automate guest comms', 'Back to Anna'] };
    }

    default:
      appConvState = 'SAM_SERVICES';
      return { text: `Let me show you what I can set up for ${location}…`, qrs: [] };
  }
}

function appAddToGrid(title, img) {
  const grid = document.getElementById('app-gb-grid');
  if (!grid) return;
  const cell = document.createElement('div');
  cell.className = 'gb-cell';
  cell.style.cssText = 'position:relative;overflow:hidden;cursor:pointer;';
  cell.innerHTML = `<div style="position:absolute;inset:0;background-image:url('${img}');background-size:cover;background-position:center"></div>
    <div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(23,41,60,.85) 0%,transparent 60%)"></div>
    <div style="position:absolute;bottom:6px;left:7px;right:7px;font-size:9.5px;font-weight:600;color:#fff;line-height:1.2">${title}</div>`;
  grid.appendChild(cell);
}

async function appSendText(text) {
  if (appBusy) return;
  resetInactivity();
  const q = document.getElementById('app-qr-now'); if (q) q.remove();
  appAddMsg('u', text);
  appBusy = true;
  appShowTyping();
  try {
    const { text: replyHtml, qrs } = await simulateAppResponse(text);
    appHideTyping();
    if (replyHtml) appAddMsg('a', replyHtml);
    if (qrs && qrs.length) appAddQRs(qrs);
  } catch(e) {
    appHideTyping();
    appAddMsg('a', 'Something went wrong — please try again.');
  }
  appBusy = false;
  resetInactivity();
}

function appSend() {
  const inp = document.getElementById('app-inp');
  if (!inp) return;
  const v = inp.value.trim();
  if (!v || appBusy) return;
  inp.value = ''; inp.style.height = 'auto';
  appSendText(v);
}

function appKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); appSend(); } }

function selectAgent(id) {
  if (activeAgent === id) return;
  activeAgent = id;
  document.querySelectorAll('.app-agent').forEach(el => el.classList.remove('on'));
  const el = document.getElementById('agent-' + id);
  if (el) el.classList.add('on');
  resetInactivity();

  if (id === 'alex') {
    appAddMsg('a', `Switching to Alex…`);
    setTimeout(() => appHandoffToAlex(), 400);
  } else if (id === 'sam') {
    appAddMsg('a', `Switching to Sam…`);
    setTimeout(() => appHandoffToSam(), 400);
  } else if (id === 'anna') {
    appConvState = 'UPSELL';
    appAddMsg('a', `Back with Anna! 👩‍💼 What would you like to work on?`);
    appAddQRs(['Edit guidebook', 'Reduce guest questions', 'Increase revenue']);
  } else if (id === 'taylor') {
    appAddMsg('a', `Taylor here 🔧 — I handle PMS connections, smart locks, and APIs. What's your setup?`);
    appAddQRs(['Smart lock setup', 'PMS integration', 'API docs']);
  }
}

function appShowGrid() {
  const cover = document.getElementById('app-st-cover');
  const grid  = document.getElementById('app-st-grid');
  if (cover) cover.classList.remove('on');
  if (grid)  grid.classList.add('on');
}

function editTopic(name) {
  const editor = document.getElementById('topic-editor');
  if (!editor) return;
  const tmpl = TOPIC_TEMPLATES.find(t => t.title === name) || { title: name, text: '', img: '' };
  const titleInp = document.getElementById('te-title-inp');
  const bodyInp  = document.getElementById('te-content');
  if (titleInp) titleInp.value = tmpl.title;
  if (bodyInp)  bodyInp.value  = tmpl.text.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '');
  editor.classList.add('on');
}

function closeTopicEditor() {
  const editor = document.getElementById('topic-editor');
  if (editor) editor.classList.remove('on');
}

function saveTopicEditor() {
  const title = document.getElementById('te-title-inp')?.value.trim();
  const body  = document.getElementById('te-content')?.value.trim();
  closeTopicEditor();
  if (title) appAddMsg('a', `✅ <strong>${title}</strong> updated — live instantly for your guests.`);
}

function switchToAdvanced() {
  appAddMsg('a', `Advanced mode is coming soon — full section editing, custom colours, HTML blocks. Stay tuned! 🛠️`);
}

function transitionToApp(displayName, email) {
  // Hide the landing split-pane
  const wrap = document.getElementById('wrap') || document.querySelector('.wrap');
  if (wrap) wrap.style.display = 'none';
  const nav = document.querySelector('nav');
  if (nav) nav.style.display = 'none';

  // Show app shell
  const appWrap = document.getElementById('app-wrap');
  if (!appWrap) return;
  appWrap.classList.add('on');

  // Populate app header project name
  const appProjEl = document.getElementById('app-proj-name');
  if (appProjEl) appProjEl.textContent = guidebook.propName || 'My Property';

  // Populate user avatar initials
  const avatarEl = document.getElementById('app-user-av');
  if (avatarEl) {
    const initials = (displayName || 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    avatarEl.textContent = initials;
  }

  // Populate app phone cover
  const appPropNameEl = document.getElementById('app-prop-name');
  const appAddrEl     = document.getElementById('app-prop-addr');
  const appGreetEl    = document.getElementById('app-greeting');
  if (appPropNameEl) appPropNameEl.textContent = guidebook.propName || 'Your Property';
  if (appAddrEl)     appAddrEl.textContent     = guidebook.propAddr || '';
  if (appGreetEl)    appGreetEl.textContent     = `Hi, I'm your host, ${guidebook.hostName || displayName || 'Your Host'} 👋`;

  // Hero photo
  const appHeroEl = document.getElementById('app-hero-photo');
  if (appHeroEl && guidebook.heroPhoto) appHeroEl.style.backgroundImage = `url('${guidebook.heroPhoto}')`;

  // Show cover in app phone
  const appCover = document.getElementById('app-st-cover');
  const appGrid  = document.getElementById('app-st-grid');
  if (appCover) appCover.classList.add('on');
  if (appGrid)  appGrid.classList.remove('on');

  // Seed app grid with any topics already in guidebook
  if (guidebook.sections && guidebook.sections.length) {
    guidebook.sections.forEach(s => {
      const tmpl = TOPIC_TEMPLATES.find(t => t.title === s || t.key === s.toLowerCase());
      if (tmpl) appAddToGrid(tmpl.title, tmpl.img);
    });
  }

  // Detect scrape vs manual to decide Anna's starting state
  const cameViaScrape = !!guidebook.scraped;
  appConvState = cameViaScrape ? 'GUIDEBOOK_DONE' : 'GUIDEBOOK_START';

  // Wire up inactivity reset on any user interaction
  const appWrap2 = document.getElementById('app-wrap');
  if (appWrap2) {
    appWrap2.addEventListener('mousemove', resetInactivity, { passive: true });
    appWrap2.addEventListener('keydown',   resetInactivity, { passive: true });
    appWrap2.addEventListener('click',     resetInactivity, { passive: true });
  }

  // Anna greeting
  setTimeout(() => {
    if (cameViaScrape) {
      appConvState = 'GUIDEBOOK_DONE';
      const slug = (guidebook.propName || guidebook.propertyName || 'my-property').toLowerCase().replace(/\s+/g, '-');
      appAddMsg('a', `Welcome, <strong>${displayName}</strong>! 🎉 Your guidebook is live — tap <strong>GET STARTED</strong> in the preview to test it, or share this link:<br><code style="font-size:11px;background:rgba(62,217,204,.12);color:#1a6b64;padding:4px 10px;border-radius:6px;display:inline-block;margin-top:4px">guide.touchstay.com/${slug}</code>`);
      appAddQRs(['Test the guidebook', 'Add more details', 'Reduce guest questions', 'Increase revenue per stay']);
    } else {
      appConvState = 'GUIDEBOOK_CHECKIN';
      appAddMsg('a', `Welcome, <strong>${displayName}</strong>! 🎉 Let's set up your guest experience — a few quick steps and your guests will have everything they need before they arrive.`);
      setTimeout(() => {
        appAddMsg('a', `First: what are your <strong>check-in and check-out times?</strong>`);
        appAddQRs(['3pm / 11am', '4pm / 10am', '2pm / 12pm']);
      }, 600);
    }
    resetInactivity();
  }, 400);
}

// ─── CHAT UI ──────────────────────────────────────────────────────────────
const MSGS = document.getElementById('msgs');

function addMsg(who, html) {
  const d = document.createElement('div');
  d.className = 'm ' + who;
  if (who === 'a') d.innerHTML = `<div class="av">A</div><div class="bub">${html}</div>`;
  else             d.innerHTML = `<div class="bub">${html}</div>`;
  MSGS.appendChild(d);
  return d;
}

function addQRs(replies) {
  if (!replies || !replies.length) return;
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
function hideTyping()   { const t = document.getElementById('typ'); if (t) t.remove(); }
function scrollBottom() { setTimeout(() => MSGS.scrollTo({ top: MSGS.scrollHeight, behavior: 'smooth' }), 50); }

// ─── SEND ─────────────────────────────────────────────────────────────────
async function send() {
  const inp = document.getElementById('inp');
  const v = inp.value.trim();
  if (!v || busy) return;
  inp.value = ''; inp.style.height = 'auto';
  sendText(v);
}

async function sendText(text) {
  if (busy) return;
  removeQRs();
  addMsg('u', text);
  scrollBottom();
  busy = true;
  showTyping();
  try {
    const raw = await simulateAnna(text);
    hideTyping();
    const { displayText, update, qrs } = parseResponse(raw);
    if (displayText) addMsg('a', displayText);
    if (update) applyUpdate(update);
    // Don't release busy or add QRs if we're about to scrape
    if (!update?.startScrape) {
      if (qrs && qrs.length) addQRs(qrs);
      scrollBottom();
      busy = false;
    }
  } catch(e) {
    hideTyping();
    addMsg('a', `Something went wrong — please try again.`);
    scrollBottom();
    busy = false;
  }
}

function onKey(e)   { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }
function resize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 100) + 'px'; }

// ─── EXPOSE GLOBALS ───────────────────────────────────────────────────────
window.send             = send;
window.sendText         = sendText;
window.onKey            = onKey;
window.resize           = resize;
window.showGrid         = showGrid;
window.closeModal       = closeModal;
window.doG3             = doG3;
// App
window.appSend          = appSend;
window.appSendText      = appSendText;
window._clearInactivity = () => clearTimeout(inactivityTimer);
window._setAppState     = (s) => { appConvState = s; };
window._setAgent        = (a) => { activeAgent = a; };
window.appKey           = appKey;
window.appShowGrid      = appShowGrid;
window.selectAgent      = selectAgent;
window.editTopic        = editTopic;
window.closeTopicEditor = closeTopicEditor;
window.saveTopicEditor  = saveTopicEditor;
window.switchToAdvanced = switchToAdvanced;

// ─── INIT ─────────────────────────────────────────────────────────────────
(function init() {
  // Show the demo guidebook cover immediately — grid only appears after "Get Started"
  renderCover();

  addMsg('a', `Hi! 👋 I'll help you create the perfect guest experience — no forms, just a quick chat. We'll set up your guidebook, automate guest communication, and help you earn more per stay. <strong>What kind of property do you have?</strong>`);
  addQRs(['One apartment', 'A cabin or cottage', 'A villa or house', 'Multiple properties']);
  scrollBottom();
})();
