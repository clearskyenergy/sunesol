#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   PREFLIGHT — run this before every deploy.
   ----------------------------------------------------------------------
     node preflight.js editor.html

   Exits 0 if clean, 1 if anything fails. Wire it into CI, or just run it
   before uploading.

   This exists because two bugs reached a customer's live project:
     * a label rendered as "String/central inverter \u00b7 500 kW DC\u2192AC"
       -- a double-escaped unicode sequence in a JS string literal
     * the legend printed raw internal ids: util_poi, der_poi, ems

   Neither is a crash. Both are invisible to a syntax check and to any
   test that stubs the DOM. The only thing that catches them is loading
   the real file in a real browser and looking at what the user sees.
   ══════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const FILE = process.argv[2] || 'editor.html';
const src = fs.readFileSync(FILE, 'utf8');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (detail ? '   ' + detail : '')); }
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

/* ── 1. STATIC: things you can catch without running anything ──────── */
section('STATIC SOURCE CHECKS');

/* Double-escaped unicode. '\\u00b7' in a JS string prints the escape,
   not the character. This is what shipped to the customer. */
const dblEsc = [...src.matchAll(/\\\\u[0-9a-fA-F]{4}/g)];
chk('no double-escaped unicode in string literals', dblEsc.length === 0,
  dblEsc.length ? dblEsc.slice(0, 5).map(m => m[0]).join(', ') : '');

/* Mojibake from a bad encoding round-trip. */
const mojibake = [...src.matchAll(/[ÃÂ][\u0080-\u00bf]/g)];
chk('no mojibake (UTF-8 read as latin-1)', mojibake.length === 0,
  mojibake.length ? mojibake.length + ' sequences' : '');

/* Truncated upload — the classic deploy failure. A naive <script> tag count
   is NOT a valid test here: this file mentions <script> in a comment and
   emits an escaped <\/script> inside a template string, so the raw counts
   are legitimately unequal. What actually matters is that the file is not
   cut short. */
chk('document closes properly', /<\/body>\s*<\/html>\s*$/.test(src), '');

const lastClose = src.lastIndexOf('</script>');
const strayOpen = src.indexOf('<script', lastClose + 9);
chk('no unterminated script block at EOF', strayOpen === -1,
  strayOpen === -1 ? '' : 'open tag after the final closer, line ' + src.slice(0, strayOpen).split('\n').length);

chk('file is not truncated', src.length > 1000000 && src.trim().endsWith('</html>'),
  (src.length / 1048576).toFixed(2) + ' MB');

/* Every <script> block parses. A syntax error in one block silently kills
   every function declared after it in that block. */
const blocks = [];
let idx = 0;
while (true) {
  const a = src.indexOf('<script', idx); if (a < 0) break;
  const s0 = src.indexOf('>', a) + 1;
  const b = src.indexOf('</script>', s0); if (b < 0) break;
  const body = src.slice(s0, b);
  if (body.trim() && !/\ssrc\s*=/.test(src.slice(a, s0))) blocks.push({ line: src.slice(0, a).split('\n').length, body });
  idx = b + 9;
}
let bad = [];
blocks.forEach(bl => {
  try { new (require('vm').Script)(bl.body); } catch (e) { bad.push('line ' + bl.line + ': ' + e.message.split('\n')[0]); }
});
chk('every inline script parses', bad.length === 0, bad.length ? bad[0] : blocks.length + ' blocks');

/* ── 2. RUNTIME: load it like a browser does ───────────────────────── */
section('RUNTIME LOAD');

const consoleErrors = [];
const dom = new JSDOM(src, {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://preflight.local/',
  beforeParse(w) {
    w.fetch = () => Promise.reject(new Error('offline'));
    w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    w.scrollTo = () => {};
    w.alert = m => consoleErrors.push('alert: ' + m);
    const ce = w.console.error.bind(w.console);
    w.console.error = (...a) => { consoleErrors.push(a.join(' ')); };
    w.addEventListener('error', e => consoleErrors.push('uncaught: ' + (e.error && e.error.message || e.message)));
  }
});
const w = dom.window;

setTimeout(() => {
  const S = () => w.eval('S');

  chk('page loaded without uncaught errors',
    consoleErrors.filter(e => !/localStorage|opaque origin|offline/i.test(e)).length === 0,
    consoleErrors.filter(e => !/localStorage|opaque origin|offline/i.test(e))[0] || '');

  /* Entry points every build depends on. A module in a later <script>
     block cannot see a bare function name from an earlier one, so these
     must actually be on window. That exact gap silently broke placement. */
  section('GLOBAL CONTRACT');
  /* Two different kinds of reachability, and the difference bit us:
       - `var` / `function` at top level land on window, so a module in a
         LATER <script> block can see them.
       - `const` / `let` land in the global LEXICAL scope. A bare name still
         resolves across classic scripts, but window.NAME is undefined.
     So test by bare name. Anything a later module calls must resolve here. */
  const required = ['_evAdd', '_evPx', 'addEl', 'renderEl', 'renderLegend', 'EVRENDER',
                    'EV_FOOTPRINT', 'ICONS', 'EQ', 'OmegaCGB', 'OmegaCompute',
                    'OmegaSubstation', 'placeCgbAt', 'covClick', 'setMode',
                    '_besPadProps', 'BESS_CATALOG'];
  required.forEach(k => {
    let t = 'undefined';
    try { t = w.eval('typeof ' + k); } catch (e) {}
    chk(k + ' resolves at runtime', t !== 'undefined', t);
  });

  /* ── 3. NOTHING USER-VISIBLE IS A RAW ID OR AN ESCAPE ──────────── */
  section('USER-VISIBLE OUTPUT');

  /* Every EVRENDER kind must produce valid SVG — a missing renderer is
     how equipment silently becomes a grey box. */
  const R = w.EVRENDER || w.eval('typeof EVRENDER!=="undefined"?EVRENDER:({})') || {};
  const badR = Object.keys(R).filter(k => {
    try { const v = R[k](60); return !(typeof v === 'string' && v.startsWith('<svg') && v.includes('</svg>')); }
    catch (e) { return true; }
  });
  chk('every EVRENDER kind returns valid SVG', badR.length === 0,
    badR.length ? badR.join(', ') : Object.keys(R).length + ' kinds');

  const I = w.eval('typeof ICONS!=="undefined"?ICONS:({})') || {};
  const badI = Object.keys(I).filter(k => {
    try { const v = I[k](24); return !(typeof v === 'string' && v.includes('<svg')); } catch (e) { return true; }
  });
  chk('every ICONS entry returns valid SVG', badI.length === 0,
    badI.length ? badI.join(', ') : Object.keys(I).length + ' icons');

  /* Guided build: place a full chain, then read the LEGEND the way a
     customer would. */
  let legendText = '', labels = [], builtConds = [], builtEls = [];
  try {
    const G = w.OmegaCGB, st = G.state();
    G.open();
    const it = w.document.getElementById('cgb-itmw'); if (it) it.value = '5';
    G.fmt('guided'); G.sync();
    /* place -> route the leg -> drop on the run, for each node */
    const bd = w.document.getElementById('cgb-bldg'); if (bd) bd.checked = false;
    G.sync(); G.go();
    w.placeCgbAt({ x: 140, y: 240 });
    let guard = 0;
    while (st.active && guard++ < 40) {
      const i = st.stepIx;
      w.placeCgbAt({ x: 200 + i * 110, y: 240 });
      w.placeCgbAt({ x: 260 + i * 110, y: 240 });
      G.enter();
      w.placeCgbAt({ x: 230 + i * 110, y: 275 });
    }
    labels = w.eval('S.elements.map(e=>e.label)');
    /* Snapshot now. The legend check below deliberately clears S to test a
       different placement path, and DRAWING INTEGRITY used to run after
       that -- against an empty array, so three checks passed vacuously. */
    builtConds = JSON.parse(w.eval('JSON.stringify(S.conduits)'));
    builtEls = JSON.parse(w.eval('JSON.stringify(S.elements)'));
    if (typeof w.renderLegend === 'function') w.renderLegend();
    const lg = w.document.getElementById('lgd-items');
    legendText = lg ? lg.textContent : '';
  } catch (e) { chk('guided build runs end to end', false, e.message); }

  chk('guided build places every node', w.eval('S.elements.length') > 0,
    w.eval('S.elements.length') + ' elements, ' + w.eval('S.conduits.length') + ' conduits');
  chk('guided build creates no stray shapes', w.eval('S.shapes.length') === 0,
    w.eval('S.shapes.length') + ' shapes');

  const escInLabel = labels.filter(l => /\\u[0-9a-fA-F]{4}/.test(String(l)));
  chk('no unicode escape leaks into a label', escInLabel.length === 0, escInLabel[0] || '');

  /* Engineering mode is a review/output choice. Shipping it on by default
     meant every new project opened in monochrome plan-set style. */
  let engDefault = null;
  try { engDefault = w.eval('window.ENG_MODE'); } catch (e) {}
  chk('engineering mode is NOT the default', engDefault === false, 'ENG_MODE=' + engDefault);

  const rawId = labels.filter(l => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(String(l)));
  chk('no raw snake_case id shown as a label', rawId.length === 0, rawId.join(', '));

  const legendRaw = /\b(util_poi|der_poi|ems|dc_leviathan|fuelcell_sofc|padxfmr|mvswgr)\b/.exec(legendText || '');
  chk('legend shows no raw internal ids (guided build)', !legendRaw, legendRaw ? legendRaw[0] : '');

  /* THE SCREENSHOT CASE. The customer's legend printed util_poi / der_poi /
     ems. Those arrive as type:'eq' elements from the DER and Deluxe builds,
     whose ids live in neither EQ nor DC_CATALOG. The guided-build check
     above does not exercise that path, so place them directly. */
  let eqLegend = '', eqRaw = null;
  try {
    w.eval("S.elements.length=0;S.shapes.length=0;S.conduits.length=0;");
    ['util_poi', 'der_poi', 'ems', 'xfmr', 'meter'].forEach((k, i) => {
      w.addEl({ type: 'eq', eqId: k, x: 100 + i * 90, y: 200, w: 60, h: 60 });
    });
    if (typeof w.renderLegend === 'function') w.renderLegend();
    const lg = w.document.getElementById('lgd-items');
    eqLegend = lg ? lg.textContent : '';
    eqRaw = /\b(util_poi|der_poi|ems|padxfmr|dc_leviathan)\b/.exec(eqLegend);
  } catch (e) { eqLegend = 'ERROR: ' + e.message; }
  chk('legend actually rendered (guards against a vacuous pass)',
    eqLegend.replace(/\s+/g, '').length > 10, eqLegend.length + ' chars');
  chk('legend names DER/EMS equipment, not raw ids', !eqRaw && !/^ERROR/.test(eqLegend),
    eqRaw ? ('printed "' + eqRaw[0] + '"') : (eqLegend.slice(0, 70).replace(/\s+/g, ' ')));

  /* Every placeable shape that carries editable data must be reachable by
     double-click. A BESS pad stores its whole electrical spec on the shape
     and had no editor at all -- the only way to correct a unit was to
     delete and re-place it. */
  section('EDITABILITY');
  try {
    w.eval("S.shapes.push({id:'__pfpad',kind:'bespad',pts:[{x:300,y:300}],lf:20,wf:8,model:'PF',unitKwh:760,unitKw:380});");
    const scEl = w.document.getElementById('sc');
    scEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1400, height: 900 });
    scEl.dispatchEvent(new w.MouseEvent('dblclick', { clientX: 360, clientY: 330, bubbles: true }));
    const panel = w.document.getElementById('bpp-modal');
    chk('double-clicking a BESS pad opens its editor', !!panel,
      panel ? '' : 'no panel — spec is unreachable once placed');
    if (panel) {
      const pre = w.document.getElementById('bpp-kwh');
      chk('editor is prefilled from the shape', pre && pre.value === '760', pre ? pre.value : '');
      panel.remove();
    }
    w.eval("S.shapes = S.shapes.filter(function(s){return s.id!=='__pfpad';});");
  } catch (e) { chk('double-clicking a BESS pad opens its editor', false, e.message); }

  /* Conduit sanity — lengths and geometry a reviewer would catch. */
  section('DRAWING INTEGRITY');
  const conds = builtConds;
  chk('integrity checks have something to inspect', conds.length > 0 && builtEls.length > 0,
    conds.length + ' conduits / ' + builtEls.length + ' elements captured');
  let diag = 0, zero = 0, nan = 0;
  conds.forEach(c => {
    if (!isFinite(c.ftLen)) nan++;
    if (c.ftLen === 0) zero++;
    for (let i = 1; i < c.pts.length; i++) {
      const a = c.pts[i - 1], b = c.pts[i];
      if (!isFinite(a.x) || !isFinite(a.y)) nan++;
      if (Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5) diag++;
    }
  });
  chk('no NaN coordinates or lengths', nan === 0, nan ? nan + ' bad values' : '');
  chk('no zero-length runs in the schedule', zero === 0, zero ? zero + ' runs' : '');
  /* Orthogonality is NOT asserted. The user routes each leg by hand now,
     and a diagonal run across a field is a legitimate thing to draw. What
     must hold is that every run is attached at both ends. */
  const els = builtEls;
  const key = p => p.x.toFixed(1) + ',' + p.y.toFixed(1);
  const verts = {};
  conds.forEach(c => c.pts.forEach(p => { verts[key(p)] = (verts[key(p)] || 0) + 1; }));
  const onAnyEl = p => els.some(e => p.x >= e.x - 2 && p.x <= e.x + e.w + 2 && p.y >= e.y - 2 && p.y <= e.y + e.h + 2);
  let floating = 0;
  conds.forEach(c => {
    [c.pts[0], c.pts[c.pts.length - 1]].forEach(p => {
      if (!(verts[key(p)] > 1 || onAnyEl(p))) floating++;
    });
  });
  chk('every run is attached at both ends', floating === 0,
    floating ? floating + ' floating endpoints of ' + (conds.length * 2) : conds.length * 2 + ' endpoints landed');

  /* A run must reference the equipment at BOTH ends, or the drag handler
     re-snaps one end to the element and strands the other where it was --
     the stray line left behind when a node is moved. */
  const noIds = conds.filter(c => !(c.fromElId && c.toElId));
  chk('every run references equipment at both ends', noIds.length === 0,
    noIds.length ? noIds.length + ' of ' + conds.length + ' runs missing an element id' : conds.length + ' runs');

  const centre = e => ({ x: e.x + (e.w || 40) / 2, y: e.y + (e.h || 30) / 2 });
  const near = (a, b) => Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2;
  let offNode = 0;
  conds.forEach(c => {
    const f = els.find(e => e.id === c.fromElId), t = els.find(e => e.id === c.toElId);
    if (f && !near(c.pts[0], centre(f))) offNode++;
    if (t && !near(c.pts[c.pts.length - 1], centre(t))) offNode++;
  });
  chk('run endpoints sit on their node centres (survives a drag)', offNode === 0,
    offNode ? offNode + ' endpoints off-centre' : '');

  /* GROUND ANCHOR must describe the CURRENT polyline. A conduit whose
     _geoPts were stamped before it was edited gets reprojected back to the
     old geometry on the next map idle -- a stray line that appears on
     placement and vanishes the moment the element is dragged. */
  const anchored = conds.filter(c => c._geoPts && c._geoPts.length);
  const stale = anchored.filter(c => c._geoPts.length !== c.pts.length);
  if (anchored.length === 0) {
    /* Headless has no live map, so _geoRestampOne returns early and no
       anchor is ever written. Say so rather than reporting a green tick on
       an empty set -- this one has to be verified against a real map. */
    console.log('  \x1b[33mN/A \x1b[0m  ground-anchor consistency   no live map headless; ' +
      'verified instead by asserting every conduit factory calls _geoRestampOne');
    const src2 = fs.readFileSync(FILE, 'utf8');
    const cgb = src2.slice(src2.lastIndexOf('OMEGA PATCH 13'));
    const pc = cgb.indexOf('function pushCond(c){');
    const stamps = (cgb.slice(pc, pc + 900).match(/_geoRestampOne/g) || []).length;
    chk('compute-build conduit factory stamps a ground anchor', stamps > 0,
      stamps ? 'pushCond re-stamps' : 'pushCond never anchors — runs will drift on zoom');
    const trunc = cgb.indexOf('c.pts=kept;');
    const restamped = trunc > 0 && /_geoRestampOne/.test(cgb.slice(trunc, trunc + 1200));
    chk('re-stamps after truncating a leg on placement', restamped,
      restamped ? '' : 'truncation leaves a stale anchor — stray line on placement');
  } else {
    chk('no conduit carries a stale ground anchor', stale.length === 0,
      stale.length ? stale.length + ' of ' + anchored.length + ' anchored to old geometry'
                   : anchored.length + ' anchored runs consistent');
  }

  /* ── 4. SAVED PROJECTS STILL LOAD ─────────────────────────────────
     A deploy that changes the state shape breaks every existing project.
     Round-trip the state the app itself would persist. */
  section('SAVED PROJECT ROUND-TRIP');
  let rt = null, rtErr = '';
  try {
    const snapshot = w.eval('JSON.stringify({shapes:S.shapes,elements:S.elements,conduits:S.conduits,pxPerFt:S.pxPerFt})');
    const parsed = JSON.parse(snapshot);
    w.eval('S.shapes.length=0;S.elements.length=0;S.conduits.length=0;');
    w.eval('(function(d){ S.shapes.push.apply(S.shapes,d.shapes); S.elements.push.apply(S.elements,d.elements); S.conduits.push.apply(S.conduits,d.conduits); })(' + snapshot + ')');
    if (typeof w.renderLegend === 'function') w.renderLegend();
    rt = { el: w.eval('S.elements.length'), cd: w.eval('S.conduits.length'),
           esc: /\\u[0-9a-fA-F]{4}/.test(snapshot) };
  } catch (e) { rtErr = e.message; }
  chk('state survives a JSON round-trip', rt && rt.el > 0, rtErr || (rt ? rt.el + ' elements restored' : ''));
  chk('no escape sequences persisted into saved state', rt && !rt.esc, rt && rt.esc ? 'found \\uXXXX in state' : '');

  /* ── verdict ── */
  console.log('\n' + '─'.repeat(58));
  if (fail) {
    console.log('\x1b[31m✗ ' + fail + ' FAILED\x1b[0m, ' + pass + ' passed — DO NOT DEPLOY');
    failures.forEach(f => console.log('    · ' + f));
  } else {
    console.log('\x1b[32m✓ all ' + pass + ' checks passed\x1b[0m — safe to deploy');
  }
  process.exit(fail ? 1 : 0);
}, 3000);
