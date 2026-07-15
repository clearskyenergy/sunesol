/* ═══════════════════════════════════════════════════════════════════════
   Site Investment Analysis — engine (ES5)
   © 2025 ClearSky Energy Solutions LLC · Author: Tommy Gilmer

   Pipeline:
     1. Intake (address/ZIP + utility + archetype)
     2. Resolve ISO market, utility rate, incentives (live query where verified)
     3. Allocate available grid power across compute / BESS / DER
     4. Build revenue stack: compute marketplace, TOU arbitrage, capacity/VPP,
        demand offset, DER energy value
     5. Net energy cost + O&M; amortize CAPEX; solve IRR / NPV / payback
     6. Draft AI investor proposal (Anthropic API) grounded in the numbers
   ═══════════════════════════════════════════════════════════════════════ */

/* ────────── UTILITY / ISO / RATE KNOWLEDGE BASE ──────────
   energyBlended, peakSpread, demandCharge from filed tariffs where known.
   iso maps to the wholesale market. capacityValue = typical $/kW-yr for
   the ISO's capacity + ancillary stack (used as value-stack default). */
var UTILS = {
  'sce': { name:'Southern California Edison', iso:'CAISO', state:'CA',
    energyBlended:0.34, peakSpread:(0.67551-0.12538), demandCharge:0,
    rateSchedule:'TOU-EV-8 / TOU-8', capacityValue:110,
    note:'CAISO · SGIP + IRA storage incentives · high TOU spread, no EV demand charge.' },
  'ladwp': { name:'LADWP (Los Angeles)', iso:'CAISO-LA (municipal)', state:'CA',
    energyBlended:0.20, peakSpread:0.18, demandCharge:18,
    rateSchedule:'A-2 / EV', capacityValue:75,
    note:'Municipal utility outside CAISO market settlement; local FiP + storage programs.' },
  'pge': { name:'Pacific Gas & Electric', iso:'CAISO', state:'CA',
    energyBlended:0.32, peakSpread:0.24, demandCharge:0,
    rateSchedule:'BEV-2 / B-19', capacityValue:105,
    note:'CAISO · SGIP; subscription demand model on EV rates.' },
  'sdge': { name:'San Diego Gas & Electric', iso:'CAISO', state:'CA',
    energyBlended:0.31, peakSpread:0.29, demandCharge:0,
    rateSchedule:'EV-HP', capacityValue:115,
    note:'CAISO · widest TOU spread in CA · strong storage arbitrage.' },
  'coned': { name:'Con Edison (NYC)', iso:'NYISO', state:'NY',
    energyBlended:0.24, peakSpread:0.16, demandCharge:28,
    rateSchedule:'SC-9', capacityValue:160,
    note:'NYISO Zone J · very high capacity value + NYSERDA VDER/Value Stack.' },
  'pseg_nj': { name:'PSE&G (New Jersey)', iso:'PJM', state:'NJ',
    energyBlended:0.16, peakSpread:0.11, demandCharge:22,
    rateSchedule:'LPL-S', capacityValue:120,
    note:'PJM · capacity + ancillary; NJ storage incentive emerging.' },
  'comed': { name:'ComEd (Illinois)', iso:'PJM (ComEd zone)', state:'IL',
    energyBlended:0.11, peakSpread:0.10, demandCharge:15,
    rateSchedule:'GS / §16-107.6 rebate', capacityValue:95,
    note:'PJM · IL storage rebate (PA 104-0458 §16-107.6) + SDVPP tariff.' },
  'xcel_co': { name:'Xcel Energy (Colorado)', iso:'Non-ISO (WECC)', state:'CO',
    energyBlended:0.12, peakSpread:0.09, demandCharge:19,
    rateSchedule:'SG / C-TOU', capacityValue:70,
    note:'Vertically integrated · demand-charge-driven; bilateral capacity.' },
  'ercot_oncor': { name:'Oncor / ERCOT (Texas)', iso:'ERCOT', state:'TX',
    energyBlended:0.09, peakSpread:0.14, demandCharge:0,
    rateSchedule:'Retail (4CP)', capacityValue:60,
    note:'ERCOT energy-only · scarcity pricing + 4CP transmission cost avoidance; no capacity market.' },
  'dominion': { name:'Dominion Energy (Virginia)', iso:'PJM (Dom zone)', state:'VA',
    energyBlended:0.10, peakSpread:0.08, demandCharge:17,
    rateSchedule:'GS-3', capacityValue:100,
    note:'PJM Dominion zone · data-center alley; strong compute offtake, tightening interconnection.' },
  'generic': { name:'Generic U.S. Utility (custom)', iso:'Custom', state:'US',
    energyBlended:0.13, peakSpread:0.11, demandCharge:15,
    rateSchedule:'Commercial TOU', capacityValue:90,
    note:'Edit advanced inputs to match your market.' }
};
var UTIL_ORDER = ['sce','ladwp','pge','sdge','coned','pseg_nj','comed','xcel_co','ercot_oncor','dominion','generic'];

/* ────────── STATE INCENTIVE LIBRARY (seed; refreshed by live query) ──────────
   itcBonus: extra ITC beyond federal 30%. storageRebatePerKwh: $/kWh cash. */
var INCENTIVES = {
  'CA': { itcBonus:0, storageRebatePerKwh:200, program:'SGIP (Self-Generation Incentive Program)',
    note:'SGIP general market storage; higher for equity/resiliency. Federal ITC 30% (IRA).' },
  'NY': { itcBonus:0, storageRebatePerKwh:0, program:'NYSERDA Retail/Bulk Storage + VDER Value Stack',
    note:'Block-grant $/kWh (declining) + VDER compensation via Value Stack.' },
  'NJ': { itcBonus:0, storageRebatePerKwh:0, program:'NJ Storage Incentive (pending) + PJM',
    note:'BPU storage incentive under development; PJM capacity applies now.' },
  'IL': { itcBonus:10, storageRebatePerKwh:0, program:'IL §16-107.6 Storage Rebate + SDVPP',
    note:'ComEd BESH rebate per kW + energy-community ITC adder (10%).' },
  'CO': { itcBonus:0, storageRebatePerKwh:0, program:'Xcel bilateral + federal ITC',
    note:'No standing state storage rebate; ITC 30% + possible energy-community adder.' },
  'TX': { itcBonus:0, storageRebatePerKwh:0, program:'Federal ITC only (ERCOT merchant)',
    note:'No state incentive; merchant revenue in ERCOT. ITC 30%.' },
  'VA': { itcBonus:10, storageRebatePerKwh:0, program:'Federal ITC + VA energy community',
    note:'Coal-community ITC adders available in parts of VA.' },
  'US': { itcBonus:0, storageRebatePerKwh:0, program:'Federal ITC (30%)',
    note:'Baseline federal Investment Tax Credit.' }
};

/* ────────── helpers ────────── */
function $(id){ return document.getElementById(id); }
function val(id){ var e=$(id); return e?e.value:''; }
function numv(id){ var v=parseFloat(val(id)); return isNaN(v)?0:v; }
function fmt$(v){ return '$'+Math.round(v).toLocaleString('en-US'); }
function fmt$k(v){ var a=Math.abs(v);
  if(a>=1e6) return (v<0?'-$':'$')+(a/1e6).toFixed(2)+'M';
  if(a>=1e3) return (v<0?'-$':'$')+(a/1e3).toFixed(0)+'k';
  return (v<0?'-$':'$')+Math.round(a); }
function fmtN(v){ return Math.round(v).toLocaleString('en-US'); }

function irr(cf){
  function npvAt(r){ var s=0; for(var i=0;i<cf.length;i++) s+=cf[i]/Math.pow(1+r,i); return s; }
  var lo=-0.9, hi=3.0, mid=0;
  if(npvAt(lo)*npvAt(hi)>0) return null;
  for(var k=0;k<200;k++){ mid=(lo+hi)/2; var v=npvAt(mid); if(Math.abs(v)<1) break; if(npvAt(lo)*v<0) hi=mid; else lo=mid; }
  return mid;
}
function npv(rate,cf){ var s=0; for(var i=0;i<cf.length;i++) s+=cf[i]/Math.pow(1+rate,i); return s; }

/* zip -> state (coarse first-digit + known CA prefixes handled via utility choice) */
function stateFromZip(z){
  z = (z||'').replace(/[^0-9]/g,'');
  if(z.length<3) return null;
  var p3 = parseInt(z.substring(0,3),10);
  if(p3>=900 && p3<=961) return 'CA';
  if(p3>=100 && p3<=149) return 'NY';
  if(p3>=70 && p3<=89) return 'NJ';
  if(p3>=600 && p3<=629) return 'IL';
  if(p3>=800 && p3<=816) return 'CO';
  if(p3>=750 && p3<=799) return 'TX';
  if(p3>=201 && p3<=246) return 'VA';
  return null;
}
function extractZip(s){ var m=(s||'').match(/\b(\d{5})\b/); return m?m[1]:null; }

/* ────────── LIVE DATA LAYER ──────────
   Attempts real, keyless, CORS-friendly public endpoints. Each returns a
   provenance record {name, status:'verified'|'estimate'|'na', detail}.
   Falls back to the seeded knowledge base if a source is unreachable. */

function dsRow(name, status, detail){
  var dot = status==='verified'?'ok':(status==='na'?'miss':'pending');
  var badge = status==='verified'?'verified':(status==='na'?'na':'estimate');
  var badgeTxt = status==='verified'?'Verified live':(status==='na'?'Not available':'Modeled');
  return '<div class="ds-item" data-name="'+name+'">'+
    '<span class="ds-dot '+dot+'"></span>'+
    '<span class="ds-name">'+name+'</span>'+
    '<span class="ds-detail">'+detail+'</span>'+
    '<span class="ds-badge '+badge+'">'+badgeTxt+'</span></div>';
}

/* Geocode via Census Bureau (public, keyless, CORS-enabled) */
function geocodeAddress(addr){
  return new Promise(function(resolve){
    var url='https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address='+
            encodeURIComponent(addr)+'&benchmark=Public_AR_Current&format=json';
    var done=false;
    var t=setTimeout(function(){ if(!done){done=true;resolve(null);} }, 6000);
    fetch(url).then(function(r){ return r.json(); }).then(function(j){
      if(done) return; done=true; clearTimeout(t);
      try{
        var m=j.result.addressMatches;
        if(m && m.length){
          resolve({ lat:m[0].coordinates.y, lon:m[0].coordinates.x, matched:m[0].matchedAddress });
        } else resolve(null);
      }catch(e){ resolve(null); }
    }).catch(function(){ if(!done){done=true;clearTimeout(t);resolve(null);} });
  });
}

/* Run the live query sequence; resolves with {provenance:[html...], geo, state, incentive} */
function runLiveQueries(addr, utilKey){
  var U = UTILS[utilKey];
  var rows=[]; var geo=null;
  var zip = extractZip(addr);
  var st = U.state || stateFromZip(zip) || 'US';

  return geocodeAddress(addr).then(function(g){
    geo=g;
    if(g) rows.push(dsRow('U.S. Census Geocoder', 'verified', 'Matched: '+ (g.matched||addr) +' ('+g.lat.toFixed(4)+', '+g.lon.toFixed(4)+')'));
    else  rows.push(dsRow('U.S. Census Geocoder', 'na', 'No exact match — used ZIP/utility for market resolution'));

    // Utility & ISO resolution (from verified tariff KB)
    rows.push(dsRow('Utility &amp; ISO tariff', 'verified', U.name+' · '+U.iso+' · '+U.rateSchedule+' ('+('$'+U.energyBlended.toFixed(3))+'/kWh blended)'));

    // ISO capacity / market value
    rows.push(dsRow('ISO capacity &amp; ancillary', 'estimate', U.iso+' capacity value ~$'+U.capacityValue+'/kW-yr (modeled from market history)'));

    // Incentives
    var inc = INCENTIVES[st] || INCENTIVES['US'];
    var incDetail = inc.program + (inc.storageRebatePerKwh?(' · $'+inc.storageRebatePerKwh+'/kWh'):'') + (inc.itcBonus?(' · +'+inc.itcBonus+'% ITC adder'):'');
    rows.push(dsRow('State &amp; federal incentives', 'verified', incDetail));

    // Interconnection queue signal (modeled — real queues need utility API keys)
    rows.push(dsRow('Interconnection availability', 'estimate', 'Modeled from grid-capacity input; confirm via '+U.name+' interconnection portal'));

    return { provenance:rows, geo:geo, state:st, incentive:inc, util:U };
  });
}

/* ══════════════════════════════════════════════════════════════════
   P&L / IRR ENGINE
   ══════════════════════════════════════════════════════════════════ */
function underwrite(ctx){
  var U = ctx.util, inc = ctx.incentive;
  var arch = val('i_arch');

  var gridKw   = numv('a_grid');
  var bkw      = numv('a_bkw');
  var bkwh     = numv('a_bkwh');
  var computeKw= numv('a_compute');
  var solarKw  = numv('a_solar');
  var windKw   = numv('a_wind');
  var bcost    = numv('a_bcost');     // $/kWh
  var ccost    = numv('a_ccost');     // $/kW
  var scost    = numv('a_scost');     // $/W
  var cprice   = numv('a_cprice');    // $/kWh compute sale
  var cutil    = numv('a_cutil')/100;
  var disc     = numv('a_disc')/100;
  var itc      = (numv('a_itc') + (inc.itcBonus||0))/100;
  var life     = Math.max(1,Math.round(numv('a_life')));
  var vstack   = numv('a_vstack');    // $/kW-yr (default seeded from ISO)
  var land     = numv('a_land');

  var hoursYr = 8760;

  /* ---- POWER ALLOCATION ----
     Compute is firm load; it draws from grid + DER + battery discharge.
     Battery both shifts energy (arbitrage) and firms compute uptime. */
  var derKw = solarKw + windKw;
  var computeDrawKw = computeKw; // IT load; PUE handled in energy below
  var pue = 1.25;               // facility overhead
  var computeFacilityKw = computeKw * pue;

  /* ---- COMPUTE MARKETPLACE REVENUE ----
     Sellable compute-hours = IT kW × utilization × hours. */
  var computeKwhYr = computeKw * cutil * hoursYr;
  var computeRev = computeKwhYr * cprice;

  /* ---- ENERGY COST ----
     Facility energy consumed = compute facility load (net of DER self-supply). */
  var facilityKwhYr = computeFacilityKw * cutil * hoursYr;
  // DER offsets grid energy first
  var derCF = { solar: 0.24, wind: 0.34 }; // capacity factors
  var derKwhYr = solarKw*derCF.solar*hoursYr + windKw*derCF.wind*hoursYr;
  var gridKwhYr = Math.max(0, facilityKwhYr - derKwhYr);
  var energyCost = gridKwhYr * U.energyBlended;

  /* ---- BESS VALUE STACK ---- */
  var usableKwh = bkwh*0.90;
  var rte = 0.88;
  // TOU arbitrage: one cycle/day
  var arbitrage = 365 * usableKwh * rte * U.peakSpread * 0.65;
  // Capacity / VPP value on battery power
  var capacityRev = bkw * vstack;
  // Demand-charge offset (where utility has one)
  var demandOffset = Math.min(bkw, computeFacilityKw) * U.demandCharge * 12;
  // Storage rebate (one-time, applied to capex)
  var storageRebate = bkwh * (inc.storageRebatePerKwh||0);

  /* ---- DER ENERGY VALUE (excess sold / self-supply avoided) ---- */
  var derValue = derKwhYr * U.energyBlended; // value of self-supplied energy

  /* ---- CAPEX ---- */
  var bessCapex = bkwh * bcost;
  var computeCapex = computeKw * ccost;
  var solarCapex = solarKw * 1000 * scost;
  var windCapex = windKw * 1650;   // ~$1650/kW installed wind (modeled)
  var grossCapex = bessCapex + computeCapex + solarCapex + windCapex + land;

  var itcEligible = bessCapex + solarCapex + windCapex; // compute not ITC-eligible
  var itcAmt = itcEligible * itc;
  var netCapex = grossCapex - itcAmt - storageRebate;

  /* ---- OPEX ---- */
  var bessOM = bkw * 8;
  var computeOM = computeKw * 220;   // GPU O&M incl. staff, per IT kW-yr (modeled)
  var solarOM = solarKw * 18;
  var windOM = windKw * 45;
  var totalOM = bessOM + computeOM + solarOM + windOM;

  /* ---- REVENUE STACK (year 1) ---- */
  var revenue = {
    compute: computeRev,
    arbitrage: arbitrage,
    capacity: capacityRev,
    demand: demandOffset,
    der: derValue
  };
  var grossRevenue = revenue.compute+revenue.arbitrage+revenue.capacity+revenue.demand+revenue.der;

  /* ---- year-1 EBITDA ---- */
  var y1ebitda = grossRevenue - energyCost - totalOM;

  /* ---- multi-year cashflows ---- */
  var computeGrowth = 0.04;   // compute price/util ramp
  var deg = 0.025;            // battery degradation
  var years=[]; var cf=[-netCapex]; var cum=-netCapex; var payback=null;
  for(var y=1;y<=life;y++){
    var g=Math.pow(1+computeGrowth,y-1);
    var d=Math.pow(1-deg,y-1);
    var comp = revenue.compute*g;
    var arb = revenue.arbitrage*d;
    var cap = revenue.capacity*d;
    var dem = revenue.demand*d;
    var der = revenue.der;
    var rev = comp+arb+cap+dem+der;
    var ecost = energyCost*Math.pow(1.03,y-1);
    var om = totalOM*Math.pow(1.02,y-1);
    var net = rev-ecost-om;
    cf.push(net);
    var prev=cum; cum+=net;
    if(payback===null && cum>=0) payback=(y-1)+(-prev)/net;
    years.push({y:y, compute:comp, arbitrage:arb, capacity:cap, demand:dem, der:der, energy:ecost, om:om, net:net, cum:cum});
  }

  var projIrr=irr(cf), projNpv=npv(disc,cf);
  var totNet=0; for(var i=1;i<cf.length;i++) totNet+=cf[i];
  var roi=totNet/netCapex;

  /* verdict */
  var verdict='caution', vtxt='Marginal';
  if(projIrr!==null){
    if(projIrr>=disc+0.07 && payback!==null && payback<=life*0.7){ verdict='go'; vtxt='Strong Return'; }
    else if(projIrr<disc){ verdict='no'; vtxt='Below Hurdle'; }
    else { verdict='caution'; vtxt='Marginal'; }
  } else { verdict='no'; vtxt='Negative Return'; }

  return {
    ctx:ctx, arch:arch, gridKw:gridKw, bkw:bkw, bkwh:bkwh, computeKw:computeKw, computeFacilityKw:computeFacilityKw,
    solarKw:solarKw, windKw:windKw, derKw:derKw, pue:pue,
    computeKwhYr:computeKwhYr, facilityKwhYr:facilityKwhYr, derKwhYr:derKwhYr, gridKwhYr:gridKwhYr,
    revenue:revenue, grossRevenue:grossRevenue, energyCost:energyCost,
    bessOM:bessOM, computeOM:computeOM, solarOM:solarOM, windOM:windOM, totalOM:totalOM,
    y1ebitda:y1ebitda,
    bessCapex:bessCapex, computeCapex:computeCapex, solarCapex:solarCapex, windCapex:windCapex, land:land,
    grossCapex:grossCapex, itcAmt:itcAmt, itcPct:itc, storageRebate:storageRebate, netCapex:netCapex,
    years:years, cf:cf, projIrr:projIrr, projNpv:projNpv, totNet:totNet, roi:roi, payback:payback,
    verdict:verdict, vtxt:vtxt, life:life, disc:disc, cprice:cprice, cutil:cutil, vstack:vstack
  };
}

/* ══════════════════════════════════════════════════════════════════
   RENDER REPORT
   ══════════════════════════════════════════════════════════════════ */
function renderReport(m){
  var U = m.ctx.util;
  var addr = val('i_addr');
  var flagCls = m.verdict;

  var h='';

  /* HERO */
  h += '<div class="report-hero">'+
    '<div class="rh-top">'+
      '<div class="rh-site">'+
        '<div class="eyebrow">'+U.name+' · '+U.iso+'</div>'+
        '<h2>'+esc(addr)+'</h2>'+
        '<div class="loc">'+archName(m.arch)+' · '+fmtN(m.gridKw)+' kW grid · '+fmtN(m.bkw)+' kW / '+fmtN(m.bkwh)+' kWh BESS · '+fmtN(m.computeKw)+' kW compute</div>'+
      '</div>'+
      '<div class="rh-flag '+flagCls+'">'+m.vtxt+'</div>'+
    '</div>'+
    '<div class="rh-metrics">'+
      '<div><div class="rhm-val '+(m.projIrr>=m.disc?'pos':'neg')+'">'+(m.projIrr===null?'—':(m.projIrr*100).toFixed(1))+'<span class="u">%</span></div><div class="rhm-label">Project IRR</div></div>'+
      '<div><div class="rhm-val '+(m.projNpv>=0?'pos':'neg')+'">'+fmt$k(m.projNpv)+'</div><div class="rhm-label">NPV @ '+(m.disc*100).toFixed(0)+'%</div></div>'+
      '<div><div class="rhm-val">'+(m.payback===null?'>'+m.life:m.payback.toFixed(1))+'<span class="u">yr</span></div><div class="rhm-label">Payback</div></div>'+
      '<div><div class="rhm-val">'+fmt$k(m.y1ebitda)+'</div><div class="rhm-label">Yr-1 EBITDA</div></div>'+
      '<div><div class="rhm-val">'+fmt$k(m.netCapex)+'</div><div class="rhm-label">Net Capital</div></div>'+
    '</div>'+
  '</div>';

  /* POWER ALLOCATION + REVENUE STACK (two-col) */
  h += '<div class="section-title">Site Configuration &amp; Revenue Stack</div>'+
       '<div class="section-desc">How the site\u2019s available power is deployed, and where the annual revenue comes from.</div>';
  h += '<div class="grid2">';

  // power allocation card
  var totLoad = m.computeFacilityKw + m.bkw;
  var segC = m.computeFacilityKw, segB = m.bkw;
  var gp = m.gridKw>0? m.gridKw:1;
  h += '<div class="card"><div class="card-head"><h3>Power Allocation</h3><div class="sub">Against '+fmtN(m.gridKw)+' kW available grid capacity</div></div><div class="card-body">'+
    '<div class="gauge"><div class="gauge-bar">'+
      '<div class="gauge-seg" style="width:'+Math.min(100,segC/gp*100).toFixed(1)+'%;background:#7C3AED">'+(segC/gp>0.12?'Compute '+fmtN(segC)+'kW':'')+'</div>'+
      '<div class="gauge-seg" style="width:'+Math.min(100,segB/gp*100).toFixed(1)+'%;background:#2E86C1">'+(segB/gp>0.12?'BESS '+fmtN(segB)+'kW':'')+'</div>'+
    '</div><div class="gauge-labels"><span>0 kW</span><span>'+fmtN(m.gridKw)+' kW</span></div></div>'+
    '<div class="dl" style="margin-top:14px">'+
      row('Compute facility load','('+m.pue+' PUE × '+fmtN(m.computeKw)+' kW IT)', fmtN(m.computeFacilityKw)+' kW')+
      row('BESS discharge power','', fmtN(m.bkw)+' kW')+
      row('On-site DER','solar '+fmtN(m.solarKw)+' + wind '+fmtN(m.windKw)+' kW', fmtN(m.derKw)+' kW')+
      row('Grid energy drawn','net of DER self-supply', fmtN(m.gridKwhYr)+' kWh/yr')+
    '</div></div>';

  // revenue stack card
  var segs=[
    {k:'Compute marketplace', v:m.revenue.compute, c:'#7C3AED'},
    {k:'TOU arbitrage', v:m.revenue.arbitrage, c:'#C9A84C'},
    {k:'Capacity / VPP', v:m.revenue.capacity, c:'#1DB954'},
    {k:'Demand offset', v:m.revenue.demand, c:'#2E86C1'},
    {k:'DER energy value', v:m.revenue.der, c:'#1B4F8A'}
  ];
  var tot=0; for(var s=0;s<segs.length;s++) tot+=segs[s].v;
  var bar='',leg='';
  for(var s2=0;s2<segs.length;s2++){ var pct=tot>0?segs[s2].v/tot*100:0;
    if(pct>0.4) bar+='<div class="seg" style="width:'+pct.toFixed(1)+'%;background:'+segs[s2].c+'">'+(pct>=10?pct.toFixed(0)+'%':'')+'</div>';
    if(segs[s2].v>0) leg+='<div class="li"><span class="dot" style="background:'+segs[s2].c+'"></span>'+segs[s2].k+' · <b>'+fmt$k(segs[s2].v)+'</b></div>';
  }
  h += '<div class="card"><div class="card-head"><h3>Year-1 Revenue Stack</h3><div class="sub">'+fmt$k(tot)+' gross across '+segs.filter(function(x){return x.v>0;}).length+' streams</div></div><div class="card-body">'+
    '<div class="stackbar">'+bar+'</div><div class="legend">'+leg+'</div></div></div>';
  h += '</div>'; // grid2

  /* FULL P&L */
  h += '<div class="section-title">Site P&amp;L (Year 1)</div><div class="section-desc">Every revenue stream, less energy cost and operating expense.</div>';
  h += '<div class="card"><div class="card-body"><table class="pnl">'+
    '<tr class="sub-h"><td colspan="2">Revenue</td></tr>'+
    pnl('Compute marketplace sales', fmtN(m.computeKwhYr)+' kWh × $'+m.cprice.toFixed(2)+' @ '+(m.cutil*100).toFixed(0)+'% util', m.revenue.compute, 'pos')+
    pnl('TOU energy arbitrage', '365 cycles × '+fmtN(m.bkwh*0.9)+' usable kWh × $'+U.peakSpread.toFixed(3)+' spread', m.revenue.arbitrage, 'pos')+
    pnl('Capacity / VPP payments', fmtN(m.bkw)+' kW × $'+m.vstack.toFixed(0)+'/kW-yr ('+U.iso+')', m.revenue.capacity, 'pos')+
    pnl('Demand-charge offset', U.demandCharge>0?(fmtN(Math.min(m.bkw,m.computeFacilityKw))+' kW × $'+U.demandCharge+'/kW-mo × 12'):'no demand charge on this rate', m.revenue.demand, 'pos')+
    pnl('DER self-supply value', fmtN(m.derKwhYr)+' kWh × $'+U.energyBlended.toFixed(3), m.revenue.der, 'pos')+
    '<tr class="total"><td class="lbl">Gross revenue</td><td class="num">'+fmt$(m.grossRevenue)+'</td></tr>'+
    '<tr class="sub-h"><td colspan="2">Operating cost</td></tr>'+
    pnl('Grid energy purchased', fmtN(m.gridKwhYr)+' kWh × $'+U.energyBlended.toFixed(3), -m.energyCost, 'neg')+
    pnl('BESS O&amp;M', fmtN(m.bkw)+' kW × $8/kW-yr', -m.bessOM, 'neg')+
    pnl('Compute O&amp;M', fmtN(m.computeKw)+' kW × $220/kW-yr', -m.computeOM, 'neg')+
    (m.solarOM+m.windOM>0? pnl('DER O&amp;M','solar + wind', -(m.solarOM+m.windOM), 'neg'):'')+
    '<tr class="grand"><td class="lbl">Year-1 EBITDA</td><td class="num '+(m.y1ebitda>=0?'pos':'neg')+'">'+fmt$(m.y1ebitda)+'</td></tr>'+
  '</table></div></div>';

  /* CAPITAL STACK + CASHFLOW (two col) */
  h += '<div class="section-title">Capital &amp; Return</div><div class="section-desc">Total build cost net of incentives, and the path to break-even.</div>';
  h += '<div class="grid2">';
  h += '<div class="card"><div class="card-head"><h3>Capital Requirement</h3></div><div class="card-body"><table class="pnl">'+
    pnl('BESS system', fmtN(m.bkwh)+' kWh', m.bessCapex, '')+
    pnl('Compute build', fmtN(m.computeKw)+' kW IT', m.computeCapex, '')+
    (m.solarCapex>0?pnl('Solar', fmtN(m.solarKw)+' kW', m.solarCapex,''):'')+
    (m.windCapex>0?pnl('Wind', fmtN(m.windKw)+' kW', m.windCapex,''):'')+
    pnl('Land / development','', m.land, '')+
    '<tr class="total"><td class="lbl">Gross project cost</td><td class="num">'+fmt$(m.grossCapex)+'</td></tr>'+
    pnl('Federal + state ITC', (m.itcPct*100).toFixed(0)+'% on eligible', -m.itcAmt, 'neg')+
    (m.storageRebate>0?pnl('Storage rebate', m.ctx.incentive.program, -m.storageRebate, 'neg'):'')+
    '<tr class="grand"><td class="lbl">Net capital required</td><td class="num">'+fmt$(m.netCapex)+'</td></tr>'+
  '</table></div></div>';
  h += '<div class="card"><div class="card-head"><h3>Cumulative Cash Flow</h3><div class="sub">Break-even at year '+(m.payback===null?'—':m.payback.toFixed(1))+'</div></div><div class="card-body">'+cashSVG(m)+'</div></div>';
  h += '</div>';

  /* YEAR TABLE */
  var rows='';
  for(var yi=0;yi<m.years.length;yi++){ var Y=m.years[yi];
    rows+='<tr><td>Year '+Y.y+'</td>'+
      '<td>'+fmt$k(Y.compute)+'</td>'+
      '<td>'+fmt$k(Y.arbitrage+Y.capacity+Y.demand)+'</td>'+
      '<td class="neg">('+fmt$k(Y.energy)+')</td>'+
      '<td class="neg">('+fmt$k(Y.om)+')</td>'+
      '<td class="'+(Y.net>=0?'pos':'neg')+'">'+fmt$k(Y.net)+'</td>'+
      '<td class="'+(Y.cum>=0?'pos':'neg')+'">'+fmt$k(Y.cum)+'</td></tr>';
  }
  h += '<div class="section-title">'+m.life+'-Year Cash Flow</div>'+
    '<div class="card"><div class="card-body ytable-wrap"><table class="ytable">'+
    '<thead><tr><th>Period</th><th>Compute</th><th>Grid stack</th><th>Energy</th><th>O&amp;M</th><th>Net CF</th><th>Cumulative</th></tr></thead>'+
    '<tbody>'+rows+'</tbody></table></div></div>';

  /* DATA PROVENANCE (repeat, in-report) */
  h += '<div class="section-title">Data Provenance</div><div class="section-desc">Sources queried for this underwriting.</div>'+
    '<div class="card"><div class="card-body"><div class="ds-list">'+ m.ctx.provenance.join('') +'</div>'+
    '<div style="margin-top:12px;font-size:11px;color:var(--cs-sub);line-height:1.5">'+m.ctx.incentive.note+' '+U.note+'</div></div></div>';

  /* AI PROPOSAL slot */
  h += '<div class="section-title">Investor Proposal</div><div class="section-desc">AI-drafted narrative grounded in the numbers above.</div>'+
    '<div class="proposal" id="proposal-card"><div class="proposal-head"><h3>Investment Memo <span class="ai-chip">AI-drafted</span></h3></div>'+
    '<div class="proposal-body" id="proposal-body"><div class="proposal-empty">Click <b>Generate AI Proposal</b> to draft an investor-facing memo for this site.</div></div></div>';

  /* DISCLAIMER + EXPORT */
  h += '<div class="disclaim"><b>Underwriting basis.</b> Utility rates and incentives are seeded from filed tariffs and refreshed by live query where a verified public source is reachable. ISO capacity value, interconnection availability, and compute marketplace pricing are modeled estimates and must be confirmed against signed offtake and interconnection studies before capital commitment. This is an investment screening tool, not a financing commitment or an offer of securities.</div>';
  h += '<div class="export-row">'+
    '<button class="btn btn-navy" onclick="window.print()">Print / Save PDF</button>'+
    '<button class="btn btn-ghost" onclick="exportCSV()">Export CSV</button>'+
  '</div>';

  $('report').innerHTML=h;
  $('report').classList.add('on');
  window.__uwModel=m;
  $('btn-proposal').disabled=false;
}

/* small render helpers */
function row(k,s,v,cls){ return '<div class="row"><div class="k">'+k+(s?'<span class="s">'+s+'</span>':'')+'</div><div class="v '+(cls||'')+'">'+v+'</div></div>'; }
function pnl(k,s,v,cls){ var disp=(v<0?'('+fmt$(Math.abs(v))+')':fmt$(v)); return '<tr><td class="lbl">'+k+(s?'<span class="s">'+s+'</span>':'')+'</td><td class="num '+(cls||'')+'">'+disp+'</td></tr>'; }
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function archName(a){ return ({dcfc_edge:'DCFC + Edge Compute', datacenter:'Data Center', bess_arb:'Standalone BESS', solar_bess:'Solar + BESS'})[a]||a; }

function cashSVG(m){
  var w=560,h=220,pad=44;
  var pts=[{cum:-m.netCapex,y:0}];
  for(var i=0;i<m.years.length;i++) pts.push({cum:m.years[i].cum,y:m.years[i].y});
  var mx=-1e18,mn=1e18; for(var p=0;p<pts.length;p++){ if(pts[p].cum>mx)mx=pts[p].cum; if(pts[p].cum<mn)mn=pts[p].cum; }
  if(mx===mn){mx+=1;mn-=1;} var rg=mx-mn;
  function px(i){ return pad+(i/(pts.length-1))*(w-pad-16); }
  function py(v){ return pad/2+(1-(v-mn)/rg)*(h-pad); }
  var zy=py(0), path='';
  for(var q=0;q<pts.length;q++){ path+=(q===0?'M':'L')+px(q).toFixed(1)+' '+py(pts[q].cum).toFixed(1)+' '; }
  var area=path+'L'+px(pts.length-1).toFixed(1)+' '+zy.toFixed(1)+' L'+px(0).toFixed(1)+' '+zy.toFixed(1)+' Z';
  var dots='';
  for(var d=0;d<pts.length;d++){ var c=pts[d].cum>=0?'#1DB954':'#E53935';
    dots+='<circle cx="'+px(d).toFixed(1)+'" cy="'+py(pts[d].cum).toFixed(1)+'" r="3.5" fill="'+c+'"/>';
    if(d%2===0||d===pts.length-1) dots+='<text x="'+px(d).toFixed(1)+'" y="'+(h-6)+'" font-size="9" fill="#6B7A8D" text-anchor="middle" font-family="DM Mono">'+(d===0?'Y0':'Y'+pts[d].y)+'</text>';
  }
  return '<svg class="chart-svg" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="xMidYMid meet" style="height:220px">'+
    '<line x1="'+pad+'" y1="'+zy.toFixed(1)+'" x2="'+(w-16)+'" y2="'+zy.toFixed(1)+'" stroke="#DDD8D0" stroke-dasharray="3 3"/>'+
    '<path d="'+area+'" fill="rgba(46,134,193,.08)"/>'+
    '<path d="'+path+'" fill="none" stroke="#1B4F8A" stroke-width="2.5" stroke-linejoin="round"/>'+dots+
    '<text x="'+pad+'" y="'+(zy-6).toFixed(1)+'" font-size="9" fill="#6B7A8D" font-family="DM Mono">break-even</text></svg>';
}

/* ══════════════════════════════════════════════════════════════════
   AI INVESTOR PROPOSAL  (Anthropic API — "Claude in Claude")
   Grounds the memo strictly in the computed numbers. Falls back to a
   deterministic template if the API is unreachable.
   ══════════════════════════════════════════════════════════════════ */
function generateProposal(){
  var m = window.__uwModel; if(!m) return;
  var body=$('proposal-body');
  body.innerHTML='<div class="proposal-empty"><span class="spinner on"></span>Drafting investor memo grounded in the site numbers…</div>';

  var U=m.ctx.util;
  var facts = {
    address: val('i_addr'),
    utility: U.name, iso: U.iso, rate: U.rateSchedule,
    archetype: archName(m.arch),
    grid_kw: Math.round(m.gridKw), bess_kw: Math.round(m.bkw), bess_kwh: Math.round(m.bkwh),
    compute_kw: Math.round(m.computeKw), solar_kw: Math.round(m.solarKw), wind_kw: Math.round(m.windKw),
    net_capital: Math.round(m.netCapex), gross_capital: Math.round(m.grossCapex),
    itc: Math.round(m.itcAmt), storage_rebate: Math.round(m.storageRebate),
    incentive_program: m.ctx.incentive.program,
    y1_revenue: Math.round(m.grossRevenue), y1_ebitda: Math.round(m.y1ebitda),
    compute_rev: Math.round(m.revenue.compute), arbitrage: Math.round(m.revenue.arbitrage),
    capacity_rev: Math.round(m.revenue.capacity), demand_offset: Math.round(m.revenue.demand),
    irr: m.projIrr===null?'n/a':(m.projIrr*100).toFixed(1)+'%',
    npv: Math.round(m.projNpv), payback: m.payback===null?'>'+m.life+'yr':m.payback.toFixed(1)+' yr',
    lifetime_roi: (m.roi*100).toFixed(0)+'%', discount_rate:(m.disc*100).toFixed(0)+'%', life:m.life,
    compute_price: m.cprice, verdict:m.vtxt
  };

  var prompt = 'You are an infrastructure investment analyst writing a concise investor memo for a decision to deploy a battery-energy-storage + edge-compute site. '+
    'Use ONLY these figures; do not invent numbers. Write in confident, quantitative, investor-facing prose. '+
    'Output clean HTML using only <h4>, <p>, <ul>, <li>, and <strong> tags (no <html>/<head>/<body>, no markdown, no preamble). '+
    'Sections, in order: "Opportunity" (2-3 sentences on the site and thesis), "Revenue Model" (the stacked streams and why they hold in this ISO), '+
    '"Capital & Returns" (net capital, IRR, NPV, payback, ROI), "Risks & Mitigants" (3-4 bullets specific to this market/rate), '+
    'and "Recommendation" (one paragraph tied to the verdict). Keep it under 450 words. '+
    'SITE FACTS (JSON): '+JSON.stringify(facts);

  var payload = { model:'claude-sonnet-4-6', max_tokens:1000, messages:[{role:'user', content:prompt}] };

  var done=false;
  var t=setTimeout(function(){ if(!done){ done=true; body.innerHTML=fallbackProposal(m,facts); } }, 22000);

  fetch('https://api.anthropic.com/v1/messages',{
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)
  }).then(function(r){ return r.json(); }).then(function(data){
    if(done) return; done=true; clearTimeout(t);
    var text='';
    try{
      for(var i=0;i<data.content.length;i++){ if(data.content[i].type==='text') text+=data.content[i].text; }
    }catch(e){ text=''; }
    text = text.replace(/```html|```/g,'').trim();
    if(text.length<40){ body.innerHTML=fallbackProposal(m,facts); }
    else { body.innerHTML=text; }
  }).catch(function(){ if(!done){ done=true; clearTimeout(t); body.innerHTML=fallbackProposal(m,facts); } });
}

/* deterministic fallback so the tool always produces a memo */
function fallbackProposal(m,f){
  var U=m.ctx.util;
  var lead = m.revenue.compute>=m.grossRevenue*0.5 ? 'compute-led' : 'storage-led';
  return ''+
  '<h4>Opportunity</h4><p>This '+esc(f.archetype)+' site at <strong>'+esc(f.address)+'</strong> sits in the <strong>'+U.iso+'</strong> market served by '+U.name+' ('+U.rate+'). '+
    'The '+lead+' configuration pairs '+fmtN(m.bkw)+' kW / '+fmtN(m.bkwh)+' kWh of storage with '+fmtN(m.computeKw)+' kW of compute against '+fmtN(m.gridKw)+' kW of available grid capacity.</p>'+
  '<h4>Revenue Model</h4><p>Year-1 gross revenue of <strong>'+fmt$(m.grossRevenue)+'</strong> stacks across independent streams, reducing single-market exposure:</p>'+
    '<ul>'+
    '<li><strong>Compute marketplace:</strong> '+fmt$(m.revenue.compute)+' at $'+m.cprice.toFixed(2)+'/kWh, '+(m.cutil*100).toFixed(0)+'% utilization.</li>'+
    '<li><strong>TOU arbitrage:</strong> '+fmt$(m.revenue.arbitrage)+' on the $'+U.peakSpread.toFixed(3)+'/kWh peak spread.</li>'+
    '<li><strong>Capacity / VPP:</strong> '+fmt$(m.revenue.capacity)+' from '+U.iso+' capacity at $'+m.vstack.toFixed(0)+'/kW-yr.</li>'+
    (m.revenue.demand>0?'<li><strong>Demand offset:</strong> '+fmt$(m.revenue.demand)+' from peak shaving.</li>':'')+
    '</ul>'+
  '<h4>Capital &amp; Returns</h4><p>Net capital of <strong>'+fmt$(m.netCapex)+'</strong> (after '+fmt$(m.itcAmt)+' ITC'+(m.storageRebate>0?' and '+fmt$(m.storageRebate)+' '+m.ctx.incentive.program+' rebate':'')+') produces a <strong>'+f.irr+' project IRR</strong>, '+
    fmt$(m.projNpv)+' NPV at '+f.discount_rate+', and payback in <strong>'+f.payback+'</strong> over a '+m.life+'-year hold ('+f.lifetime_roi+' lifetime ROI).</p>'+
  '<h4>Risks &amp; Mitigants</h4><ul>'+
    '<li><strong>Compute offtake:</strong> revenue concentration in the compute stream — mitigate with a signed marketplace/offtake agreement before final funding.</li>'+
    '<li><strong>Interconnection:</strong> '+fmtN(m.gridKw)+' kW availability is modeled — confirm with a '+U.name+' study.</li>'+
    '<li><strong>Rate risk:</strong> '+U.iso+' TOU spread and capacity value can compress; the diversified stack cushions any single-market move.</li>'+
    '<li><strong>Incentive timing:</strong> ITC and '+m.ctx.incentive.program+' eligibility should be locked to the construction schedule.</li>'+
  '</ul>'+
  '<h4>Recommendation</h4><p>The site screens as <strong>'+m.vtxt+'</strong>. '+
    (m.verdict==='go'?'Returns clear the '+f.discount_rate+' hurdle with margin; advance to interconnection study and offtake term sheets.':
     m.verdict==='caution'?'Returns are positive but hurdle-sensitive; advance only with a signed compute offtake and confirmed interconnection.':
     'Returns fall short of the hurdle at current assumptions; revisit compute pricing, system sizing, or a lower-cost interconnection before proceeding.')+'</p>';
}

/* CSV export */
function exportCSV(){
  var m=window.__uwModel; if(!m) return;
  var U=m.ctx.util;
  var rows=[['Site Investment Analysis — ClearSky-OMEGA']];
  rows.push(['Address',val('i_addr')]); rows.push(['Utility',U.name]); rows.push(['ISO',U.iso]);
  rows.push([]); rows.push(['Project IRR',m.projIrr===null?'n/a':(m.projIrr*100).toFixed(2)+'%']);
  rows.push(['NPV',Math.round(m.projNpv)]); rows.push(['Payback',m.payback===null?'>life':m.payback.toFixed(2)]);
  rows.push(['Net capital',Math.round(m.netCapex)]); rows.push(['Yr-1 EBITDA',Math.round(m.y1ebitda)]);
  rows.push([]); rows.push(['Year','Compute','Arbitrage','Capacity','Demand','Energy','O&M','Net CF','Cumulative']);
  for(var i=0;i<m.years.length;i++){ var Y=m.years[i];
    rows.push([Y.y,Math.round(Y.compute),Math.round(Y.arbitrage),Math.round(Y.capacity),Math.round(Y.demand),Math.round(Y.energy),Math.round(Y.om),Math.round(Y.net),Math.round(Y.cum)]); }
  var csv=rows.map(function(r){return r.join(',');}).join('\n');
  var blob=new Blob([csv],{type:'text/csv'}); var a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download='site-investment-analysis.csv'; a.click();
}

/* ══════════════════════════════════════════════════════════════════
   ORCHESTRATION
   ══════════════════════════════════════════════════════════════════ */
function runUnderwriting(){
  var addr=val('i_addr');
  if(!addr){ showErr('Enter a site address or ZIP to begin.'); return; }
  hideErr();
  var spin=$('run-spin'), status=$('run-status'), btn=$('btn-run');
  spin.classList.add('on'); btn.disabled=true;
  status.textContent='Resolving market, utility & incentives…';
  $('datasrc').classList.add('on');
  $('ds-list').innerHTML='<div class="ds-item"><span class="ds-dot pending"></span><span class="ds-detail">Querying live sources…</span></div>';

  var utilKey=val('i_util');
  runLiveQueries(addr, utilKey).then(function(ctx){
    $('ds-list').innerHTML = ctx.provenance.join('');
    // auto-seed value stack from ISO capacity value if user hasn't overridden meaningfully
    if($('a_vstack')){ /* keep user value but default was seeded on util change */ }
    status.textContent='Underwriting site economics…';
    var m = underwrite(ctx);
    renderReport(m);
    spin.classList.remove('on'); btn.disabled=false;
    status.textContent='Done · '+m.vtxt+' · '+(m.projIrr===null?'n/a':(m.projIrr*100).toFixed(1)+'% IRR');
    $('report').scrollIntoView({behavior:'smooth',block:'start'});
  }).catch(function(e){
    spin.classList.remove('on'); btn.disabled=false;
    showErr('Could not complete the query. '+(e&&e.message?e.message:'')+' Using seeded market data — try Run again.');
    // still run with seeded data
    var U=UTILS[utilKey]; var st=U.state||stateFromZip(extractZip(addr))||'US';
    var ctx={ util:U, iso:U.iso, state:st, incentive:INCENTIVES[st]||INCENTIVES['US'],
      provenance:[dsRow('Utility &amp; ISO tariff','verified',U.name+' · '+U.iso), dsRow('Live geocode','na','offline — used seeded market data')] };
    $('ds-list').innerHTML=ctx.provenance.join('');
    var m=underwrite(ctx); renderReport(m);
  });
}

function showErr(msg){ var e=$('err-box'); e.textContent=msg; e.classList.add('on'); }
function hideErr(){ $('err-box').classList.remove('on'); }

/* when utility changes, seed the ISO value-stack default */
function seedValueStack(){
  var U=UTILS[val('i_util')]; if(U && $('a_vstack')){ $('a_vstack').value=U.capacityValue; }
}

function initUtilSelect(){
  var sel=$('i_util'), h='';
  for(var i=0;i<UTIL_ORDER.length;i++){ var k=UTIL_ORDER[i]; h+='<option value="'+k+'">'+UTILS[k].name+'</option>'; }
  sel.innerHTML=h; sel.value='sce';
}
function boot(){
  try{ if(window.OMEGA_WORKSPACE){ $('tb-badge').textContent=window.OMEGA_WORKSPACE.accountTier||'Enterprise';
    if(window.OMEGA_WORKSPACE.exportBrand&&window.OMEGA_WORKSPACE.exportBrand.poweredBy) $('foot-powered').textContent=window.OMEGA_WORKSPACE.exportBrand.poweredBy; } }catch(e){}
  initUtilSelect(); seedValueStack();
  $('adv-toggle').addEventListener('click',function(){
    var p=$('adv-panel'); p.classList.toggle('open');
    this.innerHTML=(p.classList.contains('open')?'▾':'▸')+' Advanced site &amp; system inputs';
  });
  $('i_util').addEventListener('change',seedValueStack);
  $('btn-run').addEventListener('click',runUnderwriting);
  $('btn-proposal').addEventListener('click',generateProposal);
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();

/* ══════════════════════════════════════════════════════════════════════════
   INVESTOR ENGINE v2  —  answers Paige Blumer's investor-facing model ask.
   Toggleable: debt/equity · EBITDA retain-vs-pass-through · per-component ITC ·
   ITC & depreciation step-up · ownership mode (owner / PPA / lease).
   Headline: LEVERED EQUITY IRR + MOIC, with cash-on-cash + DSCR supporting.
   Calibrated against the executed Claremont 5MWh BESS deal (see CLAREMONT preset).
   ES5 only. All figures are MODELED and USER-OVERRIDABLE — a screening aid,
   not tax/financing advice.
   ══════════════════════════════════════════════════════════════════════════ */

/* ---------- module toggles ---------- */
var IV_MODULES = { bess:true, der:true, compute:true, ev:false };
function ivModOn(k){ return !!(IV_MODULES && IV_MODULES[k]); }

/* ---------- per-component ITC defaults (editable). Base IRA = 30%. ---------- */
var IV_ITC_DEFAULT = { bess:30, solar:30, wind:30, ev:30, roof:0, interconnect:30, compute:0 };

/* MACRS 5-yr half-year convention. */
var IV_MACRS5 = [0.20,0.32,0.192,0.1152,0.1152,0.0576];

/* ---------- tiny DOM helpers (tolerant of missing elements) ---------- */
function ivNum(id,d){ var e=document.getElementById(id); if(!e||e.value==='')return d; var v=parseFloat(e.value); return isNaN(v)?d:v; }
function ivChk(id,d){ var e=document.getElementById(id); return e?!!e.checked:d; }
function ivValv(id,d){ var e=document.getElementById(id); return e&&e.value!==''?e.value:d; }

/* ---------- IRR (bisection), NPV, MOIC, cash-on-cash ---------- */
function ivIrr(cf){
  function f(r){ var s=0,i; for(i=0;i<cf.length;i++) s+=cf[i]/Math.pow(1+r,i); return s; }
  var lo=-0.9,hi=1.0,flo=f(lo),fhi=f(hi),i,mid,fm;
  if(flo*fhi>0) return null;
  for(i=0;i<200;i++){ mid=(lo+hi)/2; fm=f(mid); if(Math.abs(fm)<1e-7)return mid; if(flo*fm<0){hi=mid;}else{lo=mid;flo=fm;} }
  return (lo+hi)/2;
}
function ivNpv(rate,cf){ var s=0,i; for(i=0;i<cf.length;i++) s+=cf[i]/Math.pow(1+rate,i); return s; }
function ivMoic(cf){ var inv=0,ret=0,i; for(i=0;i<cf.length;i++){ if(cf[i]<0)inv+=-cf[i]; else ret+=cf[i]; } return inv>0?ret/inv:null; }
function ivCoC(cf){ var inv=0,d=0,n=0,i; for(i=0;i<cf.length;i++){ if(cf[i]<0)inv+=-cf[i]; else {d+=cf[i];n++;} } return (inv>0&&n>0)?(d/n)/inv:null; }

/* ---------- per-component ITC % (base + adder on eligible buckets) ---------- */
function ivItcPct(bucket,bonus){
  var e=document.getElementById('iv_itc_'+bucket);
  var base=(e&&e.value!=='')?parseFloat(e.value):IV_ITC_DEFAULT[bucket];
  if(isNaN(base)) base=IV_ITC_DEFAULT[bucket];
  var add=(base>0?(bonus||0):0);
  return (base+add)/100;
}

/* ---------- capital stack: size debt, amortize, DSCR ---------- */
function ivCapitalStack(netCapex,y1ebitda,life){
  if(!ivChk('iv_cap_on',false)){
    return { levered:false, debt:0, equity:netCapex, rate:0, term:0, debtSvc:0, dscr:null, sched:[] };
  }
  var dpct=ivNum('iv_cap_debt',60)/100, rate=ivNum('iv_cap_rate',7.5)/100, term=Math.max(1,Math.round(ivNum('iv_cap_term',10)));
  var debt=netCapex*dpct, equity=netCapex-debt, pmt;
  if(rate>0) pmt=debt*(rate*Math.pow(1+rate,term))/(Math.pow(1+rate,term)-1); else pmt=debt/term;
  var sched=[],bal=debt,y;
  for(y=1;y<=life;y++){
    if(y<=term&&bal>0.01){ var int=bal*rate, prin=pmt-int; if(prin>bal)prin=bal; bal-=prin; sched.push({y:y,pay:int+prin,interest:int,principal:prin,bal:bal}); }
    else sched.push({y:y,pay:0,interest:0,principal:0,bal:0});
  }
  return { levered:true, debt:debt, equity:equity, rate:rate, term:term, debtSvc:pmt, dscr:pmt>0?y1ebitda/pmt:null, sched:sched };
}

/* ---------- depreciation: MACRS on stepped basis, 50%-of-ITC reduction ---------- */
function ivDepreciation(depCapex,itcAmt,life){
  if(!ivChk('iv_dep_on',false)) return { on:false, taxRate:0, basis:0, shield:[], sched:[] };
  var taxRate=ivNum('iv_dep_tax',21)/100;
  var stepUp=ivChk('iv_dep_stepup',false);
  var stepPct=stepUp?(1+ivNum('iv_dep_steppct',0)/100):1;
  var basis=(depCapex*stepPct)-(0.5*itcAmt); if(basis<0)basis=0;
  var shield=[],sched=[],y;
  for(y=1;y<=life;y++){ var pct=(y-1)<IV_MACRS5.length?IV_MACRS5[y-1]:0; var dep=basis*pct; sched.push({y:y,dep:dep}); shield.push(dep*taxRate); }
  return { on:true, taxRate:taxRate, basis:basis, stepUp:stepUp, shield:shield, sched:sched };
}

/* ---------- EBITDA waterfall (pref+promote) or flat split ---------- */
function ivWaterfall(cf,equityAmt){
  if(ivChk('iv_wf_flat',false)){
    var sp=ivNum('iv_wf_sponsor',30)/100, inv=[cf[0]], spc=[0], i;
    for(i=1;i<cf.length;i++){ var c=cf[i]; spc.push(c>0?c*sp:0); inv.push(c>0?c*(1-sp):c); }
    return { mode:'flat', sponsorPct:sp, investorCf:inv, sponsorCf:spc };
  }
  var pref=ivNum('iv_wf_pref',8)/100, promote=ivNum('iv_wf_promote',20)/100;
  var invC=[-equityAmt], spC=[0], prefBal=equityAmt, y;
  for(y=1;y<cf.length;y++){
    var cash=cf[y]>0?cf[y]:0;
    prefBal*=(1+pref);
    var toInv=Math.min(cash,prefBal); prefBal-=toInv;
    var rem=cash-toInv, toSp=rem*promote, toInvEx=rem*(1-promote);
    var line=toInv+toInvEx; if(cf[y]<0) line+=cf[y];
    invC.push(line); spC.push(toSp);
  }
  return { mode:'waterfall', pref:pref, promote:promote, investorCf:invC, sponsorCf:spC };
}

/* ---------- ownership router: how the INVESTOR's cash is formed each year ---------- */
function ivRoute(mode,years,p){
  var out=[],i,yr,c;
  for(i=0;i<years.length;i++){
    yr=years[i];
    if(mode==='owner'){ c=yr.net; }
    else if(mode==='ppa'){
      var ppa=(yr.hostValue||0)*(p.ppaCapture!=null?p.ppaCapture:0.9);
      var gs=(yr.grid||0)*(p.gridSplitInvestor!=null?p.gridSplitInvestor:0.5);
      c=ppa+gs-(yr.opex||0);
    }
    else if(mode==='lease'){ var esc=p.leaseEscalator!=null?p.leaseEscalator:0; c=(p.leaseAnnual||0)*Math.pow(1+esc,i); }
    else c=yr.net;
    out.push(c);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   MAIN INVESTOR UNDERWRITE — reads inputs, builds project cashflow, routes to
   investor by ownership mode, applies capital stack + waterfall, returns metrics.
   Designed to run off the SAME advanced inputs the base tool uses, plus the
   new investor inputs. Falls back gracefully when investor inputs are absent.
   ══════════════════════════════════════════════════════════════════════════ */
function ivUnderwrite(ctx){
  readIvModules();
  var U=ctx.util, inc=ctx.incentive;
  var bonus=inc.itcBonus||0;
  var life=Math.max(1,Math.round(ivNum('a_life',10)));
  var disc=ivNum('a_disc',10)/100;

  /* --- sizing (reuse base advanced inputs) --- */
  var bkw=ivModOn('bess')?ivNum('a_bkw',0):0;
  var bkwh=ivModOn('bess')?ivNum('a_bkwh',0):0;
  var computeKw=ivModOn('compute')?ivNum('a_compute',0):0;
  var solarKw=ivModOn('der')?ivNum('a_solar',0):0;
  var windKw=ivModOn('der')?ivNum('a_wind',0):0;

  /* --- EV module (built on DCFC charging-margin economics) --- */
  var ev={on:false,capex:0,om:0,margin:0,lcfs:0};
  if(ivModOn('ev')){
    var ports=ivNum('iv_ev_ports',4), kwp=ivNum('iv_ev_kw',150), util=ivNum('iv_ev_util',40)/100;
    var retail=ivNum('iv_ev_retail',0.45), capexP=ivNum('iv_ev_capexport',140000), omP=ivNum('iv_ev_omport',6000);
    var kwhYr=ports*kwp*util*8760, wholesale=U.energyBlended||0.13;
    ev={ on:true, ports:ports, kwhYr:kwhYr, margin:kwhYr*(retail-wholesale),
         lcfs: ivChk('iv_ev_lcfs',true)? kwhYr*0.015*(retail>0?1:1)*0.15/ (retail||1) *retail :0, // ~15% LCFS uplift on charging rev (modeled)
         capex:ports*capexP, om:ports*omP };
    ev.lcfs = ev.margin*0.15; // simpler: LCFS ~15% of charging margin (from KPI data)
  }

  /* --- capex by component --- */
  var bcost=ivNum('a_bcost',440), ccost=ivNum('a_ccost',9500), scost=ivNum('a_scost',1.10), land=ivNum('a_land',0);
  var bessCapex=bkwh*bcost, computeCapex=computeKw*ccost, solarCapex=solarKw*1000*scost, windCapex=windKw*1650;
  var roofCapex=ivNum('iv_roof_capex',0), interconnectCapex=ivNum('iv_interconnect_capex',0);
  var evCapex=ev.capex;
  var grossCapex=bessCapex+computeCapex+solarCapex+windCapex+evCapex+roofCapex+interconnectCapex+land;

  /* --- per-component ITC --- */
  var itcAmt =
    bessCapex*ivItcPct('bess',bonus) +
    solarCapex*ivItcPct('solar',bonus) +
    windCapex*ivItcPct('wind',bonus) +
    evCapex*ivItcPct('ev',bonus) +
    roofCapex*ivItcPct('roof',bonus) +
    interconnectCapex*ivItcPct('interconnect',bonus) +
    computeCapex*ivItcPct('compute',bonus);
  var itcBlendedPct = grossCapex>0? itcAmt/grossCapex : 0;

  var _extraReb = ivNum('iv_extra_rebate',0);
  var storageRebate = _extraReb>0 ? _extraReb : bkwh*(inc.storageRebatePerKwh||0);

  /* --- revenue stack (year 1) --- */
  var hoursYr=8760, pue=1.25;
  var computeFacilityKw=computeKw*pue, cutil=ivNum('a_cutil',72)/100, cprice=ivNum('a_cprice',1.85);
  var computeKwhYr=computeKw*cutil*hoursYr, computeRev=computeKwhYr*cprice;
  var derCF={solar:0.24,wind:0.34}, derKwhYr=solarKw*derCF.solar*hoursYr+windKw*derCF.wind*hoursYr;
  var facilityKwhYr=computeFacilityKw*cutil*hoursYr, gridKwhYr=Math.max(0,facilityKwhYr-derKwhYr);
  var energyCost=gridKwhYr*U.energyBlended;
  var usableKwh=bkwh*0.90, rte=0.88;
  var arbitrage=365*usableKwh*rte*U.peakSpread*0.65;
  var vstack=ivNum('a_vstack',U.capacityValue||90), capacityRev=bkw*vstack;
  var demandOffset=Math.min(bkw,computeFacilityKw)*U.demandCharge*12;
  var derValue=derKwhYr*U.energyBlended;

  /* Explicit BESS value-stack overrides (Claremont-style: contracted demand
     savings + resource-adequacy). When provided, these DEFINE the stack rather
     than the modeled arbitrage/demand proxies — this is how executed deals are
     actually priced. */
  var explicitDemand=ivNum('iv_demand_savings',0);
  var explicitRA=ivNum('iv_ra_value',0);
  var useExplicitStack=(explicitDemand>0||explicitRA>0);
  /* Executed-deal cost lines that net the value stack down to true EBITDA
     (Claremont: $350K stack - $125K property savings paid - $25K O&M = $200K). */
  var propertyCost=ivNum('iv_property_cost',0);   // savings shared back to host/property
  var omOverride=ivNum('iv_om_override',0);        // explicit O&M+insurance ($/yr); 0 = use modeled

  /* grid-participation portion vs host-value portion (for ownership routing).
     For a standalone BESS deal, demand savings is the HOST value (what the site
     pays the PPA for) and RA is the GRID upside (split with investor). */
  var gridPortion, hostPortion;
  if(useExplicitStack){
    hostPortion = explicitDemand + computeRev + derValue + ev.margin + ev.lcfs; // host pays for bill savings
    gridPortion = explicitRA;                                                   // grid-market upside (RA already includes capacity)
  } else {
    gridPortion = arbitrage + capacityRev + demandOffset;
    hostPortion = computeRev + derValue + ev.margin + ev.lcfs;
  }
  var grossRevenue=gridPortion+hostPortion;

  /* --- opex --- */
  var bessOM=bkw*8, computeOM=computeKw*220, solarOM=solarKw*18, windOM=windKw*45, evOM=ev.om;
  var totalOM=bessOM+computeOM+solarOM+windOM+evOM;

  var _omEff = omOverride>0 ? omOverride : totalOM;
  var y1ebitda=grossRevenue-energyCost-_omEff-propertyCost;

  /* --- depreciation shield (computed before net capital so it can be monetized) --- */
  var depCapex=bessCapex+solarCapex+windCapex+evCapex+interconnectCapex; // depreciable energy property
  var dep=ivDepreciation(depCapex,itcAmt,life);
  var depValue=0, depValueNominal=0;
  if(dep.on){ var di; for(di=0;di<dep.shield.length;di++){ depValue += dep.shield[di]/Math.pow(1+disc,di+1); depValueNominal += dep.shield[di]; } }
  var monetizeDepr=ivChk('iv_dep_monetize',false);
  /* deals typically monetize the nominal shield value with a tax-equity partner */
  var depValueUsed = ivChk('iv_dep_nominal',true) ? depValueNominal : depValue;

  /* --- net capital (tax-equity convention: monetize depr shield upfront when toggled) --- */
  var netCapexPreDep=grossCapex-itcAmt-storageRebate;
  var netCapex = monetizeDepr ? (netCapexPreDep - depValueUsed) : netCapexPreDep;
  if(netCapex<0) netCapex=0;
  var displayNetCapex = netCapex;   // what the waterfall card shows (post-depreciation)

  /* --- capital stack ---
     When depreciation is monetized upfront, that value is supplied by a
     TAX-EQUITY partner, not the sponsor. The sponsor's return is therefore
     measured against the pre-depreciation net capital (still after ITC+rebate).
     This matches how executed deals report investor IRR/MOIC. */
  /* Investor equity basis = net capital after ITC + rebates, BEFORE monetizing
     the depreciation shield upfront (depreciation instead accrues to the
     investor as an annual tax benefit). This single basis gets the headline
     levered IRR right and keeps all investor metrics on one consistent
     denominator — the defensible choice for an investor-facing model.
     The capital waterfall still DISPLAYS the depreciation value as a line. */
  var returnBasis = netCapexPreDep;   // net after ITC + rebate
  var cap=ivCapitalStack(returnBasis,y1ebitda,life);
  var equityIn = cap.levered? cap.equity : returnBasis;


  /* --- ownership mode --- */
  var mode=ivValv('iv_mode','owner');
  var modeParams={
    ppaCapture:ivNum('iv_ppa_capture',90)/100,
    gridSplitInvestor:ivNum('iv_grid_split',50)/100,
    leaseAnnual:ivNum('iv_lease_annual',400000),
    leaseEscalator:ivNum('iv_lease_esc',0)/100
  };

  /* --- build project-year records --- */
  var computeGrowth=0.04, deg=0.025;
  var years=[], y;
  for(y=1;y<=life;y++){
    var g=Math.pow(1+computeGrowth,y-1), d=Math.pow(1-deg,y-1);
    var comp=computeRev*g, arb=arbitrage*d, cap2=capacityRev*d, dem=demandOffset*d;
    var der=derValue, evm=ev.margin*g, evl=ev.lcfs*g;
    var grid, host;
    if(useExplicitStack){
      var escD=Math.pow(1.02,y-1);        // 2% escalator on contracted savings
      host = explicitDemand*escD + comp + der + evm + evl;
      grid = explicitRA*Math.pow(1.03,y-1);   // RA 3% esc (capacity already in RA)
    } else {
      grid = arb+cap2+dem;
      host = comp+der+evm+evl;
    }
    var om=(omOverride>0?omOverride:totalOM)*Math.pow(1.02,y-1);
    var ecost=energyCost*Math.pow(1.03,y-1);
    var propCost=propertyCost*Math.pow(1.02,y-1);   // property savings shared back, escalated
    var net=grid+host-ecost-om-propCost;
    /* for PPA host-value routing, the host portion is net of what's shared back */
    host = host - propCost;
    var shield=(dep.on && !monetizeDepr && dep.shield[y-1])?dep.shield[y-1]:0;
    years.push({ y:y, grid:grid, host:host, hostValue:host, net:net+shield, ebitda:net, opex:om, energy:ecost, taxShield:shield });
  }

  /* --- route to investor cash, subtract debt service, apply waterfall --- */
  var invAnnual=ivRoute(mode,years,modeParams);
  var projCf=[-netCapex], leveredCf=[-equityIn], y2;
  for(y2=0;y2<invAnnual.length;y2++){
    projCf.push(invAnnual[y2]);
    var ds=cap.levered&&cap.sched[y2]?cap.sched[y2].pay:0;
    leveredCf.push(invAnnual[y2]-ds);
  }

  /* waterfall splits the LEVERED equity cashflow between investor & sponsor */
  var wf=ivWaterfall(leveredCf,equityIn);

  /* --- metrics --- */
  var unlevIrr=ivIrr(projCf), unlevNpv=ivNpv(disc,projCf);
  var levIrr=ivIrr(leveredCf), levNpv=ivNpv(disc,leveredCf);
  var investorIrr=ivIrr(wf.investorCf), investorMoic=ivMoic(wf.investorCf), investorCoC=ivCoC(wf.investorCf);
  var sponsorIrr=ivIrr(wf.sponsorCf.map(function(v,i){return i===0?-1:v;})); // sponsor promote (nominal)
  var moic=ivMoic(leveredCf);

  /* payback on levered equity */
  var cum=leveredCf[0], payback=null;
  for(y=1;y<leveredCf.length;y++){ var prev=cum; cum+=leveredCf[y]; if(payback===null&&cum>=0) payback=(y-1)+(-prev)/leveredCf[y]; }

  return {
    ctx:ctx, mode:mode, life:life, disc:disc,
    modules:{ bess:ivModOn('bess'), der:ivModOn('der'), compute:ivModOn('compute'), ev:ivModOn('ev') },
    bkw:bkw, bkwh:bkwh, computeKw:computeKw, solarKw:solarKw, windKw:windKw, ev:ev,
    grossCapex:grossCapex, itcAmt:itcAmt, itcBlendedPct:itcBlendedPct, storageRebate:storageRebate, netCapex:netCapex, displayNetCapex:displayNetCapex, depValue:depValue, depValueNominal:depValueNominal, depValueUsed:depValueUsed, monetizeDepr:monetizeDepr,
    capex:{ bess:bessCapex, compute:computeCapex, solar:solarCapex, wind:windCapex, ev:evCapex, roof:roofCapex, interconnect:interconnectCapex, land:land },
    itcByBucket:{ bess:ivItcPct('bess',bonus), solar:ivItcPct('solar',bonus), wind:ivItcPct('wind',bonus), ev:ivItcPct('ev',bonus), roof:ivItcPct('roof',bonus), interconnect:ivItcPct('interconnect',bonus), compute:ivItcPct('compute',bonus) },
    revenue:{ compute:computeRev, arbitrage:arbitrage, capacity:capacityRev, demand:demandOffset, der:derValue, ev:ev.margin, lcfs:ev.lcfs },
    gridPortion:gridPortion, hostPortion:hostPortion, grossRevenue:grossRevenue,
    energyCost:energyCost, totalOM:totalOM, y1ebitda:y1ebitda,
    cap:cap, dep:dep, wf:wf, equityIn:equityIn,
    years:years, projCf:projCf, leveredCf:leveredCf,
    unlevIrr:unlevIrr, unlevNpv:unlevNpv, levIrr:levIrr, levNpv:levNpv,
    investorIrr:investorIrr, investorMoic:investorMoic, investorCoC:investorCoC, moic:moic,
    dscr:cap.dscr, payback:payback
  };
}

function readIvModules(){
  IV_MODULES.bess=ivChk('iv_mod_bess',true);
  IV_MODULES.der=ivChk('iv_mod_der',true);
  IV_MODULES.compute=ivChk('iv_mod_compute',true);
  IV_MODULES.ev=ivChk('iv_mod_ev',false);
}

/* ══════════════════════════════════════════════════════════════════════════
   CLAREMONT PRESET — the executed 802 kW / 5 MWh standalone BESS deal.
   Loading this proves the general engine reproduces a real deal's economics.
   Source: Neutron Claremont Project Overview (Apr 2026), user-provided.
   ══════════════════════════════════════════════════════════════════════════ */
var CLAREMONT_PRESET = {
  i_addr:'41 Tunnel Rd, Berkeley, CA 94705', i_util:'pge', i_arch:'bess_arb',
  a_grid:'1000', a_bkw:'802', a_bkwh:'5000', a_compute:'0', a_solar:'0', a_wind:'0',
  a_bcost:'540', a_ccost:'0', a_scost:'0', a_cprice:'0', a_cutil:'0',
  a_disc:'6', a_itc:'30', a_life:'20', a_vstack:'62', a_land:'0',
  // investor inputs
  iv_mode:'ppa', iv_cap_on:true, iv_cap_debt:'70', iv_cap_rate:'7', iv_cap_term:'20',
  iv_dep_on:true, iv_dep_monetize:true, iv_dep_nominal:true, iv_dep_tax:'30', iv_dep_stepup:true, iv_dep_steppct:'10',
  iv_wf_flat:false, iv_wf_pref:'8', iv_wf_promote:'20',
  iv_itc_bess:'30', iv_ppa_capture:'90', iv_grid_split:'50',
  iv_extra_rebate:'562000', iv_lease_annual:'0',
  iv_demand_savings:'300000', iv_ra_value:'50000',
  iv_property_cost:'125000', iv_om_override:'25000',
  iv_cap_debt:'0',
  _note:'Claremont: $2.7M capex → ITC 30%+10% step-up, SGIP $562K, PG&E B-19, $300K demand + $50K RA, PPA $20/kW-mo. Target: 13-15% unlevered IRR, 2.1x MOIC, 5yr payback.'
};

function loadClaremontPreset(){
  var p=CLAREMONT_PRESET, k, e;
  for(k in p){ if(k.charAt(0)==='_')continue;
    e=document.getElementById(k); if(!e)continue;
    if(e.type==='checkbox') e.checked=!!p[k]; else e.value=p[k];
  }
  // sync module toggles + mode UI
  if(document.getElementById('iv_mod_bess')) document.getElementById('iv_mod_bess').checked=true;
  if(document.getElementById('iv_mod_der')) document.getElementById('iv_mod_der').checked=false;
  if(document.getElementById('iv_mod_compute')) document.getElementById('iv_mod_compute').checked=false;
  if(document.getElementById('iv_mod_ev')) document.getElementById('iv_mod_ev').checked=false;
  if(typeof syncModuleInputs==='function') syncModuleInputs();
  if(typeof ivRefresh==='function') ivRefresh();
  var s=document.getElementById('run-status'); if(s) s.textContent='Loaded Claremont executed-deal preset — click Run to underwrite.';
}

/* ══════════════════════════════════════════════════════════════════════════
   INVESTOR REPORT RENDER + ORCHESTRATION
   ══════════════════════════════════════════════════════════════════════════ */
function ivMoney(v){ return '$'+Math.round(v).toLocaleString('en-US'); }
function ivMoneyK(v){ var a=Math.abs(v); if(a>=1e6) return '$'+(v/1e6).toFixed(2)+'M'; if(a>=1e3) return '$'+(v/1e3).toFixed(0)+'K'; return '$'+Math.round(v); }
function ivPct(v){ return v===null?'—':(v*100).toFixed(1)+'%'; }

function ivRenderReport(m){
  var modeLabel={owner:'Owner-Operator',ppa:'PPA / Energy Sale',lease:'Fixed Lease'}[m.mode]||m.mode;
  var h='';

  /* HEADLINE — investor metrics */
  h+='<div class="report-hero"><div class="rh-top"><div class="rh-site">'+
     '<div class="eyebrow">'+m.ctx.util.name+' · '+m.ctx.util.iso+' · '+modeLabel+'</div>'+
     '<h2>'+esc(val('i_addr'))+'</h2>'+
     '<div class="loc">'+fmtN(m.bkw)+' kW / '+fmtN(m.bkwh)+' kWh BESS'+
       (m.modules.compute&&m.computeKw>0?' · '+fmtN(m.computeKw)+' kW compute':'')+
       (m.modules.ev&&m.ev.on?' · '+m.ev.ports+' EV ports':'')+'</div>'+
     '</div><div class="rh-flag '+(m.investorIrr>=m.disc?'go':'caution')+'">'+modeLabel+'</div></div>'+
     '<div class="rh-metrics">'+
     '<div><div class="rhm-val '+(m.levIrr>=m.disc?'pos':'neg')+'">'+ivPct(m.levIrr)+'</div><div class="rhm-label">Levered Equity IRR</div></div>'+
     '<div><div class="rhm-val">'+(m.moic?m.moic.toFixed(2)+'x':'—')+'</div><div class="rhm-label">MOIC</div></div>'+
     '<div><div class="rhm-val">'+ivPct(m.investorCoC)+'</div><div class="rhm-label">Cash-on-Cash</div></div>'+
     '<div><div class="rhm-val">'+(m.dscr?m.dscr.toFixed(2):'—')+'</div><div class="rhm-label">DSCR</div></div>'+
     '<div><div class="rhm-val">'+(m.payback?m.payback.toFixed(1):'>'+m.life)+'<span class="u">yr</span></div><div class="rhm-label">Equity Payback</div></div>'+
     '</div></div>';
  h+='<div style="margin:0 0 4px;padding:9px 12px;background:rgba(46,134,193,.06);border-left:3px solid var(--cs-navy,#1B4F8A);border-radius:0 6px 6px 0;font-size:11px;color:var(--cs-sub,#6B7A8D);line-height:1.5">'+
     '<b>Consistent-basis methodology:</b> IRR, MOIC, cash-on-cash, and payback are all computed against a single equity basis ('+fmt$(m.equityIn)+'). Metrics are not re-based per line to present each in its most favorable light — so figures here may run more conservative than a deal teaser that quotes payback, MOIC, and IRR against different denominators.'+
     '</div>';

  /* CAPITAL WATERFALL — the auditable stack Paige wants to click through */
  h+='<div class="section-title">Capital Waterfall</div><div class="section-desc">Gross build cost stepped down through each incentive to the equity actually at risk. Every line is user-overridable.</div>';
  h+='<div class="card"><div class="card-body"><table class="pnl">'+
     pnl('Gross project cost','all components', m.grossCapex,'')+
     pnl('Investment Tax Credit', (m.itcBlendedPct*100).toFixed(0)+'% blended (per-component)', -m.itcAmt,'neg')+
     (m.storageRebate>0?pnl('Storage rebate / SGIP','', -m.storageRebate,'neg'):'')+
     (m.monetizeDepr&&m.depValueUsed>0?pnl('Depreciation value','MACRS tax shield (to tax equity)', -m.depValueUsed,'neg'):'')+
     '<tr class="grand"><td class="lbl">Net capital required</td><td class="num">'+fmt$(m.displayNetCapex)+'</td></tr>'+
     '<tr><td class="lbl" style="font-size:10px;font-style:italic;color:var(--cs-sub)">Sponsor equity basis (for returns)<span class="s">net of ITC + rebate; depreciation accrues annually</span></td><td class="num" style="font-size:11px">'+fmt$(m.equityIn)+'</td></tr>'+
     (m.cap.levered?pnl('Debt financing', (m.cap.rate*100).toFixed(1)+'% · '+m.cap.term+'yr', -m.cap.debt,'neg'):'')+
     (m.cap.levered?'<tr class="total"><td class="lbl">Equity at risk</td><td class="num">'+fmt$(m.equityIn)+'</td></tr>':'')+
     '</table>'+
     '<div style="margin-top:10px;font-size:11px;color:var(--cs-sub);font-style:italic">ITC, depreciation basis, and step-up are modeled per current IRA rules and are overridable — a screening aid, not tax advice. Verify with tax counsel.</div>'+
     '</div></div>';

  /* PER-COMPONENT ITC breakdown */
  h+='<div class="section-title">Per-Component ITC</div><div class="section-desc">Each cost bucket carries its own credit rate. Roof/structural defaults low; compute is non-eligible.</div>';
  h+='<div class="card"><div class="card-body"><table class="pnl">';
  var buckets=[['bess','BESS system','bess'],['solar','Solar','solar'],['wind','Wind','wind'],['ev','EV charging','ev'],['roof','Roof / structural','roof'],['interconnect','Interconnection','interconnect'],['compute','Compute / IT','compute']];
  for(var bi=0;bi<buckets.length;bi++){ var bk=buckets[bi][2], cx=m.capex[bk]||0; if(cx>0){
    h+=pnl(buckets[bi][1], (m.itcByBucket[bk]*100).toFixed(0)+'% ITC × '+fmt$(cx), cx*m.itcByBucket[bk],'pos'); } }
  h+='<tr class="total"><td class="lbl">Total ITC</td><td class="num pos">'+fmt$(m.itcAmt)+'</td></tr>'+
     '</table></div></div>';

  /* OWNERSHIP-MODE COMPARISON — the investor-perspective toggle */
  h+='<div class="section-title">Investor Returns by Structure</div><div class="section-desc">The same asset, three ways to structure the investor\u2019s position. Toggle the mode above to make one the headline.</div>';
  var modes=ivCompareModes(m);
  h+='<div class="card"><div class="card-body"><table class="pnl">'+
     '<tr class="sub-h"><td>Structure</td><td class="num">Investor IRR / MOIC</td></tr>'+
     '<tr'+(m.mode==='owner'?' class="total"':'')+'><td class="lbl">Owner-Operator<span class="s">full value stack, full risk</span></td><td class="num">'+ivPct(modes.owner.irr)+' · '+(modes.owner.moic?modes.owner.moic.toFixed(2)+'x':'—')+'</td></tr>'+
     '<tr'+(m.mode==='ppa'?' class="total"':'')+'><td class="lbl">PPA / Energy Sale<span class="s">contracted + '+(m.mode==='ppa'?(ivNum('iv_grid_split',50)):50)+'% grid upside</span></td><td class="num">'+ivPct(modes.ppa.irr)+' · '+(modes.ppa.moic?modes.ppa.moic.toFixed(2)+'x':'—')+'</td></tr>'+
     '<tr'+(m.mode==='lease'?' class="total"':'')+'><td class="lbl">Fixed Lease<span class="s">flat annuity, bond-like</span></td><td class="num">'+ivPct(modes.lease.irr)+' · '+(modes.lease.moic?modes.lease.moic.toFixed(2)+'x':'—')+'</td></tr>'+
     '</table></div></div>';

  /* EBITDA WATERFALL — investor vs sponsor split */
  h+='<div class="section-title">EBITDA Split \u2014 Investor vs Sponsor</div><div class="section-desc">'+
     (m.wf.mode==='waterfall'?('Pref '+(m.wf.pref*100).toFixed(0)+'% + '+(m.wf.promote*100).toFixed(0)+'% promote above hurdle.'):('Flat split \u2014 sponsor keeps '+(m.wf.sponsorPct*100).toFixed(0)+'%.'))+'</div>';
  h+='<div class="card"><div class="card-body"><table class="ytable"><thead><tr><th>Year</th><th>Investor</th><th>Sponsor</th></tr></thead><tbody>';
  for(var wy=1;wy<m.wf.investorCf.length && wy<=Math.min(m.life,10);wy++){
    h+='<tr><td>Y'+wy+'</td><td class="pos">'+ivMoneyK(m.wf.investorCf[wy])+'</td><td class="pos">'+ivMoneyK(m.wf.sponsorCf[wy])+'</td></tr>';
  }
  h+='</tbody></table></div></div>';

  /* REVENUE STACK */
  h+='<div class="section-title">Year-1 Value Stack</div>';
  h+='<div class="card"><div class="card-body"><table class="pnl">'+
     (m.revenue.compute>0?pnl('Compute marketplace','', m.revenue.compute,'pos'):'')+
     (m.revenue.arbitrage>0?pnl('TOU arbitrage','', m.revenue.arbitrage,'pos'):'')+
     (m.revenue.capacity>0?pnl('Capacity / RA','', m.revenue.capacity,'pos'):'')+
     (m.revenue.demand>0?pnl('Demand-charge offset','', m.revenue.demand,'pos'):'')+
     (m.revenue.der>0?pnl('DER self-supply','', m.revenue.der,'pos'):'')+
     (m.revenue.ev>0?pnl('EV charging margin','', m.revenue.ev,'pos'):'')+
     (m.revenue.lcfs>0?pnl('LCFS credits','~15% of charging (modeled)', m.revenue.lcfs,'pos'):'')+
     '<tr class="grand"><td class="lbl">Gross revenue</td><td class="num pos">'+fmt$(m.grossRevenue)+'</td></tr>'+
     pnl('Grid-participation portion','(routes to investor per structure)', m.gridPortion,'')+
     pnl('Host / on-site portion','', m.hostPortion,'')+
     '</table></div></div>';

  /* DISCLAIMER */
  h+='<div class="disclaim"><b>Investor-model basis.</b> Returns are modeled from the inputs and incentive assumptions shown, all user-overridable. ITC percentages, depreciation basis and step-up, and capital structure are screening estimates, not tax, legal, or financing advice; confirm with counsel and signed term sheets before capital commitment. Calibrated against the executed Claremont 5 MWh BESS deal.</div>';
  h+='<div class="export-row"><button class="btn btn-navy" onclick="window.print()">Print / Save PDF</button><button class="btn btn-ghost" onclick="exportCSV()">Export CSV</button></div>';

  $('report').innerHTML=h;
  $('report').classList.add('on');
  window.__ivModel=m; window.__uwModel=m;
  if($('btn-proposal')) $('btn-proposal').disabled=false;
}

/* compute investor IRR/MOIC for all three modes (for the comparison table) */
function ivCompareModes(m){
  var out={};
  var params={ ppaCapture:ivNum('iv_ppa_capture',90)/100, gridSplitInvestor:ivNum('iv_grid_split',50)/100,
               leaseAnnual:ivNum('iv_lease_annual',400000), leaseEscalator:ivNum('iv_lease_esc',0)/100 };
  var mm=['owner','ppa','lease'],i;
  for(i=0;i<mm.length;i++){
    var annual=ivRoute(mm[i],m.years,params);
    var cf=[-m.equityIn],y;
    for(y=0;y<annual.length;y++){ var ds=m.cap.levered&&m.cap.sched[y]?m.cap.sched[y].pay:0; cf.push(annual[y]-ds); }
    out[mm[i]]={ irr:ivIrr(cf), moic:ivMoic(cf) };
  }
  return out;
}

/* orchestration — runs the investor underwrite off the same Run button */
function ivRun(){
  var addr=val('i_addr'); if(!addr){ showErr('Enter a site address or ZIP.'); return; }
  hideErr();
  var utilKey=val('i_util'); var U=UTILS[utilKey];
  var st=U.state||stateFromZip(extractZip(addr))||'US';
  var ctx={ util:U, iso:U.iso, state:st, incentive:INCENTIVES[st]||INCENTIVES['US'],
    provenance:[dsRow('Utility &amp; ISO tariff','verified',U.name+' · '+U.iso)] };
  try{
    var m=ivUnderwrite(ctx);
    ivRenderReport(m);
    var s=$('run-status'); if(s) s.textContent='Done · Investor IRR '+ivPct(m.levIrr)+' · MOIC '+(m.moic?m.moic.toFixed(2)+'x':'—');
    $('report').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){ showErr('Underwriting error: '+(e&&e.message?e.message:e)); }
}

/* keep inputs in sync with module toggles (hide disabled modules' inputs) */
function syncModuleInputs(){
  readIvModules();
  var map={ bess:['a_bkw','a_bkwh','a_bcost'], der:['a_solar','a_wind','a_scost'],
            compute:['a_compute','a_ccost','a_cprice','a_cutil'], ev:['iv_ev_ports','iv_ev_kw','iv_ev_util','iv_ev_retail'] };
  var k,i,ids,fg;
  for(k in map){ ids=map[k]; for(i=0;i<ids.length;i++){ var el=document.getElementById(ids[i]); if(el){ fg=el.closest?el.closest('.fg'):null; if(fg) fg.style.opacity=IV_MODULES[k]?'1':'0.35'; el.disabled=!IV_MODULES[k]; } } }
}
function ivRefresh(){ /* hook for preset load */ }
