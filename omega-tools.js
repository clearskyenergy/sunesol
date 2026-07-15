/* ══════════════════════════════════════════════════════════════════════
   CLEARSKY-OMEGA · TOOL REGISTRY  (omega-tools.js)
   ----------------------------------------------------------------------
   ONE source of truth for every tool/app in the platform. Both the ADMIN
   console and every CUSTOMER portal load this same file, so a tool you add
   here shows up everywhere automatically — no per-portal HTML edits.

   HOW IT FITS THE ARCHITECTURE (locked conventions):
     • ES5 only — no arrow fns, template literals, let/const, optional chaining.
     • Single-file HTML tools live in ONE deploy (clearsky-omega repo). Every
       tenant loads the SAME tool file; Firestore scoping by orgId keeps each
       tenant's saved data separate. Tools are NOT one-repo-each.
     • This registry is the METADATA index only. It seeds from SEED_TOOLS and,
       when Firestore is present, hydrates/overrides from collection 'tools'.
       The admin "Import / Update Applications" button writes SEED_TOOLS ->
       Firestore so customer portals pick up new tools live.

   SAVED-DATA CONTRACT (so tools reopen with state):
     • Every tool has a stable `key` (e.g. 'valuestack'). Tools read & write
       their saved state to Firestore at:
           toolData / {orgId} / tools / {key}
       (per-tenant, per-tool document). Helpers OMEGATools.loadToolData /
       saveToolData below implement exactly this. Drop them into any tool.

   TIER / UNLOCK MODEL:
     • tier: minimum account tier that sees the tool unlocked.
         1 = Standard, 2 = Deluxe/Professional, 3 = Enterprise, 0 = everyone.
     • A tenant may also carry unlockedTools:[keys] to unlock specific tools
       above their tier (see WORKSPACES in the portal). Locked tools still
       render but with an upgrade overlay.

   ENTERPRISE CUSTOM EDITORS:
     • A tool entry may set custom:true. For those, the portal looks up the
       tenant's customEditorUrl / customToolUrls[key] and uses THAT href
       (their own repo's deployment) instead of the shared file. If the tenant
       has no override, the shared href is used.
   ══════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* ── Tier constants (readable) ── */
  var TIER = { ALL: 0, STANDARD: 1, DELUXE: 2, ENTERPRISE: 3 };

  /* ── Categories drive the section grouping in the marketplace grid ── */
  var CATEGORIES = [
    { key: 'design',      label: 'Design & Engineering' },
    { key: 'finance',     label: 'Finance & Modeling' },
    { key: 'sales',       label: 'Sales & Proposals' },
    { key: 'permitting',  label: 'Permitting & AHJ' },
    { key: 'marketplace', label: 'Marketplace & Partners' }
  ];

  /* ══════════════════════════════════════════════════════════════════
     SEED_TOOLS — the master catalog. Add a tool here, click "Import /
     Update Applications" in the admin console, and every portal updates.

     Fields:
       key        stable id (also the saved-data doc id). REQUIRED, unique.
       name       display name.
       desc       one-line description (end-user voice).
       category   one of CATEGORIES[].key.
       file       shared deployment path (e.g. '/valuestack.html').
       action     optional: 'new:bess' | 'new:sandbox' — opens project modal
                  instead of navigating to a file.
       icon       single SVG path 'd' string (stroke, 24x24 viewBox).
       tier       min tier to unlock (TIER.*). Default STANDARD.
       badge      optional 'new' | 'invest' | free text.
       soon       true => renders disabled ("Soon"), non-clickable.
       custom     true => enterprise tenants may override href per-org.
       savesData  true => tool persists state via the toolData contract.
     ══════════════════════════════════════════════════════════════════ */
  var SEED_TOOLS = [
    { key:'editor', name:'BESS Site Map', category:'design',
      desc:'Wizard, conduit routing & equipment on live satellite.',
      action:'new:bess', tier:TIER.STANDARD, custom:true, savesData:true,
      icon:'M2 7h20v14H2zM16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16' },

    { key:'sandbox', name:'Open a Sandbox', category:'design',
      desc:'Full editor at any address — save when ready.',
      action:'new:sandbox', tier:TIER.STANDARD, savesData:true,
      icon:'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4M12 16h.01' },

    { key:'proforma', name:'BESS Pro Forma', category:'finance',
      desc:'IRR, NPV, value stack & incentives in 8 steps.',
      file:'/proforma.html', tier:TIER.STANDARD, savesData:true,
      icon:'M18 20V10M12 20V4M6 20v-6' },

    { key:'dcfc', name:'DCFC BESS Pro Forma', category:'finance',
      desc:'EV fast-charging + storage economics & demand offset.',
      file:'/dcfc-proforma.html', badge:'new', tier:TIER.DELUXE, savesData:true,
      icon:'M14 2v6h6M4 22V4a2 2 0 0 1 2-2h8l6 6v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM11 11l-2 4h3l-2 4' },

    { key:'apartment', name:'Residential BESS Analyzer', category:'finance',
      desc:'Multi-state apartment portfolio modeling & VPP stacking.',
      file:'/apartment-bess.html', tier:TIER.DELUXE, savesData:true,
      icon:'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10' },

    { key:'fleet', name:'3D Fleet Financial Modeler', category:'finance',
      desc:'3D fleet with 24-hr dispatch, hourly earnings & PDF reports.',
      file:'/fleet-simulator-3d.html', tier:TIER.DELUXE, savesData:true,
      icon:'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12' },

    { key:'valuestack', name:'Value Stack Calculator', category:'finance',
      desc:'Revenue streams by utility with customer/ClearSky split.',
      file:'/valuestack.html', tier:TIER.STANDARD, savesData:true,
      icon:'M18 20V10M12 20V4M6 20v-6M2 20h20' },

    { key:'investment', name:'Site Investment Analysis', category:'finance',
      desc:'Investor-grade returns, risk & portfolio underwriting.',
      file:'/investment-analysis.html', badge:'invest', tier:TIER.ENTERPRISE, savesData:true,
      icon:'M3 3v18h18M18 9l-5 5-3-3-4 4' },

    { key:'sales', name:'Sales Proposal Builder', category:'sales',
      desc:'3-page customer proposals with AI site placement.',
      file:'/sales-proposal.html', tier:TIER.STANDARD, savesData:true,
      icon:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8' },

    { key:'permit', name:'Permit Creator', category:'permitting',
      desc:'AHJ-ready sets — cover, plot plan, SLD, details.',
      file:'/permit.html', tier:TIER.DELUXE, savesData:true,
      icon:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8' },

    { key:'ahj', name:'AHJ Approval Portal', category:'marketplace',
      desc:'Submit & track permit approvals with the AHJ.',
      file:'/ahj-portal.html', soon:true, tier:TIER.ALL,
      icon:'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4' },

    { key:'procurement', name:'Procurement Marketplace', category:'marketplace',
      desc:'Market-wide equipment pricing & bankable products.',
      file:'/procurement.html', soon:true, tier:TIER.ALL,
      icon:'M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0' },

    { key:'financing', name:'Financing Partners', category:'marketplace',
      desc:'Debt, tax equity & capital partners for projects.',
      file:'https://financing.csebuilders.com/', tier:TIER.ALL,
      icon:'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5' },

    { key:'aggregators', name:'Aggregators', category:'marketplace',
      desc:'VPP / DR aggregator network & dispatch enrollment.',
      file:'/aggregators.html', soon:true, tier:TIER.ALL,
      icon:'M12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 2v4M12 18v4M2 12h4M18 12h4' },

    { key:'offtakers', name:'AI Data Offtakers', category:'marketplace',
      desc:'Compute / data-center offtake & behind-the-meter load.',
      file:'/offtakers.html', soon:true, tier:TIER.ALL,
      icon:'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z' },

    /* ── CLIENT-SPECIFIC TOOLS ──
       `orgs:[...]` restricts a tool to specific tenants (by orgId). Only those
       orgs see it; it never appears for anyone else. Combine with a tenant's
       requiredTools list to make it a mandatory, non-removable dashboard tool. */
    { key:'spatco_ev', name:'EV / Project Estimate', category:'sales',
      desc:'SPATCO-format EV charger & project install estimates with AI scope.',
      file:'/spatco-ev-estimate.html', tier:TIER.ALL, orgs:['spatco.com'],
      icon:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h6M9 9h1' }
  ];

  /* ══════════════════════════════════════════════════════════════════
     REGISTRY OBJECT
     ══════════════════════════════════════════════════════════════════ */
  var OMEGATools = {
    TIER: TIER,
    CATEGORIES: CATEGORIES,
    SEED_TOOLS: SEED_TOOLS,
    _tools: SEED_TOOLS.slice(),   // active list; may be replaced by Firestore

    /* Get all tools (seed or hydrated). */
    all: function () { return this._tools.slice(); },

    byKey: function (key) {
      for (var i = 0; i < this._tools.length; i++) {
        if (this._tools[i].key === key) return this._tools[i];
      }
      return null;
    },

    /* ── TOOL HOST ──
       The ONE deployment that hosts every shared tool .html. All portals
       (admin + every client) link here, so a tool fix ships once. Set this
       to your tool-host origin. Leave '' to use same-origin relative paths
       (Option A / the admin console itself, which is same-repo as the tools). */
    TOOL_HOST: 'https://tools.csebuilders.com',

    /* Resolve the full href a given tenant should use for a tool.
       - action tool          => null (caller opens the project modal instead).
       - enterprise override   => the tenant's own bespoke URL (used as-is).
       - otherwise             => TOOL_HOST + tool.file + ?org=<orgId>, so the
                                  shared tool loads and scopes its saved data
                                  to the right tenant.
       When TOOL_HOST is '' (admin console, same-origin), returns a relative
       path with no org param (admin acts as ClearSky's own org). */
    hrefFor: function (tool, workspace) {
      if (!tool) return null;
      if (tool.action) return null;

      // Enterprise bespoke override wins — used exactly as provided.
      if (tool.custom && workspace) {
        if (workspace.customToolUrls && workspace.customToolUrls[tool.key]) {
          return workspace.customToolUrls[tool.key];
        }
        if (tool.key === 'editor' && workspace.customEditorUrl) {
          return workspace.customEditorUrl;
        }
      }

      var path = tool.file || null;
      if (!path) return null;

      // Absolute URL (e.g. a standalone app on another subdomain) => use as-is,
      // no TOOL_HOST prefix and no ?org= param appended.
      if (/^https?:\/\//i.test(path)) return path;

      var host = this.TOOL_HOST || '';
      var base = host ? (host.replace(/\/+$/, '') + path) : path;

      // Append org scope so the shared tool knows whose data to load/save.
      if (workspace && workspace.orgId) {
        base += (base.indexOf('?') >= 0 ? '&' : '?') + 'org=' +
                encodeURIComponent(workspace.orgId);
      }
      return base;
    },

    /* Can this tenant even SEE the tool? Client-specific tools (tool.orgs)
       are visible only to the listed orgs. Everyone sees non-restricted tools. */
    isVisible: function (tool, workspace) {
      if (!tool.orgs || !tool.orgs.length) return true;        // not restricted
      if (!workspace || !workspace.orgId) return false;        // restricted, no org
      return tool.orgs.indexOf(workspace.orgId) >= 0;
    },

    /* Is a tool unlocked for a tenant? tier gate OR explicit unlock list.
       (Visibility is separate — an unlocked tool the tenant can't see is hidden.) */
    isUnlocked: function (tool, workspace) {
      if (!this.isVisible(tool, workspace)) return false;
      if (!workspace) return true;              // admin/internal sees all
      var tier = workspace.tierLevel;
      if (typeof tier !== 'number') tier = TIER.ENTERPRISE; // internal defaults open
      if (workspace.requiredTools &&
          workspace.requiredTools.indexOf(tool.key) >= 0) return true;
      if (workspace.unlockedTools &&
          workspace.unlockedTools.indexOf(tool.key) >= 0) return true;
      return tier >= (typeof tool.tier === 'number' ? tool.tier : TIER.STANDARD);
    },

    /* Is a tool MANDATORY for this tenant? (Always pinned, cannot be removed.) */
    isRequired: function (tool, workspace) {
      return !!(workspace && workspace.requiredTools &&
                workspace.requiredTools.indexOf(tool.key) >= 0);
    },

    /* ── Hydrate the active list from Firestore 'tools' (if available). ──
         Called once at portal boot. Falls back silently to SEED_TOOLS. */
    hydrate: function (db, cb) {
      var self = this;
      if (!db) { if (cb) cb(self._tools); return; }
      db.collection('tools').orderBy('sort').get().then(function (snap) {
        if (!snap.empty) {
          var list = [];
          snap.forEach(function (doc) { list.push(doc.data()); });
          self._tools = list;
        }
        if (cb) cb(self._tools);
      })['catch'](function () { if (cb) cb(self._tools); });
    },

    /* ── ADMIN: push SEED_TOOLS -> Firestore 'tools'. Idempotent upsert.
         This is what the "Import / Update Applications" button calls. It
         writes/updates one doc per tool (id = key) and stamps a sort index
         so portals render in a stable order. Returns a Promise. ── */
    publishToFirestore: function (db, firebase) {
      if (!db) return Promise.reject(new Error('No Firestore.'));
      var batch = db.batch();
      for (var i = 0; i < SEED_TOOLS.length; i++) {
        var t = SEED_TOOLS[i];
        var doc = {};
        for (var k in t) { if (t.hasOwnProperty(k)) doc[k] = t[k]; }
        doc.sort = i;
        doc.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
        batch.set(db.collection('tools').doc(t.key), doc, { merge: true });
      }
      return batch.commit();
    },

    /* ── SAVED DATA CONTRACT ──
         Drop these into any tool. They persist per-tenant, per-tool state
         at toolData/{orgId}/tools/{key} so the tool reopens with data. ── */
    loadToolData: function (db, orgId, key) {
      if (!db || !orgId || !key) return Promise.resolve(null);
      return db.collection('toolData').doc(orgId)
        .collection('tools').doc(key).get()
        .then(function (snap) { return snap.exists ? snap.data() : null; });
    },

    saveToolData: function (db, firebase, orgId, key, data) {
      if (!db || !orgId || !key) return Promise.reject(new Error('Missing scope.'));
      var payload = { data: data,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
      return db.collection('toolData').doc(orgId)
        .collection('tools').doc(key).set(payload, { merge: true });
    },

    /* ── Read the tenant org a shared tool was opened for ──
         Shared tools live on TOOL_HOST and receive ?org=<orgId> from the
         portal. A tool calls OMEGATools.orgFromUrl() to know whose data to
         load/save. Falls back to the signed-in user's email domain, then null.
         (A user can only read/write their own org per the Firestore rules, so
         the ?org= param is a convenience, not a trust boundary.) */
    orgFromUrl: function (fallbackEmail) {
      var m = (typeof window !== 'undefined' && window.location && window.location.search)
        ? window.location.search.match(/[?&]org=([^&]+)/) : null;
      if (m && m[1]) return decodeURIComponent(m[1]);
      if (fallbackEmail && fallbackEmail.indexOf('@') >= 0) {
        return fallbackEmail.split('@')[1].toLowerCase();
      }
      return null;
    },

    /* ══════════════════════════════════════════════════════════════════
       DASHBOARD PINS  —  the customer's chosen shortlist of tools.
       Marketplace = every tool their tier qualifies for (automatic).
       Dashboard   = only the keys the customer pinned (manual).
       Stored per-tenant at  toolData/{orgId}/prefs/pinned  as { keys:[...] }.
       Existing Firestore rules already scope this to the user's own org.
       ══════════════════════════════════════════════════════════════════ */

    /* Load the pinned tool keys for a tenant. Resolves to an array (never null). */
    loadPinned: function (db, orgId) {
      if (!db || !orgId) return Promise.resolve([]);
      return db.collection('toolData').doc(orgId)
        .collection('prefs').doc('pinned').get()
        .then(function (snap) {
          return (snap.exists && snap.data() && snap.data().keys) ? snap.data().keys : [];
        })['catch'](function () { return []; });
    },

    /* Overwrite the pinned list. */
    savePinned: function (db, firebase, orgId, keys) {
      if (!db || !orgId) return Promise.reject(new Error('Missing scope.'));
      return db.collection('toolData').doc(orgId)
        .collection('prefs').doc('pinned').set({
          keys: keys || [],
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    },

    /* Pin one tool (idempotent). Returns a Promise of the new keys array. */
    pinTool: function (db, firebase, orgId, key) {
      var self = this;
      return this.loadPinned(db, orgId).then(function (keys) {
        if (keys.indexOf(key) < 0) keys.push(key);
        return self.savePinned(db, firebase, orgId, keys).then(function () { return keys; });
      });
    },

    /* Unpin one tool. Returns a Promise of the new keys array. */
    unpinTool: function (db, firebase, orgId, key) {
      var self = this;
      return this.loadPinned(db, orgId).then(function (keys) {
        var out = [];
        for (var i = 0; i < keys.length; i++) { if (keys[i] !== key) out.push(keys[i]); }
        return self.savePinned(db, firebase, orgId, out).then(function () { return out; });
      });
    }
  };

  /* Expose globally (and as a CommonJS-ish export if ever bundled). */
  global.OMEGATools = OMEGATools;
  if (typeof module !== 'undefined' && module.exports) module.exports = OMEGATools;

})(typeof window !== 'undefined' ? window : this);
