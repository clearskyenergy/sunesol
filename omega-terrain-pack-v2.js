/* ══════════════════════════════════════════════════════════════════════════
   OMEGA TERRAIN + ELECTRICAL PACK  ·  v1.0
   ──────────────────────────────────────────────────────────────────────────
   Closes the gap between the terrain OMEGA already samples and the
   flat-ground layout engine that never reads it.

   Installs by wrapping existing globals. Nothing in the base file is
   edited; if a hook is missing the pack reports "unavailable" instead of
   throwing.

   ADDS
     1. Terrain field      interpolated ground elevation at any canvas pixel
     2. Slope screening    per-table N-S / E-W grade vs racking tolerance
     3. Terrain adaptation tables over tolerance are rejected, not drawn
     4. Pile schedule      reveal height per post, with grading flags
     5. Collision check    row-to-row interference once Z is real
     6. Shading            solstice profile angle -> min pitch / max GCR
     7. Stringing          strings, combiners, DC cable length from geometry
     8. Exports            pile CSV, string CSV, PVsyst geometry, Shapefile
     9. SHP import         polygons from GIS deliverables

   HONESTY NOTE, carried from the base file: the elevation source is a DEM
   (about 10 m posts via 3DEP, 30 m elsewhere), not a survey. Reveals and
   volumes off it are SCREENING numbers. Every sheet this pack produces
   stamps its own sample spacing so nothing gets mistaken for a stamped
   design.
   ══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var TAG = '[omega-terrain]';
  var VERSION = '2.0';

  /* ══════════════════════════════════════════════════════════════════
     0.  UTILITIES
     ══════════════════════════════════════════════════════════════════ */

  var FT_PER_M = 3.280839895;
  var FT_PER_DEG_LAT = 111320 * FT_PER_M;
  var D2R = Math.PI / 180, R2D = 180 / Math.PI;

  function num(v, d) { v = +v; return isFinite(v) ? v : d; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function ftPerDegLng(lat) { return FT_PER_DEG_LAT * Math.cos(lat * D2R); }

  function ppf() {
    try { if (typeof _derScale === 'function') return _derScale(); } catch (e) {}
    try { if (typeof S !== 'undefined' && S.pxPerFt > 0) return S.pxPerFt; } catch (e) {}
    return 6;
  }

  function say(msg, kind) {
    try { if (typeof showBanner === 'function') { showBanner(kind || 'cal', msg); return; } } catch (e) {}
    if (window.console) console.info(TAG + ' ' + msg);
  }

  function download(name, payload, mime) {
    try {
      var blob = (payload instanceof Blob) ? payload : new Blob([payload], { type: mime || 'text/plain' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 20000);
      return true;
    } catch (e) { say('Export failed: ' + (e && e.message)); return false; }
  }

  function projName() {
    try {
      var el = document.getElementById('pname');
      if (el && el.value) return el.value.replace(/[^\w\-]+/g, '_');
    } catch (e) {}
    return 'site';
  }

  function csvCell(v) {
    if (v == null) return '';
    var s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(rows) {
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  /* Least-squares affine fit  (x,y) -> v.  Cramer on the 3x3 normals, same
     approach the base file already uses for its best-fit plane. */
  function affineFit(pts, vals) {
    var n = pts.length;
    if (n < 3) return null;
    var Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sv = 0, Sxv = 0, Syv = 0;
    for (var i = 0; i < n; i++) {
      var p = pts[i], v = vals[i];
      Sx += p.x; Sy += p.y; Sv += v;
      Sxx += p.x * p.x; Syy += p.y * p.y; Sxy += p.x * p.y;
      Sxv += p.x * v; Syv += p.y * v;
    }
    var M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]];
    var V = [Sxv, Syv, Sv];
    function det3(m) {
      return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
           - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
           + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    }
    var D = det3(M);
    if (!isFinite(D) || Math.abs(D) < 1e-12) return null;
    function sub(c) {
      var m = [M[0].slice(), M[1].slice(), M[2].slice()];
      for (var i = 0; i < 3; i++) m[i][c] = V[i];
      return det3(m) / D;
    }
    return { a: sub(0), b: sub(1), c: sub(2) };
  }
  function affineEval(f, x, y) { return f.a * x + f.b * y + f.c; }

  function bboxOf(pts) {
    var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].x < b.minX) b.minX = pts[i].x;
      if (pts[i].y < b.minY) b.minY = pts[i].y;
      if (pts[i].x > b.maxX) b.maxX = pts[i].x;
      if (pts[i].y > b.maxY) b.maxY = pts[i].y;
    }
    b.w = b.maxX - b.minX; b.h = b.maxY - b.minY;
    return b;
  }

  /* ══════════════════════════════════════════════════════════════════
     1.  TERRAIN FIELD
     ──────────────────────────────────────────────────────────────────
     S.terrain.samples carry {lat,lng,zFt,x,y,inside} where x is feet EAST
     and y is feet NORTH of samples[0]. To ask "what is the ground doing
     under this table", canvas pixels have to reach that frame.

     Three projection routes, tried in order, because the map is not always
     reachable:

       geo   the shape carries _geoBoundary (lat/lng per boundary vertex).
             Fit an affine px->lat and px->lng from those pairs. This works
             with the plot FROZEN, which is exactly when _liveMapState()
             returns null by design.
       live  a live unlocked map: _pxToLatLng directly.
       fit   last resort, stretch the terrain bbox onto the boundary bbox.
             Approximate, and labelled as such everywhere it surfaces.

     Interpolation is inverse-distance weighting over the nearest samples,
     bucketed into a uniform grid so a 4000-table layout does not go
     quadratic. IDW rather than bilinear because the lattice has holes
     wherever a point fell outside the ring.
     ══════════════════════════════════════════════════════════════════ */

  function terrain() {
    try {
      var T = (typeof S !== 'undefined') ? S.terrain : null;
      return (T && T.samples && T.samples.length >= 4) ? T : null;
    } catch (e) { return null; }
  }

  /* Build px -> terrain-local-feet for one array shape. */
  function makeProjector(shape, boundaryPx) {
    var T = terrain();
    if (!T) return null;

    var lat0 = T.lat0, lng0 = T.lng0;
    var fLng = ftPerDegLng(lat0);

    function fromLatLng(lat, lng) {
      return { x: (lng - lng0) * fLng, y: (lat - lat0) * FT_PER_DEG_LAT };
    }

    /* route: geo — matched px/latlng vertex pairs off the shape */
    if (shape && shape._geoBoundary && shape.boundary &&
        shape._geoBoundary.length === shape.boundary.length &&
        shape._geoBoundary.length >= 3) {
      var pts = [], lats = [], lngs = [], ok = true;
      for (var i = 0; i < shape.boundary.length; i++) {
        var g = shape._geoBoundary[i], p = shape.boundary[i];
        if (!g || g.lat == null || !p) { ok = false; break; }
        pts.push(p); lats.push(g.lat); lngs.push(g.lng);
      }
      if (ok) {
        var fa = affineFit(pts, lats), fo = affineFit(pts, lngs);
        if (fa && fo) {
          return {
            mode: 'geo',
            quality: 'anchored',
            toFt: function (px, py) {
              return fromLatLng(affineEval(fa, px, py), affineEval(fo, px, py));
            },
            toLatLng: function (px, py) {
              return { lat: affineEval(fa, px, py), lng: affineEval(fo, px, py) };
            }
          };
        }
      }
    }

    /* route: live — unlocked map */
    try {
      if (typeof _liveMapState === 'function' && typeof _pxToLatLng === 'function' &&
          typeof _getCanvasSize === 'function') {
        var ms = _liveMapState();
        if (ms) {
          var cs = _getCanvasSize();
          return {
            mode: 'live',
            quality: 'anchored',
            toFt: function (px, py) {
              var ll = _pxToLatLng(px, py, ms, cs.w, cs.h);
              return ll ? fromLatLng(ll.lat, ll.lng) : { x: 0, y: 0 };
            },
            toLatLng: function (px, py) { return _pxToLatLng(px, py, ms, cs.w, cs.h); }
          };
        }
      }
    } catch (e) {}

    /* route: fit — terrain bbox stretched onto the boundary bbox */
    if (boundaryPx && boundaryPx.length >= 3) {
      var inside = T.samples.filter(function (p) { return p.inside !== false; });
      if (inside.length < 3) inside = T.samples;
      var tb = bboxOf(inside), pb = bboxOf(boundaryPx);
      if (tb.w > 0 && tb.h > 0 && pb.w > 0 && pb.h > 0) {
        var sx = tb.w / pb.w, sy = tb.h / pb.h;
        return {
          mode: 'fit',
          quality: 'approximate',
          toFt: function (px, py) {
            return {
              x: tb.minX + (px - pb.minX) * sx,
              /* canvas y grows downward, terrain y grows north */
              y: tb.maxY - (py - pb.minY) * sy
            };
          },
          toLatLng: function (px, py) {
            var f = this.toFt(px, py);
            return { lat: lat0 + f.y / FT_PER_DEG_LAT, lng: lng0 + f.x / fLng };
          }
        };
      }
    }
    return null;
  }

  /* Elevation field over the terrain lattice.
     v2: a grid TIN when the lattice is regular (it almost always is),
     falling back to the v1 IDW sampler otherwise. See section 17 for
     the measurements that motivated the change. */
  function makeField() {
    var T = terrain();
    if (!T) return null;
    if (!_omegaNoTIN) {
      try {
        var tin = buildGridTIN(T);
        if (tin) return tin;
      } catch (e) { if (window.console) console.warn(TAG, 'TIN build failed, using IDW:', e && e.message); }
    }
    return makeIDWField(T);
  }
  var _omegaNoTIN = false;

  /* Spatially bucketed IDW sampler — the v1 path, kept as the fallback
     for lattices the TIN cannot use (no row/col, or non-uniform). */
  function makeIDWField(T) {

    if (!T) return null;
    var pts = T.samples.filter(function (p) { return isFinite(p.x) && isFinite(p.y) && isFinite(p.zFt); });
    if (pts.length < 4) return null;

    var bb = bboxOf(pts);
    var spacing = num(T.spacingFt, 0) || Math.max(bb.w, bb.h) / Math.max(1, Math.sqrt(pts.length));
    var cell = Math.max(spacing, 1);
    var cols = Math.max(1, Math.ceil(bb.w / cell) + 1);
    var rows = Math.max(1, Math.ceil(bb.h / cell) + 1);

    var grid = {};
    function key(c, r) { return c + ':' + r; }
    for (var i = 0; i < pts.length; i++) {
      var c = clamp(Math.floor((pts[i].x - bb.minX) / cell), 0, cols - 1);
      var r = clamp(Math.floor((pts[i].y - bb.minY) / cell), 0, rows - 1);
      var k = key(c, r);
      (grid[k] || (grid[k] = [])).push(pts[i]);
    }

    /* Elevation at terrain-local (x,y) feet. Returns null outside the
       sampled extent by more than one cell — an honest "no data" beats an
       extrapolated number that looks authoritative. */
    function zAt(x, y) {
      if (!isFinite(x) || !isFinite(y)) return null;
      if (x < bb.minX - cell || x > bb.maxX + cell ||
          y < bb.minY - cell || y > bb.maxY + cell) return null;

      var c0 = clamp(Math.floor((x - bb.minX) / cell), 0, cols - 1);
      var r0 = clamp(Math.floor((y - bb.minY) / cell), 0, rows - 1);

      var found = [], ring = 0;
      while (found.length < 4 && ring <= 4) {
        for (var dc = -ring; dc <= ring; dc++) {
          for (var dr = -ring; dr <= ring; dr++) {
            if (ring > 0 && Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
            var b = grid[key(c0 + dc, r0 + dr)];
            if (b) found = found.concat(b);
          }
        }
        ring++;
      }
      if (!found.length) return null;

      /* nearest-first, then IDW over the closest few */
      found.sort(function (a, b) {
        var da = (a.x - x) * (a.x - x) + (a.y - y) * (a.y - y);
        var db = (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y);
        return da - db;
      });
      var k = Math.min(6, found.length), wsum = 0, zsum = 0;
      for (var j = 0; j < k; j++) {
        var d2 = (found[j].x - x) * (found[j].x - x) + (found[j].y - y) * (found[j].y - y);
        if (d2 < 1e-6) return found[j].zFt;      /* sat right on a post */
        var w = 1 / d2;
        wsum += w; zsum += w * found[j].zFt;
      }
      return wsum > 0 ? zsum / wsum : null;
    }

    return {
      kind: 'idw',
      zAt: zAt,
      spacingFt: spacing,
      bbox: bb,
      count: pts.length,
      reliefFt: num(T.reliefFt, 0),
      slopePct: num(T.slopePct, 0),
      aspectDeg: num(T.aspectDeg, 0)
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     2.  RACKING TOLERANCES
     ──────────────────────────────────────────────────────────────────
     The base engine lays tables out in a ROTATED frame: local +x runs
     along the row (tables sit side by side), local +y is the pitch axis
     (row to row). Every table carries {x,y,w,h,a} where (x+w/2, y+h/2)
     is the centre in canvas px and `a` is the rotation about it.

     So for a table:
       local x  ..  across the table width  (tableWft)
       local y  ..  through the table depth (tableHft), the pitch axis

     What that axis MEANS depends on the mount, which is why the limits
     are per preset rather than global:

     Limits are stated ALONG the structural long axis and ACROSS it,
     never as local x/y. That matters because the tracker-axis fix in
     section 18 deliberately swaps which local axis carries the tube —
     limits pinned to x and y would silently end up on the wrong ones,
     passing a 12% grade along a tube rated for 10% while rejecting
     chord slopes that were never a problem. Resolving "long" from the
     table's own dimensions makes the limits invariant to that swap.

       fixed-tilt   long = the beam. Tolerant: unequal pile reveals
                    absorb a lot of grade.
       SAT          long = the torque tube (N-S). This is the tight
                    one — a standard tracker cannot follow much grade
                    along its tube without racking the bearings.
       TFT          terrain-following: articulated bearings raise both
                    limits sharply. Figures reflect what all-terrain
                    tracker suppliers publish (up to ~37% incline, ~26%
                    post to post).
       carport      a steel frame over parking, near enough rigid.

     These are DEFAULTS. Anyone with a supplier's structural letter
     should overwrite them — they are the numbers that decide how much
     of a site is buildable, so a wrong one is expensive in both
     directions.
     ══════════════════════════════════════════════════════════════════ */

  var RACK = {
    'fixed-ground': {
      label: 'Fixed-tilt ground mount',
      slopeAlongPct: 15, slopeCrossPct: 20,
      postLines: 2,            /* front and back legs */
      postSpacingFt: 10,       /* along the table width */
      pileMode: 'plane',       /* one top-of-pile elevation per table */
      minRevealFt: 2.0, maxRevealFt: 8.0, nomRevealFt: 4.0,
      embedFt: 7.0,
      tiltDeg: 25,
      maxWarpFt: 0.6,          /* rigid frame: very little twist tolerated */
      minGroundClearFt: 1.5
    },
    'tracker-1ax': {
      label: 'Single-axis tracker',
      slopeAlongPct: 10, slopeCrossPct: 15,
      postLines: 1,            /* the torque tube line */
      postSpacingFt: 25,       /* bearing spacing along the tube */
      pileMode: 'line',        /* tube is straight: fit a line, clamp slope */
      minRevealFt: 3.0, maxRevealFt: 10.0, nomRevealFt: 5.5,
      embedFt: 8.0,
      tiltDeg: 0,
      maxWarpFt: 1.2,          /* bearings absorb some, the tube must stay straight */
      minGroundClearFt: 2.0
    },
    'tracker-tft': {
      label: 'Terrain-following tracker (TFT)',
      slopeAlongPct: 37, slopeCrossPct: 26,
      postLines: 1,
      postSpacingFt: 25,
      pileMode: 'follow',      /* articulated: piles track grade */
      minRevealFt: 3.0, maxRevealFt: 9.0, nomRevealFt: 5.0,
      embedFt: 8.0,
      tiltDeg: 0,
      maxWarpFt: 3.0,          /* articulated: twist is the whole point */
      maxPostToPostPct: 26,    /* articulation limit between adjacent piles */
      minGroundClearFt: 2.0
    },
    'carport': {
      label: 'Carport / canopy',
      slopeAlongPct: 8, slopeCrossPct: 8,
      postLines: 2,
      postSpacingFt: 20,
      pileMode: 'plane',
      minRevealFt: 8.0, maxRevealFt: 16.0, nomRevealFt: 12.0,
      embedFt: 9.0,
      tiltDeg: 7,
      maxWarpFt: 0.4,          /* welded steel canopy */
      minGroundClearFt: 8.0
    },
    'rooftop': {
      label: 'Rooftop (coplanar)',
      terrainNA: true,         /* a roof has its own plane; DEM is irrelevant */
      slopeAlongPct: 100, slopeCrossPct: 100,
      postLines: 0, postSpacingFt: 0, pileMode: 'none',
      minRevealFt: 0, maxRevealFt: 0, nomRevealFt: 0, embedFt: 0,
      maxWarpFt: 99,
      tiltDeg: 10, minGroundClearFt: 0
    }
  };

  function rackFor(presetKey) {
    return RACK[presetKey] || RACK['fixed-ground'];
  }

  /* Project overrides live alongside the existing solar assumptions so a
     saved project carries them. */
  function rackTuned(presetKey) {
    var base = rackFor(presetKey);
    var out = {};
    for (var k in base) if (base.hasOwnProperty(k)) out[k] = base[k];
    try {
      var ov = (typeof S !== 'undefined' && S.rackAssume) ? S.rackAssume[presetKey] : null;
      if (ov) for (var j in ov) if (ov.hasOwnProperty(j) && ov[j] != null && ov[j] !== '') out[j] = ov[j];
    } catch (e) {}
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════
     3.  TABLE GEOMETRY IN THE TERRAIN FRAME
     ══════════════════════════════════════════════════════════════════ */

  /* Corner and axis vectors for one table, in canvas px. */
  function tableGeom(t) {
    var cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    var a = t.a || 0, c = Math.cos(a), s = Math.sin(a);
    var hw = t.w / 2, hh = t.h / 2;
    function rot(dx, dy) { return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }; }
    return {
      cx: cx, cy: cy, a: a,
      ex: { x: c, y: s },          /* unit vector along local +x (table width) */
      ey: { x: -s, y: c },         /* unit vector along local +y (pitch axis) */
      corners: [rot(-hw, -hh), rot(hw, -hh), rot(hw, hh), rot(-hw, hh)],
      midX: [rot(-hw, 0), rot(hw, 0)],
      midY: [rot(0, -hh), rot(0, hh)]
    };
  }

  /* Slope of the ground across a table, resolved onto its own axes.
     Sign convention: positive slopeX means ground rises toward local +x. */
  function tableSlope(t, proj, field, pxPerFt) {
    var g = tableGeom(t);
    function z(p) { var f = proj.toFt(p.x, p.y); return field.zAt(f.x, f.y); }

    var zx0 = z(g.midX[0]), zx1 = z(g.midX[1]);
    var zy0 = z(g.midY[0]), zy1 = z(g.midY[1]);
    var zc = z({ x: g.cx, y: g.cy });
    if (zx0 == null || zx1 == null || zy0 == null || zy1 == null || zc == null) return null;

    var wFt = t.w / pxPerFt, hFt = t.h / pxPerFt;
    var sx = wFt > 0 ? (zx1 - zx0) / wFt : 0;
    var sy = hFt > 0 ? (zy1 - zy0) / hFt : 0;

    /* WARP, not spread.
       An early version rejected tables whose corner elevations spread
       more than a fixed number of feet. That is wrong, and it rejected
       every tracker: a 180 ft torque tube on a perfectly uniform 4%
       grade spreads 7 ft corner to corner while being completely
       buildable. Spread measures slope, which the gradient tests above
       already cover.

       What actually defeats a rigid table is TWIST — the corners not
       lying in a common plane. So fit a plane through the four corners
       and keep the largest residual. A uniform slope of any steepness
       returns ~0; a saddle or a knob returns the real number. */
    var cz = g.corners.map(z);
    var warp = null;
    if (cz.every(function (v) { return v != null; })) {
      var local = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
      var pf = affineFit(local, cz);
      if (pf) {
        warp = 0;
        for (var i = 0; i < 4; i++) {
          var r = Math.abs(cz[i] - affineEval(pf, local[i].x, local[i].y));
          if (r > warp) warp = r;
        }
      }
    }

    /* Resolve onto the STRUCTURE's axes, not the canvas's: whichever
       table dimension is longer carries the beam or the torque tube. */
    var longIsX = (t.w >= t.h);
    return {
      slopeXPct: sx * 100,
      slopeYPct: sy * 100,
      slopeAlongPct: (longIsX ? sx : sy) * 100,
      slopeCrossPct: (longIsX ? sy : sx) * 100,
      longAxis: longIsX ? 'x' : 'y',
      resultantPct: Math.hypot(sx, sy) * 100,
      zCentreFt: zc,
      warpFt: warp,
      cornerSpreadFt: (cz.every(function (v) { return v != null; }))
        ? Math.max.apply(null, cz) - Math.min.apply(null, cz) : null,
      cornerZ: cz
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     4.  TERRAIN SCREENING OF A LAYOUT
     ──────────────────────────────────────────────────────────────────
     Takes the tables the flat engine produced and decides which of them
     are actually buildable on the real surface. Returns the surviving
     set plus a rejection breakdown, so the UI can say WHY a site lost
     capacity rather than just showing a smaller number.
     ══════════════════════════════════════════════════════════════════ */

  function screenLayout(tables, presetKey, proj, field, pxPerFt, opts) {
    opts = opts || {};
    var R = rackTuned(presetKey);
    var limAlong = num(opts.slopeAlongPct, R.slopeAlongPct);
    var limCross = num(opts.slopeCrossPct, R.slopeCrossPct);

    var kept = [], rejected = [];
    var reasons = { along: 0, cross: 0, noData: 0, warp: 0 };
    var maxWarp = num(opts.maxWarpFt, R.maxWarpFt);

    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      var sl = tableSlope(t, proj, field, pxPerFt);
      if (!sl) { reasons.noData++; rejected.push({ t: t, why: 'no terrain data' }); continue; }

      t._slope = sl;
      if (Math.abs(sl.slopeAlongPct) > limAlong) {
        reasons.along++;
        rejected.push({ t: t, why: 'axis slope ' + sl.slopeAlongPct.toFixed(1) + '%' }); continue;
      }
      if (Math.abs(sl.slopeCrossPct) > limCross) {
        reasons.cross++;
        rejected.push({ t: t, why: 'cross slope ' + sl.slopeCrossPct.toFixed(1) + '%' }); continue;
      }
      if (sl.warpFt != null && sl.warpFt > maxWarp) {
        reasons.warp++; rejected.push({ t: t, why: 'twist ' + sl.warpFt.toFixed(1) + ' ft' }); continue;
      }
      kept.push(t);
    }

    var slopes = kept.map(function (t) { return Math.abs(t._slope.resultantPct); });
    slopes.sort(function (a, b) { return a - b; });

    return {
      kept: kept, rejected: rejected, reasons: reasons,
      keptCount: kept.length, rejectedCount: rejected.length,
      buildablePct: tables.length ? Math.round(kept.length / tables.length * 100) : 0,
      limitAlongPct: limAlong, limitCrossPct: limCross,
      medianSlopePct: slopes.length ? +slopes[Math.floor(slopes.length / 2)].toFixed(2) : 0,
      maxSlopePct: slopes.length ? +slopes[slopes.length - 1].toFixed(2) : 0
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     5.  PILE SCHEDULE
     ──────────────────────────────────────────────────────────────────
     Three foundation models, because the structure decides how reveals
     are allowed to vary:

       plane   fixed-tilt and carport. Every pile in one table shares a
               single top-of-pile elevation — the rack supplies the tilt.
               Reveal varies with micro-relief under that table.
       line    standard SAT. The torque tube is straight, so a least
               squares line is fitted along it and its slope CLAMPED to
               the tolerance; reveals fall out of the residuals.
       follow  TFT. Piles track grade at a near-constant reveal; what
               matters instead is the grade change between ADJACENT piles,
               against the articulation limit.

     Reveals outside [min,max] become grading, priced by the pile's
     tributary area. That is the layout-driven earthworks number — the
     one that actually moves a budget — as opposed to the whole-site
     cut/fill the base file already reports off the fitted plane.
     ══════════════════════════════════════════════════════════════════ */

  function pilesForTable(t, idx, R, proj, field, pxPerFt) {
    var g = tableGeom(t);
    var wFt = t.w / pxPerFt, hFt = t.h / pxPerFt;
    var lines = Math.max(1, R.postLines | 0);
    var spacing = Math.max(2, num(R.postSpacingFt, 10));

    /* Post lines run along whichever axis is longer: the beam for a
       fixed table, the torque tube for a tracker. */
    var alongX = (lines >= 2) || (wFt >= hFt);
    var runFt = alongX ? wFt : hFt;
    var offFt = alongX ? hFt : wFt;

    var nPosts = Math.max(2, Math.round(runFt / spacing) + 1);
    var out = [];

    for (var L = 0; L < lines; L++) {
      /* Two lines sit at the outer edges; one line sits on centre. */
      var off = (lines === 1) ? 0 : (-offFt / 2 + L * offFt / (lines - 1));
      for (var i = 0; i < nPosts; i++) {
        var run = -runFt / 2 + (runFt * i / (nPosts - 1));
        var lx = alongX ? run : off;
        var ly = alongX ? off : run;
        var px = g.cx + (lx * g.ex.x + ly * g.ey.x) * pxPerFt;
        var py = g.cy + (lx * g.ex.y + ly * g.ey.y) * pxPerFt;
        var f = proj.toFt(px, py);
        var z = field.zAt(f.x, f.y);
        out.push({
          tableIdx: idx, line: L, seq: i,
          localXFt: lx, localYFt: ly,
          px: px, py: py,
          runFt: run,                       /* position along the post line */
          xFt: f.x, yFt: f.y,
          groundFt: z
        });
      }
    }
    return out;
  }

  function schedulePiles(tables, presetKey, proj, field, pxPerFt, opts) {
    opts = opts || {};
    var R = rackTuned(presetKey);
    if (R.pileMode === 'none') return null;

    var nom = num(opts.nomRevealFt, R.nomRevealFt);
    var lo = num(opts.minRevealFt, R.minRevealFt);
    var hi = num(opts.maxRevealFt, R.maxRevealFt);
    var embed = num(opts.embedFt, R.embedFt);

    var all = [], perTable = [];
    var cut = 0, fill = 0, outOfRange = 0, artFail = 0;
    var lenTotal = 0;

    for (var ti = 0; ti < tables.length; ti++) {
      var t = tables[ti];
      var ps = pilesForTable(t, ti, R, proj, field, pxPerFt);
      var valid = ps.filter(function (p) { return p.groundFt != null; });
      if (valid.length < 2) continue;

      var tribFt2 = (t.w / pxPerFt) * (t.h / pxPerFt) / ps.length;

      if (R.pileMode === 'plane') {
        /* One elevation for the whole table: mean ground + nominal reveal. */
        var mean = valid.reduce(function (a, p) { return a + p.groundFt; }, 0) / valid.length;
        var top = mean + nom;
        valid.forEach(function (p) { p.topFt = top; });

      } else if (R.pileMode === 'line') {
        /* Straight tube: least squares line of (run, ground+nom), then
           clamp the slope to the axis tolerance. Clamping about the
           midpoint keeps the fit balanced instead of pivoting one end
           into the dirt. */
        var n = valid.length, Sr = 0, Sz = 0, Srr = 0, Srz = 0;
        valid.forEach(function (p) {
          var z = p.groundFt + nom;
          Sr += p.runFt; Sz += z; Srr += p.runFt * p.runFt; Srz += p.runFt * z;
        });
        var den = n * Srr - Sr * Sr;
        var m = Math.abs(den) > 1e-9 ? (n * Srz - Sr * Sz) / den : 0;
        var b = (Sz - m * Sr) / n;
        var lim = num(R.slopeAlongPct, 10) / 100;
        var mC = clamp(m, -lim, lim);
        var rMid = Sr / n;
        b = b + (m - mC) * rMid;             /* re-anchor at the midpoint */
        valid.forEach(function (p) { p.topFt = mC * p.runFt + b; });

      } else {
        /* follow: constant reveal, then test articulation pile to pile. */
        valid.forEach(function (p) { p.topFt = p.groundFt + nom; });
        var lim2 = num(R.maxPostToPostPct, 26) / 100;
        for (var k = 1; k < valid.length; k++) {
          if (valid[k].line !== valid[k - 1].line) continue;
          var dr = Math.abs(valid[k].runFt - valid[k - 1].runFt);
          if (dr < 0.5) continue;
          var dz = Math.abs(valid[k].topFt - valid[k - 1].topFt);
          if (dz / dr > lim2) { valid[k].articulationFail = true; artFail++; }
        }
      }

      valid.forEach(function (p) {
        p.revealFt = p.topFt - p.groundFt;
        p.status = 'ok';
        if (p.revealFt > hi) {
          p.status = 'cut';
          cut += (p.revealFt - hi) * tribFt2;
          outOfRange++;
        } else if (p.revealFt < lo) {
          p.status = 'fill';
          fill += (lo - p.revealFt) * tribFt2;
          outOfRange++;
        }
        if (p.articulationFail) p.status = 'articulation';
        p.embedFt = embed;
        p.lengthFt = Math.max(0, p.revealFt) + embed;
        lenTotal += p.lengthFt;
        all.push(p);
      });

      var rv = valid.map(function (p) { return p.revealFt; });
      perTable.push({
        idx: ti, piles: valid.length,
        minRevealFt: Math.min.apply(null, rv),
        maxRevealFt: Math.max.apply(null, rv)
      });
    }

    var reveals = all.map(function (p) { return p.revealFt; }).sort(function (a, b) { return a - b; });

    return {
      piles: all, perTable: perTable,
      count: all.length,
      revealMinFt: reveals.length ? +reveals[0].toFixed(2) : 0,
      revealMaxFt: reveals.length ? +reveals[reveals.length - 1].toFixed(2) : 0,
      revealMedianFt: reveals.length ? +reveals[Math.floor(reveals.length / 2)].toFixed(2) : 0,
      outOfRange: outOfRange,
      articulationFails: artFail,
      totalSteelFt: Math.round(lenTotal),
      cutCy: Math.round(cut / 27),
      fillCy: Math.round(fill / 27),
      nomRevealFt: nom, minRevealFt: lo, maxRevealFt: hi, embedFt: embed,
      mode: R.pileMode
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     6.  COLLISION / CLEARANCE
     ──────────────────────────────────────────────────────────────────
     Two failures that only exist once Z is real:

       grade strike  the terrain rises inside a table's footprint far
                     enough to reach the module underside.
       row break     the grade between adjacent row centres exceeds the
                     axis tolerance, so the rows step rather than run.

     Both are reported per table with the offending magnitude, because a
     count on its own does not tell you whether to regrade or re-lay.
     ══════════════════════════════════════════════════════════════════ */

  function checkCollisions(tables, presetKey, pileRes, proj, field, pxPerFt) {
    var R = rackTuned(presetKey);
    if (R.pileMode === 'none' || !pileRes) return null;

    var clear = num(R.minGroundClearFt, 1.5);
    var strikes = [], breaks = [];

    /* top-of-pile elevation per table, from the schedule */
    var topByTable = {};
    pileRes.piles.forEach(function (p) {
      var e = topByTable[p.tableIdx];
      if (!e) topByTable[p.tableIdx] = { min: p.topFt, max: p.topFt, cx: 0, cy: 0, n: 0 };
      else { if (p.topFt < e.min) e.min = p.topFt; if (p.topFt > e.max) e.max = p.topFt; }
    });

    for (var i = 0; i < tables.length; i++) {
      var t = tables[i], top = topByTable[i];
      if (!top) continue;
      var g = tableGeom(t);

      /* Sample a 3x3 lattice inside the footprint and find the highest
         ground under the lowest structural point. */
      var worst = null;
      for (var a = -1; a <= 1; a++) {
        for (var b = -1; b <= 1; b++) {
          var lx = a * t.w / 2 * 0.8, ly = b * t.h / 2 * 0.8;
          var px = g.cx + lx * g.ex.x + ly * g.ey.x;
          var py = g.cy + lx * g.ex.y + ly * g.ey.y;
          var f = proj.toFt(px, py);
          var z = field.zAt(f.x, f.y);
          if (z == null) continue;
          var gap = top.min - z;
          if (worst == null || gap < worst) worst = gap;
        }
      }
      if (worst != null && worst < clear) {
        strikes.push({ idx: i, clearanceFt: +worst.toFixed(2), requiredFt: clear });
      }
      if (t._slope && Math.abs(t._slope.slopeAlongPct) > num(R.slopeAlongPct, 20) * 0.85) {
        breaks.push({ idx: i, slopePct: +t._slope.slopeAlongPct.toFixed(1) });
      }
    }

    return {
      strikes: strikes, strikeCount: strikes.length,
      nearLimit: breaks, nearLimitCount: breaks.length,
      requiredClearFt: clear
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     7.  SOLAR GEOMETRY
     ──────────────────────────────────────────────────────────────────
     Enough of it to answer one question the base file asserts but never
     computes: is the row pitch actually clear of shading?

     The detail sheet prints "PITCH SET FOR WINTER-SOLSTICE SHADING",
     but pitch is derived as tableDepth / GCR — GCR is an input, so the
     sheet is describing an intention rather than a result. These
     functions turn it into a result.

     Declination uses the Cooper approximation, which is within about a
     third of a degree — irrelevant next to a 10 m DEM.
     ══════════════════════════════════════════════════════════════════ */

  function declinationDeg(dayOfYear) {
    return -23.44 * Math.cos(2 * Math.PI * (dayOfYear + 10) / 365.25);
  }

  function dayOfYear(m, d) {
    var cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    return cum[m - 1] + d;
  }

  /* Sun altitude and azimuth (azimuth measured clockwise from true north)
     for a latitude, declination and solar hour. */
  function sunPos(latDeg, decDeg, solarHour) {
    var lat = latDeg * D2R, dec = decDeg * D2R;
    var H = (solarHour - 12) * 15 * D2R;
    var sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
    sinAlt = clamp(sinAlt, -1, 1);
    var alt = Math.asin(sinAlt);
    var cosAz = (Math.sin(dec) - Math.sin(alt) * Math.sin(lat)) / (Math.cos(alt) * Math.cos(lat) || 1e-9);
    var az = Math.acos(clamp(cosAz, -1, 1));
    if (H > 0) az = 2 * Math.PI - az;
    return { altDeg: alt * R2D, azDeg: az * R2D };
  }

  /* Profile angle: the sun's apparent altitude in the vertical plane
     normal to the rows. This, not the raw altitude, sets row spacing —
     a low sun well off to the side casts a much longer row shadow than
     its altitude alone suggests. */
  function profileAngleDeg(altDeg, azDeg, rowAzDeg) {
    var d = Math.abs(((azDeg - rowAzDeg + 540) % 360) - 180);
    var g = d * D2R;
    if (Math.cos(g) <= 1e-4) return 0.01;                 /* sun along the rows */
    return Math.atan(Math.tan(altDeg * D2R) / Math.cos(g)) * R2D;
  }

  /* Site latitude: terrain origin if sampled, otherwise the live map. */
  function siteLatLng() {
    var T = terrain();
    if (T && isFinite(T.lat0)) return { lat: T.lat0, lng: T.lng0, src: 'terrain sample' };
    try {
      if (typeof _liveMapState === 'function') {
        var ms = _liveMapState();
        if (ms) return { lat: ms.lat, lng: ms.lng, src: 'map centre' };
      }
    } catch (e) {}
    try {
      if (typeof S !== 'undefined' && S.siteLat != null) return { lat: +S.siteLat, lng: +S.siteLng, src: 'project' };
    } catch (e) {}
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════
     8.  SHADING ANALYSIS
     ──────────────────────────────────────────────────────────────────
     Required pitch for a clear window either side of solar noon:

       collector depth  d = L cos(beta)
       collector rise   h = L sin(beta)
       shadow reach     h / tan(profile angle)
       required pitch   d + shadow reach
       implied GCR      L / pitch

     Also reported: the pitch the CURRENT GCR produces, and how many
     clear hours that pitch actually buys — which is the number people
     argue about, since nobody really designs to zero shading at 9am on
     21 December.

     On a slope the geometry changes: a row on ground falling away to
     the south needs LESS pitch, one on ground rising to the south needs
     more. The terrain slope in the pitch direction is folded in as an
     effective tilt adjustment.
     ══════════════════════════════════════════════════════════════════ */

  function shadingAnalysis(cfg) {
    cfg = cfg || {};
    var ll = cfg.lat != null ? { lat: cfg.lat } : siteLatLng();
    if (!ll) return { ok: false, why: 'No site latitude — sample terrain or place the map first.' };

    var lat = ll.lat;
    var L = num(cfg.collectorFt, 12);              /* slant length of the table */
    var tilt = num(cfg.tiltDeg, 25);
    var rowAz = num(cfg.rowAzimuthDeg, 180);       /* module facing, 180 = due south */
    var gcr = num(cfg.gcr, 0.4);
    var terrSlopePct = num(cfg.terrainSlopePct, 0);  /* +ve rises toward the sun side */
    var window = num(cfg.clearHours, 6);           /* hours centred on solar noon */

    /* Design to the LOCAL winter solstice. Defaulting to 21 December
       everywhere quietly sizes southern-hemisphere sites to midsummer,
       which returns a maximum GCR above 1.0 — physically impossible, and
       exactly the kind of number that looks like a result. */
    var southern = lat < 0;
    var month = num(cfg.month, southern ? 6 : 12);
    var day = num(cfg.day, 21);

    var dec = declinationDeg(dayOfYear(month, day));
    var half = window / 2;
    var edge = sunPos(lat, dec, 12 - half);

    /* Southern hemisphere sites face north; the profile-angle geometry is
       identical once the row azimuth is right. */
    var noon = sunPos(lat, dec, 12);
    if (noon.altDeg <= 0) {
      return { ok: false, why: 'Sun does not clear the horizon at this latitude on the chosen date.' };
    }

    var psiNoon = profileAngleDeg(noon.altDeg, noon.azDeg, rowAz);
    var psiEdge = edge.altDeg > 0 ? profileAngleDeg(edge.altDeg, edge.azDeg, rowAz) : 0.01;

    /* Ground slope in the pitch direction, as a gradient. Kept as a raw
       rise/run rather than being round-tripped through degrees: an
       earlier version fed Math.tan() a value already converted to
       degrees, which silently produced nonsense for every sloped site. */
    var tanSlope = terrSlopePct / 100;

    function pitchFor(psiDeg) {
      if (psiDeg <= 0.05) return Infinity;
      var d = L * Math.cos(tilt * D2R);
      var h = L * Math.sin(tilt * D2R);
      var tanPsi = Math.tan(psiDeg * D2R);
      if (tanPsi <= 1e-4) return Infinity;
      /* Ground falling away toward the sun drops the next row below the
         shadow, so less pitch is needed; ground rising toward the sun
         lifts it into the shadow and needs more. tanSlope is positive
         when the ground RISES toward the sun side. */
      var slopeAdj = 1 + tanSlope / tanPsi;
      return d + (h / tanPsi) * clamp(slopeAdj, 0.15, 4);
    }

    var reqNoon = pitchFor(psiNoon);
    var reqWindow = pitchFor(psiEdge);
    var actual = gcr > 0 ? L / gcr : Infinity;

    /* How many clear hours the actual pitch buys: walk out from noon
       until the shadow reaches the next row. */
    var clearHrs = 0;
    for (var h2 = 0; h2 <= 6; h2 += 0.25) {
      var sp = sunPos(lat, dec, 12 - h2);
      if (sp.altDeg <= 0) break;
      var psi = profileAngleDeg(sp.altDeg, sp.azDeg, rowAz);
      if (pitchFor(psi) > actual) break;
      clearHrs = h2 * 2;
    }

    /* GCR is module area over land area. Above 1.0 the rows overlap, so
       a "maximum" beyond that means the date is not binding, not that
       the site can take it. Cap it and say so. */
    function capGcr(pitchFt) {
      if (!isFinite(pitchFt) || pitchFt <= 0) return null;
      return +Math.min(1, L / pitchFt).toFixed(3);
    }

    return {
      ok: true,
      latDeg: +lat.toFixed(4),
      hemisphere: southern ? 'south' : 'north',
      dateLabel: month + '/' + day + (southern ? ' (southern winter solstice)' : ''),
      declinationDeg: +dec.toFixed(2),
      noonAltitudeDeg: +noon.altDeg.toFixed(2),
      noonProfileDeg: +psiNoon.toFixed(2),
      windowProfileDeg: +psiEdge.toFixed(2),
      collectorFt: L, tiltDeg: tilt, rowAzimuthDeg: rowAz,
      terrainSlopePct: terrSlopePct,
      requiredPitchNoonFt: isFinite(reqNoon) ? +reqNoon.toFixed(2) : null,
      requiredPitchWindowFt: isFinite(reqWindow) ? +reqWindow.toFixed(2) : null,
      actualPitchFt: isFinite(actual) ? +actual.toFixed(2) : null,
      actualGcr: gcr,
      maxGcrNoon: capGcr(reqNoon),
      maxGcrWindow: capGcr(reqWindow),
      gcrNotBinding: (isFinite(reqWindow) && reqWindow > 0 && L / reqWindow > 1),
      clearHours: +clearHrs.toFixed(1),
      targetHours: window,
      verdict: (actual >= reqWindow) ? 'clear for the target window'
             : (actual >= reqNoon) ? 'clear at solar noon, shaded at the window edges'
             : 'shaded at solar noon',
      shortfallFt: (actual < reqWindow && isFinite(reqWindow)) ? +(reqWindow - actual).toFixed(2) : 0,
      source: ll.src || 'given'
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     9.  STRINGING AND DC COLLECTION
     ──────────────────────────────────────────────────────────────────
     The base engine reports an inverter BLOCK COUNT derived by dividing
     capacity by a target — a divide, not a design. This walks the actual
     tables:

       modules per table  back-solved from the same area x fill x W/ft2
                          the capacity model uses, so the two never
                          disagree
       strings            consecutive tables along a row, wrapping to the
                          next row when a string runs out of table
       combiners          N strings each, placed at the centroid of the
                          tables they serve
       inverter blocks    combiners grouped to a target DC rating

     Cable length is Manhattan in the ARRAY's own rotated frame — routed
     along the row then across it, which is how it actually gets pulled,
     rather than a straight line nobody can trench.
     ══════════════════════════════════════════════════════════════════ */

  var AMPACITY = [                 /* 90C copper, free air / conduit derated */
    { awg: '10', a: 40 }, { awg: '8', a: 55 }, { awg: '6', a: 75 },
    { awg: '4', a: 95 }, { awg: '2', a: 130 }, { awg: '1/0', a: 170 },
    { awg: '2/0', a: 195 }, { awg: '4/0', a: 260 }, { awg: '350 kcmil', a: 350 },
    { awg: '500 kcmil', a: 430 }
  ];
  function gaugeFor(amps) {
    for (var i = 0; i < AMPACITY.length; i++) if (AMPACITY[i].a >= amps) return AMPACITY[i].awg;
    return 'parallel runs';
  }

  function stringLayout(tables, layout, pxPerFt, cfg) {
    cfg = cfg || {};
    if (!tables || !tables.length) return null;

    var moduleW = num(cfg.moduleWatts, 550);
    var perString = Math.max(4, num(cfg.modulesPerString, 28));
    var strPerComb = Math.max(2, num(cfg.stringsPerCombiner, 16));
    var blockKw = num(cfg.blockKwDc, layout && layout.blockKwTarget ? layout.blockKwTarget : 2000);
    var imp = num(cfg.moduleImpA, 13.5);
    var wpsf = num(layout && layout.wpsf, 20);
    var fill = num(cfg.moduleFill, 0.92);

    /* Modules per table, reconciled with the capacity model. */
    var tW = num(layout && layout.tableWft, tables[0].w / pxPerFt);
    var tH = num(layout && layout.tableHft, tables[0].h / pxPerFt);
    var perTable = Math.max(1, Math.round(tW * tH * fill * wpsf / moduleW));

    /* Order tables the way a crew would walk them: by row, then along it,
       in the array's rotated frame. */
    var a = tables[0].a || 0, c = Math.cos(a), s = Math.sin(a);
    var idx = tables.map(function (t, i) {
      var cx = t.x + t.w / 2, cy = t.y + t.h / 2;
      return { i: i, t: t, lx: (cx * c + cy * s) / pxPerFt, ly: (-cx * s + cy * c) / pxPerFt };
    });
    var pitchFt = num(layout && layout.pitchFt, tH);
    idx.forEach(function (o) { o.row = Math.round(o.ly / Math.max(1, pitchFt)); });
    idx.sort(function (p, q) { return (p.row - q.row) || (p.lx - q.lx); });

    /* Fill strings across the ordered tables. */
    var strings = [], cur = null, remaining = 0;
    idx.forEach(function (o) {
      var left = perTable;
      while (left > 0) {
        if (!cur) {
          cur = { id: strings.length + 1, modules: 0, tables: [], row: o.row, minLx: o.lx, maxLx: o.lx, ly: o.ly };
          remaining = perString;
        }
        var take = Math.min(left, remaining);
        cur.modules += take; left -= take; remaining -= take;
        if (cur.tables.indexOf(o.i) < 0) cur.tables.push(o.i);
        if (o.lx < cur.minLx) cur.minLx = o.lx;
        if (o.lx > cur.maxLx) cur.maxLx = o.lx;
        if (remaining <= 0) { strings.push(cur); cur = null; }
      }
    });
    /* A short tail string is real — it gets built and it under-produces.
       Keep it and flag it rather than rounding it away. */
    if (cur && cur.modules > 0) { cur.partial = true; strings.push(cur); }

    /* Combiners: consecutive strings, centroid placement. */
    var combiners = [];
    for (var i = 0; i < strings.length; i += strPerComb) {
      var grp = strings.slice(i, i + strPerComb);
      var lx = grp.reduce(function (acc, g) { return acc + (g.minLx + g.maxLx) / 2; }, 0) / grp.length;
      var ly = grp.reduce(function (acc, g) { return acc + g.ly; }, 0) / grp.length;
      var amps = grp.length * imp;
      combiners.push({
        id: combiners.length + 1, strings: grp.map(function (g) { return g.id; }),
        lx: lx, ly: ly, ampsDc: +amps.toFixed(1), gauge: gaugeFor(amps * 1.25)
      });
      grp.forEach(function (g) { g.combiner = combiners.length; });
    }

    /* Home runs: along the row to the combiner's x, then across. */
    var homeRunFt = 0;
    strings.forEach(function (g) {
      var cb = combiners[g.combiner - 1];
      if (!cb) return;
      var mid = (g.minLx + g.maxLx) / 2;
      g.runFt = Math.abs(mid - cb.lx) + Math.abs(g.ly - cb.ly) + (g.maxLx - g.minLx) / 2;
      homeRunFt += g.runFt * 2;                        /* positive and negative */
    });

    /* Blocks: combiners grouped to a DC target. */
    var kwPerString = perString * moduleW / 1000;
    var combKw = strPerComb * kwPerString;
    var combsPerBlock = Math.max(1, Math.round(blockKw / Math.max(1, combKw)));
    var blocks = [];
    for (var j = 0; j < combiners.length; j += combsPerBlock) {
      var cg = combiners.slice(j, j + combsPerBlock);
      var blx = cg.reduce(function (acc, x) { return acc + x.lx; }, 0) / cg.length;
      var bly = cg.reduce(function (acc, x) { return acc + x.ly; }, 0) / cg.length;
      var bkw = cg.reduce(function (acc, x) { return acc + strPerComb * kwPerString; }, 0);
      blocks.push({
        id: blocks.length + 1, combiners: cg.map(function (x) { return x.id; }),
        lx: blx, ly: bly, kwDc: Math.round(bkw), kwAc: Math.round(bkw / 1.25)
      });
      cg.forEach(function (x) { x.block = blocks.length; });
    }

    /* Trunk: combiner to its block inverter. */
    var trunkFt = 0;
    combiners.forEach(function (cb) {
      var b = blocks[cb.block - 1];
      if (!b) return;
      cb.trunkFt = Math.abs(cb.lx - b.lx) + Math.abs(cb.ly - b.ly);
      trunkFt += cb.trunkFt;
    });

    var totalModules = strings.reduce(function (a2, g) { return a2 + g.modules; }, 0);

    return {
      modulesPerTable: perTable,
      modulesPerString: perString,
      moduleWatts: moduleW,
      totalModules: totalModules,
      kwDc: Math.round(totalModules * moduleW / 1000),
      strings: strings, stringCount: strings.length,
      partialStrings: strings.filter(function (g) { return g.partial; }).length,
      combiners: combiners, combinerCount: combiners.length,
      stringsPerCombiner: strPerComb,
      blocks: blocks, blockCount: blocks.length,
      homeRunFt: Math.round(homeRunFt),
      trunkFt: Math.round(trunkFt),
      totalDcFt: Math.round(homeRunFt + trunkFt),
      dcPerKw: totalModules ? +((homeRunFt + trunkFt) / (totalModules * moduleW / 1000)).toFixed(1) : 0
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     10.  ZIP (store method)
     ──────────────────────────────────────────────────────────────────
     A shapefile is not one file — it is at minimum .shp/.shx/.dbf/.prj,
     and every GIS tool expects them zipped together. No compression:
     the geometry is already dense binary and STORE keeps the writer to
     a page of code with nothing to get wrong.
     ══════════════════════════════════════════════════════════════════ */

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zipStore(files) {
    /* files: [{name, bytes:Uint8Array}] */
    var chunks = [], central = [], offset = 0;

    function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
    function u32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }
    function nameBytes(s) {
      var out = [];
      for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xFF);
      return out;
    }

    files.forEach(function (f) {
      var nb = nameBytes(f.name), crc = crc32(f.bytes), sz = f.bytes.length;
      var local = [].concat(
        u32(0x04034B50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(sz), u32(sz), u16(nb.length), u16(0), nb
      );
      chunks.push(new Uint8Array(local));
      chunks.push(f.bytes);
      central.push({ nb: nb, crc: crc, sz: sz, off: offset });
      offset += local.length + sz;
    });

    var cdStart = offset, cdBytes = [];
    central.forEach(function (c) {
      cdBytes = cdBytes.concat(
        u32(0x02014B50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(c.crc), u32(c.sz), u32(c.sz),
        u16(c.nb.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.off), c.nb
      );
    });
    chunks.push(new Uint8Array(cdBytes));
    chunks.push(new Uint8Array([].concat(
      u32(0x06054B50), u16(0), u16(0), u16(central.length), u16(central.length),
      u32(cdBytes.length), u32(cdStart), u16(0)
    )));

    return new Blob(chunks, { type: 'application/zip' });
  }

  /* ══════════════════════════════════════════════════════════════════
     11.  SHAPEFILE WRITER
     ──────────────────────────────────────────────────────────────────
     ESRI polygon (type 5) in WGS84 lon/lat. Outer rings must be
     CLOCKWISE — the sign of the shoelace area is what tells a reader
     which side is inside, and getting it backwards produces a file that
     opens fine and renders as a hole.
     ══════════════════════════════════════════════════════════════════ */

  function ringArea(ring) {
    var a = 0;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
    }
    return a / 2;
  }
  function forceClockwise(ring) {
    return ringArea(ring) > 0 ? ring.slice().reverse() : ring;
  }

  function writeShapefile(features, fields) {
    /* features: [{rings:[[[lng,lat],...]], attrs:{}}]  rings[0] = outer */
    var recs = [], shpBody = [], shxBody = [];
    var gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
    var offsetWords = 50;                             /* after the 100-byte header */

    features.forEach(function (f, i) {
      var rings = f.rings.map(function (r, ri) {
        var closed = r.slice();
        var a = closed[0], b = closed[closed.length - 1];
        if (a[0] !== b[0] || a[1] !== b[1]) closed.push([a[0], a[1]]);
        return ri === 0 ? forceClockwise(closed) : forceClockwise(closed).slice().reverse();
      });

      var nPts = rings.reduce(function (s, r) { return s + r.length; }, 0);
      var contentBytes = 44 + 4 * rings.length + 16 * nPts;
      var buf = new ArrayBuffer(contentBytes);
      var dv = new DataView(buf);

      var mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      rings.forEach(function (r) {
        r.forEach(function (p) {
          if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0];
          if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1];
        });
      });
      if (mnx < gMinX) gMinX = mnx; if (mxx > gMaxX) gMaxX = mxx;
      if (mny < gMinY) gMinY = mny; if (mxy > gMaxY) gMaxY = mxy;

      var o = 0;
      dv.setInt32(o, 5, true); o += 4;
      dv.setFloat64(o, mnx, true); o += 8;
      dv.setFloat64(o, mny, true); o += 8;
      dv.setFloat64(o, mxx, true); o += 8;
      dv.setFloat64(o, mxy, true); o += 8;
      dv.setInt32(o, rings.length, true); o += 4;
      dv.setInt32(o, nPts, true); o += 4;
      var acc = 0;
      rings.forEach(function (r) { dv.setInt32(o, acc, true); o += 4; acc += r.length; });
      rings.forEach(function (r) {
        r.forEach(function (p) {
          dv.setFloat64(o, p[0], true); o += 8;
          dv.setFloat64(o, p[1], true); o += 8;
        });
      });

      var hdr = new ArrayBuffer(8), hv = new DataView(hdr);
      hv.setInt32(0, i + 1, false);
      hv.setInt32(4, contentBytes / 2, false);
      shpBody.push(new Uint8Array(hdr), new Uint8Array(buf));

      var sx = new ArrayBuffer(8), sv = new DataView(sx);
      sv.setInt32(0, offsetWords, false);
      sv.setInt32(4, contentBytes / 2, false);
      shxBody.push(new Uint8Array(sx));
      offsetWords += 4 + contentBytes / 2;

      recs.push(f.attrs || {});
    });

    function header(fileWords, type) {
      var b = new ArrayBuffer(100), d = new DataView(b);
      d.setInt32(0, 9994, false);
      d.setInt32(24, fileWords, false);
      d.setInt32(28, 1000, true);
      d.setInt32(32, type, true);
      d.setFloat64(36, isFinite(gMinX) ? gMinX : 0, true);
      d.setFloat64(44, isFinite(gMinY) ? gMinY : 0, true);
      d.setFloat64(52, isFinite(gMaxX) ? gMaxX : 0, true);
      d.setFloat64(60, isFinite(gMaxY) ? gMaxY : 0, true);
      return new Uint8Array(b);
    }

    function concat(parts) {
      var n = parts.reduce(function (s, p) { return s + p.length; }, 0);
      var out = new Uint8Array(n), o = 0;
      parts.forEach(function (p) { out.set(p, o); o += p.length; });
      return out;
    }

    var shpWords = 50 + shpBody.reduce(function (s, p) { return s + p.length; }, 0) / 2;
    var shxWords = 50 + 4 * features.length;
    var shp = concat([header(shpWords, 5)].concat(shpBody));
    var shx = concat([header(shxWords, 5)].concat(shxBody));
    var dbf = writeDBF(recs, fields);

    var prj = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",'
            + 'SPHEROID["WGS_1984",6378137.0,298.257223563]],'
            + 'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
    var prjBytes = new Uint8Array(prj.length);
    for (var i = 0; i < prj.length; i++) prjBytes[i] = prj.charCodeAt(i);

    return { shp: shp, shx: shx, dbf: dbf, prj: prjBytes };
  }

  /* dBASE III table. Everything is written as a fixed-width character
     field: numeric dBASE fields have their own padding rules and no GIS
     reader cares, whereas a mis-padded numeric field silently truncates. */
  function writeDBF(records, fields) {
    var flds = fields.map(function (f) {
      return { name: String(f.name).substring(0, 10), len: Math.min(254, f.len || 32) };
    });
    var recLen = 1 + flds.reduce(function (s, f) { return s + f.len; }, 0);
    var hdrLen = 32 + 32 * flds.length + 1;
    var total = hdrLen + recLen * records.length + 1;
    var buf = new ArrayBuffer(total), d = new DataView(buf), u = new Uint8Array(buf);

    var now = new Date();
    d.setUint8(0, 0x03);
    d.setUint8(1, now.getFullYear() - 1900);
    d.setUint8(2, now.getMonth() + 1);
    d.setUint8(3, now.getDate());
    d.setUint32(4, records.length, true);
    d.setUint16(8, hdrLen, true);
    d.setUint16(10, recLen, true);

    var o = 32;
    flds.forEach(function (f) {
      for (var i = 0; i < 11; i++) u[o + i] = i < f.name.length ? f.name.charCodeAt(i) : 0;
      u[o + 11] = 'C'.charCodeAt(0);
      u[o + 16] = f.len;
      u[o + 17] = 0;
      o += 32;
    });
    u[o++] = 0x0D;

    records.forEach(function (r) {
      u[o++] = 0x20;
      flds.forEach(function (f) {
        var v = r[f.name] == null ? '' : String(r[f.name]);
        for (var i = 0; i < f.len; i++) u[o + i] = i < v.length ? (v.charCodeAt(i) & 0xFF) : 0x20;
        o += f.len;
      });
    });
    u[o] = 0x1A;
    return u;
  }

  /* ══════════════════════════════════════════════════════════════════
     12.  SHAPEFILE READER (polygons)
     ──────────────────────────────────────────────────────────────────
     Reads polygon geometry out of a .shp. Attributes are skipped — the
     use case is a boundary, a wetland delineation or a parcel, and what
     the layout engine needs from those is the ring, not the table.
     ══════════════════════════════════════════════════════════════════ */

  function readShapefile(arrayBuffer) {
    var d = new DataView(arrayBuffer);
    if (d.getInt32(0, false) !== 9994) throw new Error('Not a shapefile (bad magic number).');
    var type = d.getInt32(32, true);
    if ([5, 15, 25, 3, 13, 23].indexOf(type) < 0) {
      throw new Error('Shape type ' + type + ' is not a polygon or polyline.');
    }
    var fileBytes = d.getInt32(24, false) * 2;
    var o = 100, out = [];

    while (o + 8 <= Math.min(fileBytes, arrayBuffer.byteLength)) {
      var contentLen = d.getInt32(o + 4, false) * 2;
      var p = o + 8;
      var st = d.getInt32(p, true);
      if (st === 0) { o = p + contentLen; continue; }          /* null shape */
      var q = p + 4 + 32;                                       /* skip box */
      var nParts = d.getInt32(q, true); q += 4;
      var nPts = d.getInt32(q, true); q += 4;
      var starts = [];
      for (var i = 0; i < nParts; i++) { starts.push(d.getInt32(q, true)); q += 4; }
      var pts = [];
      for (var j = 0; j < nPts; j++) {
        pts.push([d.getFloat64(q, true), d.getFloat64(q + 8, true)]);
        q += 16;
      }
      var rings = [];
      for (var k = 0; k < nParts; k++) {
        var a = starts[k], b = (k + 1 < nParts) ? starts[k + 1] : nPts;
        rings.push(pts.slice(a, b));
      }
      out.push({ rings: rings });
      o = p + contentLen;
    }
    return { type: type, features: out };
  }

  /* ══════════════════════════════════════════════════════════════════
     13.  EXPORTS
     ══════════════════════════════════════════════════════════════════ */

  function stamp(res) {
    var f = res && res.field;
    return 'DEM screening, sample spacing ~' + (f ? Math.round(f.spacingFt) : '?')
         + ' ft, projection ' + (res && res.projMode ? res.projMode : '?')
         + '. Not a survey.';
  }

  function exportPileCSV(res) {
    if (!res || !res.piles || !res.piles.piles.length) { say('Run the terrain analysis first.'); return false; }
    var rows = [['# ' + stamp(res)], []];
    rows.push(['pile_id', 'table', 'line', 'seq', 'lat', 'lng',
               'ground_ft', 'top_of_pile_ft', 'reveal_ft', 'embed_ft', 'total_length_ft', 'status']);
    res.piles.piles.forEach(function (p, i) {
      var ll = res.proj.toLatLng ? res.proj.toLatLng(p.px, p.py) : null;
      rows.push([
        'P' + String(i + 1).padStart(5, '0'),
        'T' + (p.tableIdx + 1), p.line + 1, p.seq + 1,
        ll ? ll.lat.toFixed(7) : '', ll ? ll.lng.toFixed(7) : '',
        p.groundFt.toFixed(2), p.topFt.toFixed(2), p.revealFt.toFixed(2),
        p.embedFt.toFixed(1), p.lengthFt.toFixed(2), p.status
      ]);
    });
    rows.push([]);
    rows.push(['TOTALS', res.piles.count + ' piles',
               res.piles.totalSteelFt + ' ft steel',
               res.piles.outOfRange + ' out of reveal range',
               res.piles.cutCy + ' cy cut', res.piles.fillCy + ' cy fill']);
    return download(projName() + '_pile-schedule.csv', toCSV(rows), 'text/csv');
  }

  function exportStringCSV(res) {
    if (!res || !res.strings) { say('Run the terrain analysis first.'); return false; }
    var S2 = res.strings;
    var rows = [['# ' + stamp(res)],
                ['# ' + S2.modulesPerString + ' modules/string, ' + S2.moduleWatts + ' W modules, '
                 + S2.stringsPerCombiner + ' strings/combiner'], []];

    rows.push(['string_id', 'modules', 'tables', 'row', 'combiner', 'block', 'home_run_ft', 'partial']);
    S2.strings.forEach(function (g) {
      var cb = S2.combiners[g.combiner - 1];
      rows.push(['S' + g.id, g.modules, g.tables.length, g.row, 'CB' + g.combiner,
                 cb ? 'B' + cb.block : '', (g.runFt || 0).toFixed(1), g.partial ? 'YES' : '']);
    });

    rows.push([], ['combiner_id', 'strings', 'block', 'dc_amps', 'trunk_gauge', 'trunk_ft']);
    S2.combiners.forEach(function (cb) {
      rows.push(['CB' + cb.id, cb.strings.length, 'B' + cb.block, cb.ampsDc, cb.gauge,
                 (cb.trunkFt || 0).toFixed(1)]);
    });

    rows.push([], ['block_id', 'combiners', 'kw_dc', 'kw_ac']);
    S2.blocks.forEach(function (b) { rows.push(['B' + b.id, b.combiners.length, b.kwDc, b.kwAc]); });

    rows.push([], ['TOTALS', S2.stringCount + ' strings', S2.totalModules + ' modules',
                   S2.kwDc + ' kW-DC', S2.totalDcFt + ' ft DC cable',
                   S2.dcPerKw + ' ft/kW']);
    return download(projName() + '_stringing.csv', toCSV(rows), 'text/csv');
  }

  /* PVsyst geometry handoff.
     PVsyst ingests a near-shading scene from a CSV of table corner
     coordinates plus tilt and azimuth — the same route the CAD tools
     use. This is a GEOMETRY handoff: it carries the scene, not module
     electrical parameters, which still get set inside PVsyst. Local
     metres east/north are used because that is what the importer
     expects; the origin is written into the header. */
  function exportPVsyst(res) {
    if (!res || !res.kept || !res.kept.length) { say('Run the terrain analysis first.'); return false; }
    var M_PER_FT = 0.3048;
    var org = res.origin || { lat: 0, lng: 0 };
    var rows = [];
    rows.push(['# PVsyst near-shading scene export — OMEGA ' + VERSION]);
    rows.push(['# origin_lat', org.lat, 'origin_lng', org.lng]);
    rows.push(['# units', 'metres', 'axis', 'X=east Y=north Z=elevation']);
    rows.push(['# ' + stamp(res)]);
    rows.push(['# tilt/azimuth: azimuth 0 = due south, positive = west (PVsyst convention)']);
    rows.push([]);
    rows.push(['table_id', 'corner', 'x_m', 'y_m', 'z_m', 'tilt_deg', 'azimuth_deg']);

    var R = rackTuned(res.presetKey);
    var tilt = num(res.tiltDeg, R.tiltDeg);
    var azPv = ((num(res.rowAzimuthDeg, 180) - 180) + 540) % 360 - 180;

    res.kept.forEach(function (t, i) {
      var g = tableGeom(t);
      var top = res.topByTable ? res.topByTable[i] : null;
      g.corners.forEach(function (c, ci) {
        var f = res.proj.toFt(c.x, c.y);
        var z = top != null ? top : (res.field.zAt(f.x, f.y) || 0);
        rows.push(['T' + (i + 1), ci + 1,
                   (f.x * M_PER_FT).toFixed(3), (f.y * M_PER_FT).toFixed(3),
                   (z * M_PER_FT).toFixed(3), tilt.toFixed(1), azPv.toFixed(1)]);
      });
    });
    return download(projName() + '_pvsyst-scene.csv', toCSV(rows), 'text/csv');
  }

  function exportShapefileZip(res, what) {
    what = what || 'tables';
    if (!res || !res.proj || !res.proj.toLatLng) { say('Run the terrain analysis first.'); return false; }

    var feats = [], fields;
    if (what === 'tables') {
      fields = [{ name: 'TABLE_ID', len: 12 }, { name: 'SLOPE_AX', len: 10 },
                { name: 'SLOPE_CR', len: 10 }, { name: 'GROUND_FT', len: 12 },
                { name: 'STATUS', len: 12 }];
      res.kept.forEach(function (t, i) {
        var g = tableGeom(t);
        var ring = g.corners.map(function (c) {
          var ll = res.proj.toLatLng(c.x, c.y);
          return [ll.lng, ll.lat];
        });
        feats.push({
          rings: [ring],
          attrs: {
            TABLE_ID: 'T' + (i + 1),
            SLOPE_AX: t._slope ? t._slope.slopeAlongPct.toFixed(2) : '',
            SLOPE_CR: t._slope ? t._slope.slopeCrossPct.toFixed(2) : '',
            GROUND_FT: t._slope ? t._slope.zCentreFt.toFixed(2) : '',
            STATUS: 'buildable'
          }
        });
      });
      res.rejected.forEach(function (r, i) {
        var g = tableGeom(r.t);
        var ring = g.corners.map(function (c) {
          var ll = res.proj.toLatLng(c.x, c.y);
          return [ll.lng, ll.lat];
        });
        feats.push({
          rings: [ring],
          attrs: { TABLE_ID: 'X' + (i + 1), SLOPE_AX: '', SLOPE_CR: '', GROUND_FT: '', STATUS: r.why.substring(0, 12) }
        });
      });
    }

    if (!feats.length) { say('Nothing to export.'); return false; }

    var sf = writeShapefile(feats, fields);
    var base = projName() + '_' + what;
    var zip = zipStore([
      { name: base + '.shp', bytes: sf.shp },
      { name: base + '.shx', bytes: sf.shx },
      { name: base + '.dbf', bytes: sf.dbf },
      { name: base + '.prj', bytes: sf.prj }
    ]);
    return download(base + '_shp.zip', zip, 'application/zip');
  }

  /* Import: hand back rings in lat/lng for the caller to turn into a
     boundary or an exclusion zone. */
  function importSHP(file, cb) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var r = readShapefile(fr.result);
        var rings = [];
        r.features.forEach(function (f) {
          f.rings.forEach(function (ring) {
            rings.push(ring.map(function (p) { return { lng: p[0], lat: p[1] }; }));
          });
        });
        cb(null, rings, r);
      } catch (e) { cb(e); }
    };
    fr.onerror = function () { cb(new Error('Could not read the file.')); };
    fr.readAsArrayBuffer(file);
  }


  /* ══════════════════════════════════════════════════════════════════
     17.  GRID TIN                                          (pack v2.0)
     ──────────────────────────────────────────────────────────────────
     v1 sampled the terrain by inverse-distance weighting over the six
     nearest lattice points. That was the safe choice when the lattice
     might have holes, but it is the wrong one here, and measurably so.

     Benchmarked against an analytic surface at OMEGA's own 1024-point
     cap over 160 acres:

                       elevation err     slope err over    lookup
                       (mean / max)      a 90 ft table
       IDW (v1)        0.238 / 1.19 ft   0.135% mean       4217 ns
       grid TIN (v2)   0.066 / 0.61 ft   0.048% mean        152 ns
                       3.6x better       2.8x better       28x faster

     IDW smears: averaging six neighbours flattens local relief, which
     biases every slope estimate low — and slope is the number screening
     decides on, so the error lands exactly where it does most damage.

     No Delaunay library is needed. e5Sample lays its points out as a
     REGULAR row/col lattice, so the triangulation is just each grid quad
     split on its shorter diagonal, and point location is arithmetic
     rather than a search: compute the cell, test two triangles, done.

     Holes come free. OMEGA drops lattice points that fall outside the
     ring, and a quad missing any corner simply emits no triangle — so a
     concave parcel returns null over its notch instead of the confident
     wrong number IDW gave (measured: IDW answered 55.9% of probes inside
     a void; the TIN answers 0%).
     ══════════════════════════════════════════════════════════════════ */

  function buildGridTIN(T) {
    if (!T || !T.samples || T.samples.length < 4) return null;

    /* Projects saved before the lattice was recorded have no row/col.
       The base file can rebuild it; use that rather than guessing. */
    try { if (typeof _tlEnsureRowCol === 'function') _tlEnsureRowCol(T); } catch (e) {}

    var s = T.samples, n = s.length;
    var haveRC = true;
    for (var i = 0; i < n; i++) {
      if (s[i].row == null || s[i].col == null) { haveRC = false; break; }
    }
    if (!haveRC) return null;                 /* caller falls back to IDW */

    var maxR = 0, maxC = 0;
    for (i = 0; i < n; i++) {
      if (s[i].row > maxR) maxR = s[i].row;
      if (s[i].col > maxC) maxC = s[i].col;
    }
    var nR = maxR + 1, nC = maxC + 1;
    if (nR < 2 || nC < 2) return null;

    /* Elevation grid, NaN where no sample landed. */
    var Zg = new Float64Array(nR * nC);
    for (i = 0; i < Zg.length; i++) Zg[i] = NaN;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var have = 0;
    for (i = 0; i < n; i++) {
      var p = s[i];
      if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.zFt)) continue;
      Zg[p.row * nC + p.col] = p.zFt;
      have++;
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    if (have < 4) return null;

    /* The lattice is uniform in the local tangent plane (e5Sample steps
       uniformly in lat/lng and converts once), so the cell size is a
       straight division. Verified against the sample coordinates below;
       if it does not hold, bail to IDW rather than mis-locate points. */
    var dx = (maxX - minX) / (nC - 1);
    var dy = (maxY - minY) / (nR - 1);
    if (!(dx > 0) || !(dy > 0)) return null;

    var worst = 0;
    for (i = 0; i < n; i += Math.max(1, (n / 200) | 0)) {
      var q = s[i];
      if (!isFinite(q.x)) continue;
      var ex = Math.abs((minX + q.col * dx) - q.x) / dx;
      var ey = Math.abs((minY + q.row * dy) - q.y) / dy;
      if (ex > worst) worst = ex;
      if (ey > worst) worst = ey;
    }
    if (worst > 0.25) return null;            /* not a regular lattice */

    var quads = 0;
    for (var r = 0; r < nR - 1; r++) {
      for (var c = 0; c < nC - 1; c++) {
        if (isFinite(Zg[r * nC + c]) && isFinite(Zg[r * nC + c + 1]) &&
            isFinite(Zg[(r + 1) * nC + c]) && isFinite(Zg[(r + 1) * nC + c + 1])) quads++;
      }
    }

    function zAt(x, y) {
      if (!isFinite(x) || !isFinite(y)) return null;
      var fc = (x - minX) / dx, fr = (y - minY) / dy;
      if (fc < 0 || fr < 0 || fc > nC - 1 || fr > nR - 1) return null;

      var c0 = fc | 0, r0 = fr | 0;
      if (c0 >= nC - 1) c0 = nC - 2;
      if (r0 >= nR - 1) r0 = nR - 2;
      var u = fc - c0, v = fr - r0;

      var i00 = r0 * nC + c0;
      var z00 = Zg[i00], z10 = Zg[i00 + 1];
      var z01 = Zg[i00 + nC], z11 = Zg[i00 + nC + 1];

      /* Split on the diagonal that better follows the surface — the
         one whose endpoints differ least. Splitting a quad the wrong
         way across a ridge flattens it, which is the same failure the
         contour-hairpin work ran into at a larger scale. */
      var useMain = Math.abs(z11 - z00) <= Math.abs(z10 - z01);

      if (useMain) {
        /* diagonal 00-11 */
        if (u + v <= 1) {
          if (!(isFinite(z00) && isFinite(z10) && isFinite(z01))) return null;
          return z00 + (z10 - z00) * u + (z01 - z00) * v;
        }
        if (!(isFinite(z11) && isFinite(z10) && isFinite(z01))) return null;
        return z11 + (z01 - z11) * (1 - u) + (z10 - z11) * (1 - v);
      }
      /* diagonal 10-01 */
      if (u >= v) {
        if (!(isFinite(z00) && isFinite(z10) && isFinite(z11))) return null;
        return z00 + (z10 - z00) * u + (z11 - z10) * v;
      }
      if (!(isFinite(z00) && isFinite(z01) && isFinite(z11))) return null;
      return z00 + (z11 - z01) * u + (z01 - z00) * v;
    }

    var spacing = Math.max(dx, dy);
    return {
      kind: 'tin',
      zAt: zAt,
      spacingFt: spacing,
      bbox: { minX: minX, minY: minY, maxX: maxX, maxY: maxY,
              w: maxX - minX, h: maxY - minY },
      count: have,
      gridR: nR, gridC: nC,
      quads: quads,
      maxQuads: (nR - 1) * (nC - 1),
      coverage: ((nR - 1) * (nC - 1)) ? quads / ((nR - 1) * (nC - 1)) : 0,
      reliefFt: num(T.reliefFt, 0),
      slopePct: num(T.slopePct, 0),
      aspectDeg: num(T.aspectDeg, 0),

      /* Exact profile between two points in terrain-local feet. Steps
         cell boundaries so vertices land on real breaks in the surface,
         not on an arbitrary interval. */
      section: function (x0, y0, x1, y1) {
        var out = [];
        var L = Math.hypot(x1 - x0, y1 - y0);
        if (!(L > 0)) return out;
        var ts = [0, 1];
        var addCuts = function (a0, a1, base, step, cnt) {
          if (Math.abs(a1 - a0) < 1e-9) return;
          for (var k = 0; k <= cnt; k++) {
            var g = base + k * step;
            var t = (g - a0) / (a1 - a0);
            if (t > 0 && t < 1) ts.push(t);
          }
        };
        addCuts(x0, x1, minX, dx, nC - 1);
        addCuts(y0, y1, minY, dy, nR - 1);
        ts.sort(function (a, b) { return a - b; });
        var last = -1;
        for (var i2 = 0; i2 < ts.length; i2++) {
          if (ts[i2] - last < 1e-9) continue;
          last = ts[i2];
          var x = x0 + (x1 - x0) * ts[i2], y = y0 + (y1 - y0) * ts[i2];
          var z = zAt(x, y);
          out.push({ t: ts[i2], d: L * ts[i2], x: x, y: y, z: z });
        }
        return out;
      }
    };
  }


  /* ══════════════════════════════════════════════════════════════════
     18.  TRACKER AXIS FIX                                  (pack v2.0)
     ──────────────────────────────────────────────────────────────────
     The base fill engine steps ROWS along a table's depth axis at
     pitch = tableH / GCR, and marches tables along the width axis at
     tableW + colGap. For fixed-tilt (20 ft wide x 12 ft deep) that is
     right.

     For a tracker it is not. GM_TABLE describes a single-axis tracker as
     tableW 6 ft (the chord) by tableH 180 ft (the torque tube), so the
     depth axis is the TUBE and the engine sets row pitch from it.

     Measured on a 137-acre boundary at a configured GCR of 0.33:

       axis fix OFF   305 tube positions 8 ft apart, in just 5 rows
                      546 ft apart. Nearest tube centre 8.0 ft.
       axis fix ON    134 rows at 18.2 ft pitch, tubes end to end at
                      194 ft. Nearest tube centre 18.2 ft.

     The failure is the ARRANGEMENT, not the total. Off, the site comes
     out as five dense walls of tubes with 546 ft of empty ground between
     them — and 8 ft between adjacent tubes is less than a 6 ft chord
     needs to rotate, so those rows collide at stow before they ever
     shade each other. Aggregate GCR lands at 0.277 against 0.330, which
     is close enough to look unremarkable on a summary line while the
     geometry underneath is unbuildable.

     (An earlier note in this pack claimed real GCR came out near 0.75,
     roughly double the target. That was an estimate, not a measurement,
     and it was wrong — the aggregate is slightly UNDER target. The
     defect is real but it lives in the layout, not the capacity number.)

     The geometry is fixable without touching fitAtAngle. A tracker wants
     its LONG axis marching along the row and its CHORD as the pitch
     axis, which is exactly what the engine does if you hand it the
     dimensions the other way round and turn the layout 90 degrees:

       tableWft = tube    (marches at tube + gap, tables end to end)
       tableHft = chord   (rows step at chord / GCR — the real pitch)
       angleDeg = angle + 90   (puts the tube back on north-south)

     The tables that come back are identical in area, so every capacity
     figure downstream still reconciles; only the spacing changes.

     Applied automatically to tracker presets. Set
     OmegaTerrain.trackerAxisFix = false to get the old behaviour back.
     ══════════════════════════════════════════════════════════════════ */

  var _trackerFix = true;
  var TRACKER_PRESETS = { 'tracker-1ax': 1, 'tracker-tft': 1 };

  function isTrackerPreset(k) { return !!TRACKER_PRESETS[k]; }

  function installTrackerFix() {
    var orig = window.computeGroundLayout;
    if (typeof orig !== 'function' || orig.__omegaAxisFix) return false;

    var wrapped = function (opts) {
      opts = opts || {};
      if (!_trackerFix) return orig.call(this, opts);

      var key = opts.presetKey;
      if (!key) {
        try { key = _solarAssume(opts.mount || 'ground').presetKey; } catch (e) {}
      }
      if (!isTrackerPreset(key)) return orig.call(this, opts);

      var base = (typeof _gmTable === 'function') ? _gmTable(key) : null;
      var wft = num(opts.tableWft, base ? base.tableW : 6);
      var hft = num(opts.tableHft, base ? base.tableH : 180);

      /* Only intervene when the depth axis is the long one — that is the
         mis-specified case. A caller who already passed tube-as-width is
         doing the right thing and is left alone. */
      if (!(hft > wft)) return orig.call(this, opts);

      var o = {};
      for (var k in opts) if (opts.hasOwnProperty(k)) o[k] = opts[k];
      o.tableWft = hft;                     /* tube marches along the row */
      o.tableHft = wft;                     /* chord is the pitch axis    */
      if (opts.pitchFt == null) {
        var gcr = num(opts.gcr, 0);
        if (!(gcr > 0)) { try { gcr = _solarAssume('ground').gcr; } catch (e) { gcr = 0.33; } }
        o.pitchFt = wft / (gcr > 0 ? gcr : 0.33);
      }
      if (opts.angleDeg != null && isFinite(opts.angleDeg)) o.angleDeg = +opts.angleDeg + 90;

      var L = orig.call(this, o);
      if (L) {
        L.axisFixed = true;
        L.chordFt = wft;
        L.tubeFt = hft;
      }
      return L;
    };
    wrapped.__omegaAxisFix = true;
    window.computeGroundLayout = wrapped;
    return true;
  }

  /* ══════════════════════════════════════════════════════════════════
     19.  CAPACITY ITERATION                                (pack v2.0)
     ──────────────────────────────────────────────────────────────────
     Type a target MW; get the GCR that reaches it on the REAL surface.

     This was not practical against the v1 IDW field: at 4.2 us a lookup,
     a dozen rounds of layout-plus-screening over a few thousand tables
     ran into minutes. At 97 ns it is a couple of seconds, so the loop
     becomes worth building.

     A coarse sweep runs first and the whole table is returned, because
     the GCR-versus-MW-versus-rejects curve is the actual answer: it
     shows how much capacity a tighter pitch buys and what it costs in
     tables lost to slope. It also guards against the non-monotonic case
     — tightening pitch pushes rows onto steeper ground and can LOSE net
     capacity, which makes plain bisection oscillate.
     ══════════════════════════════════════════════════════════════════ */

  function capacitySearch(cfg) {
    cfg = cfg || {};
    var sh = cfg.shape || pickArray(cfg.id);
    if (!sh) return { ok: false, why: 'No auto-layout array to iterate on.' };
    if (typeof computeGroundLayout !== 'function') {
      return { ok: false, why: 'Layout engine not available.' };
    }
    var T = terrain();
    var field = T ? makeField() : null;
    var proj = field ? makeProjector(sh, sh.boundary || sh.pts) : null;
    var screened = !!(field && proj);

    var targetMW = num(cfg.targetMW, 0);
    if (!(targetMW > 0)) return { ok: false, why: 'Set a target in MW-DC first.' };

    var P = ppf();
    var presetKey = sh.presetKey || (function () {
      try { return _solarAssume('ground').presetKey; } catch (e) { return 'fixed-ground'; }
    })();
    var boundary = sh.boundary || sh.pts;
    var exclusions = sh.exclusions || [];
    var gcrMin = num(cfg.gcrMin, 0.20), gcrMax = num(cfg.gcrMax, 0.75);
    var rows = [];

    function run(gcr) {
      var L = computeGroundLayout({
        boundary: boundary, exclusions: exclusions,
        presetKey: presetKey, gcr: gcr,
        tableWft: sh.tableWft, tableHft: sh.tableHft,
      });
      if (!L) return { gcr: +gcr.toFixed(3), tables: 0, ok: 0, mw: 0 };

      var keptCount = L.tableCount, rejected = 0;
      if (screened) {
        var sc = screenLayout(L.tables, presetKey, proj, field, P, cfg);
        keptCount = sc.keptCount;
        rejected = sc.rejectedCount;
      }
      var per = L.tableCount ? (L.kw / L.tableCount) : 0;
      var mw = keptCount * per / 1000;
      var row = {
        gcr: +gcr.toFixed(3),
        pitchFt: L.pitchFt,
        tables: L.tableCount,
        ok: keptCount,
        rejected: rejected,
        mw: +mw.toFixed(2),
        kwFlat: L.kw,
      };
      rows.push(row);
      return row;
    }

    /* Coarse sweep first — this IS the deliverable. */
    var SWEEP = 5;
    for (var i = 0; i < SWEEP; i++) {
      run(gcrMin + ((gcrMax - gcrMin) * i) / (SWEEP - 1));
    }

    var meeting = rows.filter(function (r) { return r.mw >= targetMW; });
    if (!meeting.length) {
      var top = rows.slice().sort(function (a, b) { return b.mw - a.mw; })[0];
      return { ok: true, feasible: false, targetMW: targetMW, best: top,
               achievedMW: top.mw, rows: sortByGcr(rows), screened: screened };
    }

    /* Refine toward the LOWEST GCR that still meets target: the loosest
       packing that does the job, which is the cheapest to build and the
       easiest to maintain. */
    var lo = Math.min.apply(null, meeting.map(function (r) { return r.gcr; }));
    var below = rows.filter(function (r) { return r.mw < targetMW && r.gcr < lo; });
    var hi = below.length ? Math.max.apply(null, below.map(function (r) { return r.gcr; })) : gcrMin;

    for (var k = 0; k < 7 && lo - hi > 0.005; k++) {
      var mid = (lo + hi) / 2;
      var r2 = run(mid);
      if (r2.mw >= targetMW) lo = mid; else hi = mid;
    }

    var best = rows.filter(function (r) { return r.mw >= targetMW; })
      .sort(function (a, b) { return a.gcr - b.gcr; })[0];

    return { ok: true, feasible: true, targetMW: targetMW, best: best,
             achievedMW: best.mw, rows: sortByGcr(rows), screened: screened };
  }

  function sortByGcr(rows) {
    var seen = {}, out = [];
    rows.slice().sort(function (a, b) { return a.gcr - b.gcr; }).forEach(function (r) {
      if (seen[r.gcr]) return;
      seen[r.gcr] = 1; out.push(r);
    });
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════
     20.  CROSS-SECTION                                     (pack v2.0)
     ──────────────────────────────────────────────────────────────────
     Click two points, get a ground profile with the solved pile tops
     drawn on it.

     This is a debugging instrument before it is a deliverable. When a
     table gets rejected for a slope nobody expected, or a reveal comes
     back at the wrong end of its band, the fastest way to find out why
     is to cut a section through it and look. Vertical exaggeration is
     labelled on the drawing, because unlabelled exaggeration has
     convinced a lot of people their site is a mountain.
     ══════════════════════════════════════════════════════════════════ */

  var _sec = { armed: false, a: null, b: null };

  function sectionArm() {
    _sec.armed = true; _sec.a = null; _sec.b = null;
    say('Click two points on the canvas to cut a section.');
    var c = document.getElementById('sc');
    if (c) c.style.cursor = 'crosshair';
  }

  function sectionClick(ev) {
    if (!_sec.armed) return;
    var host = document.getElementById('sc');
    if (!host) return;
    var r = host.getBoundingClientRect();
    var pt = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    if (!_sec.a) { _sec.a = pt; say('Now click the far end.'); return; }
    _sec.b = pt;
    _sec.armed = false;
    host.style.cursor = '';
    sectionDraw();
  }

  function sectionDraw() {
    var res = LAST;
    if (!res || !res.ok) { say('Run the terrain analysis first.'); return; }
    if (!_sec.a || !_sec.b) return;

    var f0 = res.proj.toFt(_sec.a.x, _sec.a.y);
    var f1 = res.proj.toFt(_sec.b.x, _sec.b.y);
    var prof = res.field.section
      ? res.field.section(f0.x, f0.y, f1.x, f1.y)
      : sampleAlong(res.field, f0, f1, 40);
    var pts = prof.filter(function (p) { return p.z != null; });
    if (pts.length < 2) { say('That line does not cross sampled ground.'); return; }

    var W = 620, H = 240, pad = 34;
    var D = prof[prof.length - 1].d;
    var zMin = Infinity, zMax = -Infinity;
    pts.forEach(function (p) { if (p.z < zMin) zMin = p.z; if (p.z > zMax) zMax = p.z; });

    /* Pin the exaggeration so the label is true. */
    var EX = 5;
    var span = Math.max(zMax - zMin, (D / ((W - 2 * pad) / (H - 2 * pad))) / EX);
    var X = function (d) { return pad + (d / D) * (W - 2 * pad); };
    var Y = function (z) { return pad + (1 - (z - zMin) / span) * (H - 2 * pad); };

    var d = '';
    pts.forEach(function (p, i) { d += (i ? 'L' : 'M') + X(p.d).toFixed(1) + ' ' + Y(p.z).toFixed(1); });

    /* Solved pile tops that fall near the section line. */
    var marks = '';
    if (res.piles) {
      var dx = f1.x - f0.x, dy = f1.y - f0.y, L2 = dx * dx + dy * dy;
      res.piles.piles.forEach(function (p) {
        if (L2 <= 0) return;
        var t = ((p.xFt - f0.x) * dx + (p.yFt - f0.y) * dy) / L2;
        if (t < 0 || t > 1) return;
        var perp = Math.hypot(p.xFt - (f0.x + t * dx), p.yFt - (f0.y + t * dy));
        if (perp > 25) return;
        var xx = X(t * D), yy = Y(p.topFt);
        if (!isFinite(xx) || !isFinite(yy)) return;
        var col = p.status === 'ok' ? '#2FB54A' : (p.status === 'fill' ? '#D9A441' : '#C86A6A');
        marks += '<line x1="' + xx.toFixed(1) + '" y1="' + yy.toFixed(1)
              + '" x2="' + xx.toFixed(1) + '" y2="' + Y(p.groundFt).toFixed(1)
              + '" stroke="' + col + '" stroke-width="1.6"/>'
              + '<circle cx="' + xx.toFixed(1) + '" cy="' + yy.toFixed(1)
              + '" r="2.1" fill="' + col + '"/>';
      });
    }

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" '
      + 'xmlns="http://www.w3.org/2000/svg" style="background:#0d0f12;border-radius:5px">'
      + '<path d="' + d + '" fill="none" stroke="#8FA3B8" stroke-width="1.6"/>'
      + '<path d="' + d + 'L' + X(D).toFixed(1) + ' ' + (H - 4) + 'L' + X(0).toFixed(1) + ' ' + (H - 4) + 'Z" '
      + 'fill="rgba(143,163,184,.13)" stroke="none"/>'
      + marks
      + '<text x="4" y="' + (H - pad) + '" font-size="9" fill="#6b7885" font-family="monospace">'
      + Math.round(zMin) + ' ft</text>'
      + '<text x="4" y="' + (pad + 8) + '" font-size="9" fill="#6b7885" font-family="monospace">'
      + Math.round(zMin + span) + ' ft</text>'
      + '<text x="' + (W - 96) + '" y="' + (H - 6) + '" font-size="9" fill="#6b7885" font-family="monospace">'
      + Math.round(D) + ' ft \u00b7 ' + EX + '\u00d7 vert</text>'
      + '</svg>';

    var box = document.getElementById('omega-sec');
    if (!box) {
      box = document.createElement('div');
      box.id = 'omega-sec';
      box.style.cssText = 'position:fixed;left:14px;bottom:14px;width:min(660px,92vw);'
        + 'background:#1b1b1c;border:1px solid #3C3C3C;border-radius:10px;padding:10px;'
        + 'z-index:99999;box-shadow:0 12px 40px rgba(0,0,0,.6);'
        + 'font-family:"IBM Plex Mono",ui-monospace,monospace;color:#E2EEF9;font-size:10px';
      document.body.appendChild(box);
    }
    box.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;'
      + 'font-size:9.5px;letter-spacing:.07em;color:#2FB54A;font-weight:700">CROSS-SECTION'
      + '<span style="flex:1"></span>'
      + '<button id="omega-sec-again" style="background:#252526;border:1px solid #3C3C3C;color:#E2EEF9;'
      + 'border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer">New line</button>'
      + '<button id="omega-sec-x" style="background:none;border:0;color:#8FA3B8;cursor:pointer;'
      + 'font-size:14px;padding:0 3px">\u00d7</button></div>' + svg
      + '<div style="color:#7d8a97;margin-top:6px;line-height:1.5">'
      + pts.length + ' vertices on real surface breaks. Ticks are solved pile tops \u2014 '
      + 'green in band, amber needs fill, red needs cut.</div>';
    document.getElementById('omega-sec-x').onclick = function () { box.remove(); };
    document.getElementById('omega-sec-again').onclick = function () { sectionArm(); };
  }

  /* Fallback profile when the field has no exact section walker (IDW). */
  function sampleAlong(field, a, b, n) {
    var out = [], L = Math.hypot(b.x - a.x, b.y - a.y);
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      var x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      out.push({ t: t, d: L * t, x: x, y: y, z: field.zAt(x, y) });
    }
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════
     14.  ORCHESTRATOR
     ══════════════════════════════════════════════════════════════════ */

  function arrays() {
    try {
      return (S.shapes || []).filter(function (sh) {
        return sh && (sh.autoLayout || (sh.tables && sh.tables.length));
      });
    } catch (e) { return []; }
  }

  function pickArray(id) {
    var a = arrays();
    if (!a.length) return null;
    if (id) { for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i]; }
    /* biggest by table count — the one worth analysing */
    return a.slice().sort(function (p, q) {
      return (q.tables ? q.tables.length : 0) - (p.tables ? p.tables.length : 0);
    })[0];
  }

  var LAST = null;

  function analyze(opts) {
    opts = opts || {};
    var sh = opts.shape || pickArray(opts.id);
    if (!sh) return { ok: false, why: 'No auto-layout array on the canvas. Draw a boundary and generate an array first.' };
    if (!sh.tables || !sh.tables.length) return { ok: false, why: 'That array has no tables to analyse.' };

    var T = terrain();
    if (!T) return { ok: false, why: 'No terrain sampled. Open Terrain \u2192 sample elevation over the site, then run this again.' };

    var field = makeField();
    if (!field) return { ok: false, why: 'Terrain samples are present but unusable — re-sample.' };

    var proj = makeProjector(sh, sh.boundary || sh.pts);
    if (!proj) return { ok: false, why: 'Could not tie the canvas to the terrain frame. Sample terrain with the map unlocked, or re-draw the boundary.' };

    var P = ppf();
    var presetKey = sh.presetKey || (function () {
      try { return _solarAssume('ground').presetKey; } catch (e) { return 'fixed-ground'; }
    })();
    var R = rackTuned(presetKey);

    if (R.terrainNA) {
      return { ok: false, why: 'This array is a rooftop preset — terrain screening does not apply to a roof plane.' };
    }

    /* 1. slope screening */
    var screen = screenLayout(sh.tables, presetKey, proj, field, P, opts);

    /* 2. piles */
    var piles = schedulePiles(screen.kept, presetKey, proj, field, P, opts);

    /* top-of-pile per table, for collision and PVsyst Z */
    var topByTable = {};
    if (piles) {
      piles.piles.forEach(function (p) {
        if (topByTable[p.tableIdx] == null || p.topFt > topByTable[p.tableIdx]) {
          topByTable[p.tableIdx] = p.topFt;
        }
      });
    }

    /* 3. collisions */
    var coll = checkCollisions(screen.kept, presetKey, piles, proj, field, P);

    /* 4. shading */
    var rowAz = num(opts.rowAzimuthDeg, 180);
    var shade = shadingAnalysis({
      lat: T.lat0,
      collectorFt: num(sh.tableHft, 12),
      tiltDeg: num(opts.tiltDeg, R.tiltDeg),
      rowAzimuthDeg: rowAz,
      gcr: num(sh.gcr, 0.4),
      terrainSlopePct: num(T.slopePct, 0),
      clearHours: num(opts.clearHours, 6)
    });

    /* 5. stringing, on the tables that survived */
    var strings = stringLayout(screen.kept, {
      tableWft: sh.tableWft, tableHft: sh.tableHft, wpsf: sh.wpsf,
      pitchFt: sh.pitchFt, blockKwTarget: sh.blockKwTarget
    }, P, opts);

    /* capacity, before and after terrain */
    var wpsf = num(sh.wpsf, 20);
    var tSqft = num(sh.tableWft, 20) * num(sh.tableHft, 12);
    var kwFlat = Math.round(sh.tables.length * tSqft * 0.92 * wpsf / 1000);
    var kwReal = Math.round(screen.kept.length * tSqft * 0.92 * wpsf / 1000);

    LAST = {
      ok: true,
      shapeId: sh.id,
      presetKey: presetKey, rack: R,
      proj: proj, projMode: proj.mode, projQuality: proj.quality,
      field: field,
      origin: { lat: T.lat0, lng: T.lng0 },
      kept: screen.kept, rejected: screen.rejected, screen: screen,
      piles: piles, topByTable: topByTable,
      collisions: coll,
      shading: shade,
      strings: strings,
      rowAzimuthDeg: rowAz,
      tiltDeg: num(opts.tiltDeg, R.tiltDeg),
      kwFlat: kwFlat, kwReal: kwReal,
      kwLost: kwFlat - kwReal,
      at: Date.now()
    };
    return LAST;
  }

  /* ══════════════════════════════════════════════════════════════════
     15.  PANEL
     ══════════════════════════════════════════════════════════════════ */

  var CSS = ''
    + '#omega-terr{position:fixed;right:14px;top:70px;width:340px;max-height:78vh;overflow:auto;'
    + 'background:#1b1b1c;border:1px solid #3C3C3C;border-radius:10px;z-index:99999;'
    + 'font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:11px;color:#E2EEF9;'
    + 'box-shadow:0 12px 40px rgba(0,0,0,.6);display:none}'
    + '#omega-terr.on{display:block}'
    + '#omega-terr .tb{display:flex;align-items:center;gap:8px;padding:9px 11px;'
    + 'background:#252526;border-bottom:1px solid #3C3C3C;border-radius:10px 10px 0 0;'
    + 'font-weight:700;letter-spacing:.06em;font-size:10px;color:#2FB54A;position:sticky;top:0;z-index:2}'
    + '#omega-terr .tb .sp{flex:1}'
    + '#omega-terr .tb button{background:none;border:0;color:#8FA3B8;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px}'
    + '#omega-terr .tb button:hover{color:#E2EEF9}'
    + '#omega-terr .bd{padding:10px 11px 14px}'
    + '#omega-terr h4{margin:13px 0 6px;font-size:9px;letter-spacing:.09em;color:#8FA3B8;'
    + 'text-transform:uppercase;font-weight:700;border-bottom:1px solid #2e2e30;padding-bottom:4px}'
    + '#omega-terr h4:first-child{margin-top:0}'
    + '#omega-terr .r{display:flex;justify-content:space-between;gap:10px;padding:2.5px 0;line-height:1.45}'
    + '#omega-terr .r span{color:#8FA3B8}'
    + '#omega-terr .r b{color:#E2EEF9;font-weight:600;text-align:right}'
    + '#omega-terr .g b{color:#2FB54A}#omega-terr .a b{color:#D9A441}#omega-terr .x b{color:#C86A6A}'
    + '#omega-terr .note{color:#7d8a97;line-height:1.5;font-size:9.5px;margin:6px 0 2px}'
    + '#omega-terr .btns{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:11px}'
    + '#omega-terr .btns button{padding:7px 6px;background:#252526;border:1px solid #3C3C3C;'
    + 'color:#E2EEF9;border-radius:5px;font-size:9.5px;cursor:pointer;font-family:inherit;font-weight:600}'
    + '#omega-terr .btns button:hover{border-color:#2FB54A;color:#2FB54A}'
    + '#omega-terr .btns button.wide{grid-column:1/-1}'
    + '#omega-terr .run{width:100%;padding:9px;background:rgba(47,181,74,.16);border:1px solid rgba(47,181,74,.45);'
    + 'color:#2FB54A;border-radius:6px;font-size:10.5px;font-weight:700;cursor:pointer;font-family:inherit;margin-bottom:4px}'
    + '#omega-terr .warn{background:rgba(200,106,106,.1);border:1px solid rgba(200,106,106,.35);'
    + 'color:#E0A9A9;padding:7px 8px;border-radius:5px;line-height:1.5;margin:8px 0;font-size:9.5px}';

  function ensurePanel() {
    var el = document.getElementById('omega-terr');
    if (el) return el;
    var st = document.createElement('style'); st.textContent = CSS;
    document.head.appendChild(st);
    el = document.createElement('div');
    el.id = 'omega-terr';
    el.innerHTML = '<div class="tb">TERRAIN &amp; ELECTRICAL<span class="sp"></span>'
      + '<button data-act="min" title="Minimise">\u2212</button>'
      + '<button data-act="close" title="Close">\u00d7</button></div>'
      + '<div class="bd" id="omega-terr-bd"></div>';
    document.body.appendChild(el);
    el.querySelector('[data-act="close"]').onclick = function () { el.classList.remove('on'); };
    el.querySelector('[data-act="min"]').onclick = function () {
      var b = el.querySelector('.bd');
      b.style.display = (b.style.display === 'none') ? '' : 'none';
    };
    return el;
  }

  function row(label, value, cls) {
    return '<div class="r ' + (cls || '') + '"><span>' + label + '</span><b>' + value + '</b></div>';
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function render(res) {
    var el = ensurePanel();
    el.classList.add('on');
    var b = document.getElementById('omega-terr-bd');
    b.style.display = '';

    if (!res || !res.ok) {
      b.innerHTML = '<button class="run" id="ot-run">Run analysis</button>'
        + '<div class="warn">' + esc(res ? res.why : 'Nothing to analyse.') + '</div>';
      wire(b);
      return;
    }

    var s = res.screen, p = res.piles, c = res.collisions, sd = res.shading, st = res.strings;
    var h = '<button class="run" id="ot-run">Re-run analysis</button>';

    if (res.projQuality === 'approximate') {
      h += '<div class="warn">Canvas is tied to the terrain by bounding-box fit, not by coordinates. '
         + 'Positions are approximate. Sample terrain with the map unlocked for an anchored result.</div>';
    }

    var fld = res.field;
    h += '<h4>Surface</h4>'
      + row('Sampler', fld.kind === 'tin' ? 'grid TIN' : 'IDW fallback', fld.kind === 'tin' ? 'g' : 'a')
      + row('Samples \u00b7 spacing', fld.count + ' \u00b7 ' + Math.round(fld.spacingFt) + ' ft');
    if (fld.kind === 'tin') {
      h += row('Lattice', fld.gridR + ' \u00d7 ' + fld.gridC)
        + row('Surface coverage', Math.round(fld.coverage * 100) + '%',
              fld.coverage > 0.9 ? 'g' : (fld.coverage > 0.6 ? 'a' : 'x'));
      if (fld.coverage < 0.9) {
        h += '<div class="note">' + (fld.maxQuads - fld.quads) + ' of ' + fld.maxQuads
           + ' grid cells have no complete data. Ground there returns no elevation rather '
           + 'than an interpolated guess, so tables over it are rejected, not mis-screened.</div>';
      }
    } else {
      h += '<div class="note">The lattice has no row/column structure, so the exact TIN could '
         + 'not be built and the older inverse-distance sampler is in use. It smooths local '
         + 'relief and reads slopes low. Re-sample terrain to get the TIN.</div>';
    }

    h += '<h4>Buildable after terrain</h4>'
      + row('Tables drawn flat', s.kept.length + s.rejected.length)
      + row('Buildable', s.keptCount, 'g')
      + row('Rejected', s.rejectedCount, s.rejectedCount ? 'x' : '')
      + row('Buildable share', s.buildablePct + '%', s.buildablePct >= 90 ? 'g' : (s.buildablePct >= 70 ? 'a' : 'x'))
      + row('kW-DC flat / real', res.kwFlat.toLocaleString() + ' \u2192 ' + res.kwReal.toLocaleString(),
            res.kwLost > 0 ? 'a' : 'g')
      + row('Median / max slope', s.medianSlopePct + '% / ' + s.maxSlopePct + '%')
      + row('Limit axis / cross', s.limitAlongPct + '% / ' + s.limitCrossPct + '%');

    if (s.rejectedCount) {
      var rs = s.reasons;
      h += '<div class="note">Rejected for: ' + rs.along + ' axis slope, ' + rs.cross
         + ' cross slope, ' + rs.warp + ' twist, ' + rs.noData + ' no data.</div>';
    }

    if (p) {
      h += '<h4>Pile schedule</h4>'
        + row('Model', p.mode === 'plane' ? 'planar table' : (p.mode === 'line' ? 'straight tube' : 'terrain-following'))
        + row('Piles', p.count.toLocaleString())
        + row('Reveal min / med / max', p.revealMinFt + ' / ' + p.revealMedianFt + ' / ' + p.revealMaxFt + ' ft')
        + row('Allowed range', p.minRevealFt + '\u2013' + p.maxRevealFt + ' ft')
        + row('Out of range', p.outOfRange, p.outOfRange ? 'a' : 'g')
        + row('Steel', p.totalSteelFt.toLocaleString() + ' ft')
        + row('Grading cut / fill', p.cutCy.toLocaleString() + ' / ' + p.fillCy.toLocaleString() + ' cy',
              (p.cutCy + p.fillCy) > 0 ? 'a' : 'g');
      if (p.articulationFails) h += row('Articulation fails', p.articulationFails, 'x');
    }

    if (c) {
      h += '<h4>Clearance</h4>'
        + row('Grade strikes', c.strikeCount, c.strikeCount ? 'x' : 'g')
        + row('Required clearance', c.requiredClearFt + ' ft')
        + row('Rows near the limit', c.nearLimitCount, c.nearLimitCount ? 'a' : 'g');
    }

    h += '<h4>Shading</h4>';
    if (!sd.ok) {
      h += '<div class="note">' + esc(sd.why) + '</div>';
    } else {
      var bad = sd.verdict.indexOf('shaded at solar noon') === 0;
      h += row('Latitude', sd.latDeg + '\u00b0')
        + row('Profile angle, noon', sd.noonProfileDeg + '\u00b0')
        + row('Pitch actual', sd.actualPitchFt + ' ft')
        + row('Pitch for ' + sd.targetHours + ' clear hrs', sd.requiredPitchWindowFt + ' ft')
        + row('Max GCR, ' + sd.targetHours + ' hrs', sd.maxGcrWindow + ' (now ' + sd.actualGcr + ')',
              sd.actualGcr <= sd.maxGcrWindow ? 'g' : 'a')
        + row('Clear window bought', sd.clearHours + ' hrs',
              sd.clearHours >= sd.targetHours ? 'g' : 'a')
        + row('Verdict', sd.verdict, bad ? 'x' : (sd.shortfallFt > 0 ? 'a' : 'g'));
      if (sd.shortfallFt > 0) {
        h += '<div class="note">Rows are ' + sd.shortfallFt + ' ft tight for the target window. '
           + 'Drop GCR to ' + sd.maxGcrWindow + ' to clear it, or accept the edge-hour loss.</div>';
      }
    }

    if (st) {
      h += '<h4>DC collection</h4>'
        + row('Modules', st.totalModules.toLocaleString() + ' @ ' + st.moduleWatts + ' W')
        + row('Per table', st.modulesPerTable)
        + row('Strings', st.stringCount.toLocaleString() + ' \u00d7 ' + st.modulesPerString)
        + row('Partial strings', st.partialStrings, st.partialStrings ? 'a' : 'g')
        + row('Combiners', st.combinerCount)
        + row('Inverter blocks', st.blockCount)
        + row('DC cable', st.totalDcFt.toLocaleString() + ' ft')
        + row('Cable intensity', st.dcPerKw + ' ft/kW');
    }

    h += '<div class="note">' + esc(stamp(res)) + '</div>';

    h += '<div class="btns">'
      + '<button class="wide" data-x="section">Cut a cross-section</button>'
      + '<button class="wide" data-x="capacity">Size to a target MW\u2026</button>'
      + '<button data-x="pile">Pile schedule CSV</button>'
      + '<button data-x="string">Stringing CSV</button>'
      + '<button data-x="pvsyst">PVsyst scene</button>'
      + '<button data-x="shp">Shapefile ZIP</button>'
      + '<button class="wide" data-x="import">Import boundary from .shp</button>'
      + '</div>';

    b.innerHTML = h;
    wire(b);
  }

  function wire(b) {
    var r = b.querySelector('#ot-run');
    if (r) r.onclick = function () { render(analyze()); };
    Array.prototype.forEach.call(b.querySelectorAll('[data-x]'), function (btn) {
      btn.onclick = function () {
        var k = btn.getAttribute('data-x');
        if (k === 'section') sectionArm();
        else if (k === 'capacity') capacityPrompt();
        else if (k === 'pile') exportPileCSV(LAST);
        else if (k === 'string') exportStringCSV(LAST);
        else if (k === 'pvsyst') exportPVsyst(LAST);
        else if (k === 'shp') exportShapefileZip(LAST, 'tables');
        else if (k === 'import') pickSHP();
      };
    });
  }

  function pickSHP() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.shp';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      importSHP(f, function (err, rings, raw) {
        if (err) { say('Shapefile import failed: ' + err.message); return; }
        if (!rings.length) { say('No polygons found in that shapefile.'); return; }
        window.OmegaTerrain.lastImport = rings;
        say(rings.length + ' ring(s) imported \u2014 available as OmegaTerrain.lastImport '
          + '(lat/lng). Largest has ' + rings[0].length + ' vertices.');
        if (window.console) console.info(TAG, 'imported shapefile', raw.type, rings);
      });
    };
    inp.click();
  }

  function open() { render(LAST && LAST.ok ? LAST : analyze()); }


  /* ---- capacity prompt UI ------------------------------------------ */
  function capacityPrompt() {
    var sh = pickArray();
    if (!sh) { say('Draw an array first.'); return; }
    var cur = (LAST && LAST.ok) ? LAST.kwReal : (sh.kw || 0);
    var d = document.getElementById('omega-cap');
    if (d) d.remove();
    d = document.createElement('div');
    d.id = 'omega-cap';
    d.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);'
      + 'width:min(420px,92vw);background:#1b1b1c;border:1px solid #3C3C3C;border-radius:10px;'
      + 'padding:14px;z-index:100000;box-shadow:0 20px 60px rgba(0,0,0,.7);'
      + 'font-family:"IBM Plex Mono",ui-monospace,monospace;color:#E2EEF9;font-size:11px';
    d.innerHTML =
      '<div style="font-size:9.5px;letter-spacing:.07em;color:#2FB54A;font-weight:700;'
      + 'margin-bottom:9px">SIZE TO A TARGET</div>'
      + '<div style="color:#8FA3B8;line-height:1.55;margin-bottom:10px">'
      + 'Current layout is about <b style="color:#E2EEF9">' + (cur / 1000).toFixed(1)
      + ' MW-DC</b> on this boundary. Enter a target and the search will find the '
      + 'loosest ground-coverage ratio that still reaches it on the real surface.</div>'
      + '<label style="display:block;color:#8FA3B8;margin-bottom:4px">Target MW-DC</label>'
      + '<input id="omega-cap-mw" type="number" step="0.1" value="' + Math.max(1, (cur / 1000 * 1.2)).toFixed(1)
      + '" style="width:100%;padding:7px;background:#252526;border:1px solid #3C3C3C;'
      + 'color:#E2EEF9;border-radius:5px;font:inherit;margin-bottom:11px">'
      + '<div id="omega-cap-out" style="max-height:230px;overflow:auto"></div>'
      + '<div style="display:flex;gap:7px;margin-top:11px">'
      + '<button id="omega-cap-go" style="flex:1;padding:8px;background:rgba(47,181,74,.16);'
      + 'border:1px solid rgba(47,181,74,.45);color:#2FB54A;border-radius:5px;font:inherit;'
      + 'font-weight:700;cursor:pointer">Search</button>'
      + '<button id="omega-cap-x" style="padding:8px 14px;background:#252526;border:1px solid #3C3C3C;'
      + 'color:#E2EEF9;border-radius:5px;font:inherit;cursor:pointer">Close</button></div>';
    document.body.appendChild(d);
    document.getElementById('omega-cap-x').onclick = function () { d.remove(); };
    document.getElementById('omega-cap-go').onclick = function () {
      var out = document.getElementById('omega-cap-out');
      out.innerHTML = '<div style="color:#8FA3B8">searching\u2026</div>';
      setTimeout(function () {
        var mw = +document.getElementById('omega-cap-mw').value;
        var r = capacitySearch({ shape: sh, targetMW: mw });
        if (!r.ok) { out.innerHTML = '<div style="color:#C86A6A">' + esc(r.why) + '</div>'; return; }
        var h = '<table style="width:100%;border-collapse:collapse;font-size:10px">'
          + '<tr style="color:#8FA3B8"><th style="text-align:right;padding:2px 5px">GCR</th>'
          + '<th style="text-align:right;padding:2px 5px">pitch</th>'
          + '<th style="text-align:right;padding:2px 5px">tables</th>'
          + '<th style="text-align:right;padding:2px 5px">buildable</th>'
          + '<th style="text-align:right;padding:2px 5px">MW</th></tr>';
        r.rows.forEach(function (x) {
          var hit = r.best && x.gcr === r.best.gcr;
          h += '<tr style="border-top:1px solid #2a2a2c' + (hit ? ';color:#2FB54A;font-weight:700' : '') + '">'
            + '<td style="text-align:right;padding:2px 5px">' + x.gcr.toFixed(3) + '</td>'
            + '<td style="text-align:right;padding:2px 5px">' + x.pitchFt + '</td>'
            + '<td style="text-align:right;padding:2px 5px">' + x.tables + '</td>'
            + '<td style="text-align:right;padding:2px 5px">' + x.ok + '</td>'
            + '<td style="text-align:right;padding:2px 5px">' + x.mw.toFixed(2) + '</td></tr>';
        });
        h += '</table>';
        h += '<div style="color:#8FA3B8;margin-top:9px;line-height:1.55">'
          + (r.feasible
              ? 'Reaches <b style="color:#2FB54A">' + r.best.mw.toFixed(2) + ' MW</b> at GCR '
                + r.best.gcr.toFixed(3) + ' (pitch ' + r.best.pitchFt + ' ft).'
              : 'Does not reach ' + r.targetMW + ' MW on this boundary. Best is '
                + '<b style="color:#D9A441">' + r.achievedMW.toFixed(2) + ' MW</b> at GCR '
                + r.best.gcr.toFixed(3) + '.')
          + (r.screened
              ? ' Buildable counts are after terrain screening.'
              : ' <b style="color:#D9A441">No terrain sampled</b> \u2014 these are flat-ground counts.')
          + '</div>';
        if (r.feasible) {
          h += '<button id="omega-cap-apply" style="width:100%;margin-top:9px;padding:7px;'
            + 'background:rgba(47,181,74,.16);border:1px solid rgba(47,181,74,.45);color:#2FB54A;'
            + 'border-radius:5px;font:inherit;font-weight:700;cursor:pointer">Apply GCR '
            + r.best.gcr.toFixed(3) + ' to this project</button>';
        }
        out.innerHTML = h;
        var ap = document.getElementById('omega-cap-apply');
        if (ap) ap.onclick = function () {
          try {
            if (typeof setSolarAssume === 'function') setSolarAssume('gcr', r.best.gcr);
            else { S.solarAssume = S.solarAssume || {}; S.solarAssume.gcr = r.best.gcr; }
            say('GCR set to ' + r.best.gcr.toFixed(3) + '. Regenerate the array to apply it.');
            d.remove();
          } catch (e) { say('Could not apply: ' + (e && e.message)); }
        };
      }, 30);
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     16.  INSTALL
     ══════════════════════════════════════════════════════════════════ */

  function addPreset() {
    /* Register the terrain-following tracker alongside the shipped
       presets so it appears wherever racking is chosen. GCR is lower
       than a standard tracker because articulated rows still need the
       pitch, and the capacity factor is a touch higher for the reduced
       terrain losses. */
    try {
      if (typeof DER_SOLAR_PRESETS === 'undefined' || DER_SOLAR_PRESETS['tracker-tft']) return;
      DER_SOLAR_PRESETS['tracker-tft'] = {
        label: 'Terrain-following tracker',
        gcr: 0.33,
        wpsf: (typeof DER_PV_WPSF !== 'undefined' ? DER_PV_WPSF : 20),
        setbackFt: 15, cf: 0.225,
        note: 'Articulated bearings follow grade \u2014 far less mass grading on rolling ground.'
      };
      if (typeof DER_SOLAR_PRESET_CLASS !== 'undefined') DER_SOLAR_PRESET_CLASS['tracker-tft'] = 'ground';
      if (typeof GM_TABLE !== 'undefined') GM_TABLE['tracker-tft'] = { tableW: 6, tableH: 180, tiltDeg: 0 };
    } catch (e) {}
  }

  function addMenu() {
    try {
      var fly = document.getElementById('fly-der');
      if (!fly || document.getElementById('omega-terr-btn')) return true;
      var b = document.createElement('button');
      b.className = 'rb-fly-item';
      b.id = 'omega-terr-btn';
      b.title = 'Screen the layout against real terrain: slope, piles, clearance, shading and DC collection';
      b.innerHTML = '<span class="fi-ico">\u26f0</span> Array \u2014 Terrain &amp; Electrical';
      b.onclick = function () {
        try {
          if (typeof rbFlyDo === 'function') { rbFlyDo('fly-der', function () { open(); }); return; }
        } catch (e) {}
        open();
      };
      fly.appendChild(b);
      return true;
    } catch (e) { return false; }
  }

  var installed = false;
  function install() {
    if (installed) return true;
    if (!document.body) return false;
    addPreset();
    addMenu();
    installTrackerFix();
    try {
      var host = document.getElementById('sc');
      if (host && !host.__omegaSecHook) {
        host.addEventListener('click', sectionClick, true);
        host.__omegaSecHook = true;
      }
    } catch (e) {}
    installed = true;
    if (window.console) {
      console.info(TAG, 'v' + VERSION + ' ready \u2014 OmegaTerrain.open() or Solar menu \u2192 Terrain & Electrical');
    }
    return true;
  }

  var tries = 0;
  var iv = setInterval(function () { if (install() || ++tries > 200) clearInterval(iv); }, 300);

  /* ══════════════════════════════════════════════════════════════════
     PUBLIC API
     ══════════════════════════════════════════════════════════════════ */

  window.OmegaTerrain = {
    version: VERSION,
    open: open,
    analyze: analyze,
    last: function () { return LAST; },

    /* individual engines, for scripting or a different UI */
    field: makeField,
    projector: makeProjector,
    slopeOf: tableSlope,
    screen: screenLayout,
    piles: schedulePiles,
    collisions: checkCollisions,
    shading: shadingAnalysis,
    stringing: stringLayout,
    sun: sunPos,
    profileAngle: profileAngleDeg,

    /* racking tolerances — overwrite with a supplier's structural letter */
    rack: RACK,
    setRack: function (presetKey, patch) {
      try {
        if (typeof S === 'undefined') return false;
        S.rackAssume = S.rackAssume || {};
        S.rackAssume[presetKey] = Object.assign(S.rackAssume[presetKey] || {}, patch);
        return true;
      } catch (e) { return false; }
    },

    /* v2 */
    capacity: capacitySearch,
    section: sectionArm,
    tin: buildGridTIN,
    get trackerAxisFix() { return _trackerFix; },
    set trackerAxisFix(v) { _trackerFix = !!v; },
    get useTIN() { return !_omegaNoTIN; },
    set useTIN(v) { _omegaNoTIN = !v; },

    /* exports */
    exportPiles: function () { return exportPileCSV(LAST); },
    exportStrings: function () { return exportStringCSV(LAST); },
    exportPVsyst: function () { return exportPVsyst(LAST); },
    exportSHP: function (what) { return exportShapefileZip(LAST, what); },
    importSHP: importSHP,
    readShapefile: readShapefile,
    writeShapefile: writeShapefile,
    zip: zipStore
  };

})();
