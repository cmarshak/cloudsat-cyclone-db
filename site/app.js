'use strict';

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const IMAGERY = {
  truecolor: { label: 'Aqua MODIS true color', layer: 'MODIS_Aqua_CorrectedReflectance_TrueColor', matrix: 'GoogleMapsCompatible_Level9', ext: 'jpeg', maxzoom: 9 },
  ir_day: { label: 'Aqua MODIS 11 µm brightness temperature (day)', layer: 'MODIS_Aqua_Brightness_Temp_Band31_Day', matrix: 'GoogleMapsCompatible_Level7', ext: 'png', maxzoom: 7 },
  ir_night: { label: 'Aqua MODIS 11 µm brightness temperature (night)', layer: 'MODIS_Aqua_Brightness_Temp_Band31_Night', matrix: 'GoogleMapsCompatible_Level7', ext: 'png', maxzoom: 7 },
};
const CATEGORIES = ['TD', 'TS', 'C1', 'C2', 'C3', 'C4', 'C5'];
const CATEGORY_NAMES = { TD: 'Tropical depression', TS: 'Tropical storm', C1: 'Category 1', C2: 'Category 2', C3: 'Category 3', C4: 'Category 4', C5: 'Category 5' };
const CATEGORY_LIMITS_KT = [34, 64, 83, 96, 113, 137];
const INTENSITY = ['#983900', '#ae5600', '#c3722e', '#d88e4f', '#eeaa6f', '#ffc68e', '#ffe3ae'];
const RADIUS = [4, 5, 6, 7, 8, 9, 10];
const BLUE = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
const DBZ_RANGE = [-30, 20];
const BASINS = { NA: 'North Atlantic', EP: 'East Pacific', WP: 'West Pacific', NI: 'North Indian', SI: 'South Indian', SP: 'South Pacific', SA: 'South Atlantic' };
const DEFAULT_ID = '23094_EARL';

const state = { overpasses: [], byId: new Map(), tracks: {}, cache: new Map(), selected: null, curtain: null, imagery: 'auto', cursor: null, frame: 0 };
let map;
let popup;

const $ = (selector) => document.querySelector(selector);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const titleCase = (s) => s.toLowerCase().replace(/(^|[-\s])\w/g, (m) => m.toUpperCase());
const fmtLat = (v) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'N' : 'S'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'E' : 'W'}`;
const fmt = (v, digits = 0, unit = '') => (v === null || v === undefined ? '—' : `${Number(v).toFixed(digits)}${unit}`);
const catIndex = (c) => CATEGORIES.indexOf(c);
const categoryOfWind = (kt) => (kt === null ? null : CATEGORIES[CATEGORY_LIMITS_KT.filter((limit) => kt >= limit).length]);
const isDark = () => {
  const theme = document.documentElement.dataset.theme;
  return theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
};
const utc = (iso, offsetS = 0) => new Date(Date.parse(iso) + offsetS * 1000).toISOString().slice(11, 19);
const localSolarTime = (iso, lon) => {
  const hours = ((Date.parse(iso) / 3.6e6 + lon / 15) % 24 + 24) % 24;
  return `${String(Math.floor(hours)).padStart(2, '0')}:${String(Math.floor((hours % 1) * 60)).padStart(2, '0')}`;
};

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function unwrap(lons) {
  return lons.reduce((out, lon, i) => {
    if (i === 0) return [lon];
    const prev = out[i - 1];
    return [...out, lon + 360 * Math.round((prev - lon) / 360)];
  }, []);
}

function filters() {
  return { basin: $('#basin').value, minCat: Number($('#intensity').value) };
}

function filtered() {
  const { basin, minCat } = filters();
  return state.overpasses.filter((o) => (!basin || o.basin === basin) && catIndex(o.category) >= minCat);
}

function optionLabel(o) {
  return `${o.date.slice(5)}  ${titleCase(o.storm)} · ${o.category ?? '—'} · ${Math.round(o.min_dist_km)} km`;
}

function buildDropdown() {
  const list = filtered();
  const years = list.reduce((acc, o) => ({ ...acc, [o.date.slice(0, 4)]: [...(acc[o.date.slice(0, 4)] ?? []), o] }), {});
  const groups = Object.entries(years).map(([year, items]) => {
    const group = document.createElement('optgroup');
    group.label = year;
    group.append(...items.map((o) => new Option(optionLabel(o), o.id)));
    return group;
  });
  $('#overpass').replaceChildren(...groups);
  if (state.selected && list.some((o) => o.id === state.selected.id)) $('#overpass').value = state.selected.id;
  $('#count').textContent = `${list.length} of ${state.overpasses.length} overpasses`;
  return list;
}

function buildBasinFilter() {
  const present = [...new Set(state.overpasses.map((o) => o.basin))].sort();
  $('#basin').replaceChildren(new Option('All', ''), ...present.map((b) => new Option(BASINS[b] ?? b, b)));
}

function buildLegend() {
  const items = CATEGORIES.map(
    (c, i) => `<div class="item"><span class="dot" style="width:${RADIUS[i] * 2}px;height:${RADIUS[i] * 2}px;background:${INTENSITY[i]}"></span>${c}</div>`,
  ).join('');
  $('#legend').innerHTML = `
    <div class="title">Intensity at overpass (dot size and color)</div>
    <div class="row">${items}</div>
    <div class="keys">
      <div class="key"><span class="swatch-line"></span>CloudSat ground track (±1000 km)</div>
      <div class="key"><span class="swatch-dash"></span>IBTrACS best track</div>
      <div class="key"><span class="swatch-ring"></span>Best-track center at CloudSat time</div>
    </div>`;
}

function overpassGeojson() {
  return {
    type: 'FeatureCollection',
    features: state.overpasses.map((o) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [o.lon, o.lat] },
      properties: { id: o.id, category: o.category ?? 'TD', cat_index: Math.max(0, catIndex(o.category)), basin: o.basin },
    })),
  };
}

function stormTrackGeojson(sid) {
  const track = state.tracks[sid];
  if (!track) return { type: 'FeatureCollection', features: [] };
  const lons = unwrap(track.points.map((p) => p[2]));
  const coords = track.points.map((p, i) => [lons[i], p[1]]);
  const fixes = track.points.map((p, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: coords[i] },
    properties: { category: categoryOfWind(p[3]) ?? 'TD', time: p[0], wind: p[3] },
  }));
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }, ...fixes] };
}

function cloudsatTrackGeojson(header) {
  const step = 4;
  const idx = header.lat.map((_, i) => i).filter((i) => i % step === 0 || i === header.lat.length - 1);
  const lons = unwrap(idx.map((i) => header.lon[i]));
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: idx.map((i, k) => [lons[k], header.lat[i]]) }, properties: {} };
}

function point(lon, lat) {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} };
}

const EMPTY = { type: 'FeatureCollection', features: [] };
const colorByCategory = ['match', ['get', 'category'], ...CATEGORIES.flatMap((c, i) => [c, INTENSITY[i]]), '#898781'];
const radiusByCategory = ['match', ['get', 'category'], ...CATEGORIES.flatMap((c, i) => [c, RADIUS[i]]), 4];

function mapStyle() {
  return {
    version: 8,
    projection: { type: 'globe' },
    sources: {
      bluemarble: {
        type: 'raster',
        tiles: [`${GIBS}/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg`],
        tileSize: 256,
        maxzoom: 8,
        attribution: 'Basemap: NASA Blue Marble via GIBS',
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#0d0d0d' } },
      { id: 'bluemarble', type: 'raster', source: 'bluemarble' },
    ],
    sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] },
  };
}

function addDataLayers() {
  map.addSource('overpasses', { type: 'geojson', data: overpassGeojson(), promoteId: 'id' });
  ['storm-track', 'cloudsat-track', 'storm-center', 'cursor'].forEach((id) => map.addSource(id, { type: 'geojson', data: EMPTY }));
  map.addLayer({ id: 'storm-track-line', type: 'line', source: 'storm-track', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#f0efec', 'line-opacity': 0.6, 'line-width': 1.5, 'line-dasharray': [2, 2] } });
  map.addLayer({ id: 'storm-track-fixes', type: 'circle', source: 'storm-track', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 3, 'circle-color': colorByCategory, 'circle-stroke-color': '#1a1a19', 'circle-stroke-width': 1 } });
  map.addLayer({ id: 'cloudsat-casing', type: 'line', source: 'cloudsat-track', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#0b0b0b', 'line-width': 5, 'line-opacity': 0.55 } });
  map.addLayer({ id: 'cloudsat-line', type: 'line', source: 'cloudsat-track', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#f0efec', 'line-width': 2 } });
  map.addLayer({ id: 'cloudsat-hit', type: 'line', source: 'cloudsat-track', paint: { 'line-color': '#000000', 'line-width': 18, 'line-opacity': 0 } });
  map.addLayer({
    id: 'overpass-dots',
    type: 'circle',
    source: 'overpasses',
    paint: {
      'circle-radius': radiusByCategory,
      'circle-color': colorByCategory,
      'circle-stroke-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#ffffff', '#1a1a19'],
      'circle-stroke-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.5, 1.5],
    },
  });
  map.addLayer({ id: 'overpass-hit', type: 'circle', source: 'overpasses', paint: { 'circle-radius': ['+', radiusByCategory, 6], 'circle-opacity': 0 } });
  map.addLayer({ id: 'storm-center', type: 'circle', source: 'storm-center', paint: { 'circle-radius': 8, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'cursor', type: 'circle', source: 'cursor', paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': '#0b0b0b', 'circle-stroke-width': 2 } });
}

function applyMapFilter() {
  const { basin, minCat } = filters();
  const expr = ['all', ['>=', ['get', 'cat_index'], minCat], ...(basin ? [['==', ['get', 'basin'], basin]] : [])];
  ['overpass-dots', 'overpass-hit'].forEach((id) => map.setFilter(id, expr));
}

function imageryKey(o) {
  const choice = state.imagery === 'auto' ? (o.daytime ? 'truecolor' : 'ir') : state.imagery;
  if (choice === 'ir') return o.daytime ? 'ir_day' : 'ir_night';
  return choice;
}

function setImagery(o) {
  if (map.getLayer('imagery')) map.removeLayer('imagery');
  if (map.getSource('imagery')) map.removeSource('imagery');
  const key = imageryKey(o);
  if (key === 'none') return;
  const spec = IMAGERY[key];
  map.addSource('imagery', {
    type: 'raster',
    tiles: [`${GIBS}/${spec.layer}/default/${o.t_closest.slice(0, 10)}/${spec.matrix}/{z}/{y}/{x}.${spec.ext}`],
    tileSize: 256,
    maxzoom: spec.maxzoom,
    attribution: 'Imagery: NASA GIBS, Aqua MODIS',
  });
  map.addLayer({ id: 'imagery', type: 'raster', source: 'imagery', paint: { 'raster-opacity': 0.95 } }, 'storm-track-line');
}

function tooltipHtml(o) {
  return `<div class="name">${esc(titleCase(o.storm))} · ${esc(o.category ?? '—')}</div>
    <div class="meta">${esc(BASINS[o.basin] ?? o.basin)} · ${esc(o.t_closest.slice(0, 10))} ${esc(utc(o.t_closest))} UTC</div>
    <div class="meta">${fmt(o.wind_kt, 0, ' kt')} · ${fmt(o.pressure_mb, 0, ' hPa')} · ${fmt(o.min_dist_km, 0, ' km')} from center</div>
    <div class="hint">Click to load the curtain</div>`;
}

function nearestProfile(lng, lat) {
  const h = state.curtain.header;
  const coslat = Math.cos((lat * Math.PI) / 180);
  const d2 = h.lat.map((plat, i) => {
    const dlon = ((((h.lon[i] - lng) % 360) + 540) % 360) - 180;
    return (plat - lat) ** 2 + (dlon * coslat) ** 2;
  });
  return d2.reduce((best, v, i) => (v < d2[best] ? i : best), 0);
}

function nearestIndexByDistance(dist, x) {
  const search = (lo, hi) => (hi - lo <= 1 ? (Math.abs(dist[lo] - x) <= Math.abs(dist[hi] - x) ? lo : hi) : dist[(lo + hi) >> 1] < x ? search((lo + hi) >> 1, hi) : search(lo, (lo + hi) >> 1));
  return search(0, dist.length - 1);
}

function bindMapEvents() {
  popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14, className: 'tip', maxWidth: '300px' });
  map.on('mousemove', 'overpass-hit', (e) => {
    const o = state.byId.get(e.features[0].properties.id);
    map.getCanvas().style.cursor = 'pointer';
    popup.setLngLat([o.lon, o.lat]).setHTML(tooltipHtml(o)).addTo(map);
  });
  map.on('mouseleave', 'overpass-hit', () => {
    map.getCanvas().style.cursor = '';
    popup.remove();
  });
  map.on('click', 'overpass-hit', (e) => select(e.features[0].properties.id));
  map.on('mousemove', 'cloudsat-hit', (e) => {
    if (!state.curtain || map.queryRenderedFeatures(e.point, { layers: ['overpass-hit'] }).length) return;
    setCursor(nearestProfile(e.lngLat.lng, e.lngLat.lat), null);
  });
  map.on('mouseleave', 'cloudsat-hit', () => clearCursor());
}

function curtainFromBytes(header, bytes) {
  const nh = header.height_km.n;
  const np = header.n_profiles;
  const { lo, step } = header.dbz;
  const z = Array.from({ length: nh }, (_, k) => Array.from({ length: np }, (_, i) => {
    const q = bytes[k * np + i];
    return q ? lo + step * (q - 1) : null;
  }));
  const heights = Array.from({ length: nh }, (_, k) => +(header.height_km.start + k * header.height_km.step).toFixed(2));
  const echoTop = Array.from({ length: np }, (_, i) => {
    const top = Array.from({ length: nh }, (_, k) => k).filter((k) => bytes[k * np + i] > 0).pop();
    return top === undefined ? null : heights[top];
  });
  return { header, z, heights, echoTop };
}

async function loadCurtain(id) {
  if (!state.cache.has(id)) {
    const [header, bytes] = await Promise.all([fetchJson(`data/curtains/${id}.json`), fetchBytes(`data/curtains/${id}.u8`)]);
    state.cache.set(id, curtainFromBytes(header, bytes));
  }
  return state.cache.get(id);
}

function curtainLayout() {
  const surface = cssVar('--surface');
  const axisStyle = { gridcolor: cssVar('--grid'), linecolor: cssVar('--axis'), tickcolor: cssVar('--axis'), zeroline: false, ticks: 'outside', showline: true };
  const xmax = Math.min(600, Math.max(...state.curtain.header.dist_km.map(Math.abs)));
  return {
    paper_bgcolor: surface,
    plot_bgcolor: surface,
    margin: { l: 56, r: 12, t: 6, b: 44 },
    font: { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: cssVar('--ink-2'), size: 12 },
    xaxis: { ...axisStyle, title: { text: 'Along-track distance from closest approach (km)  ·  earlier ← → later' }, range: [-xmax, xmax] },
    yaxis: { ...axisStyle, title: { text: 'Height (km)' }, range: [0, 20], dtick: 5 },
    hovermode: 'closest',
    dragmode: 'zoom',
    shapes: [
      { type: 'line', xref: 'x', yref: 'paper', x0: 0, x1: 0, y0: 0, y1: 1, line: { color: cssVar('--muted'), width: 1, dash: 'dot' } },
      { type: 'line', xref: 'x', yref: 'paper', x0: 0, x1: 0, y0: 0, y1: 1, visible: false, line: { color: cssVar('--ink'), width: 1.5 } },
    ],
  };
}

function curtainTrace() {
  const ramp = isDark() ? [...BLUE].reverse() : BLUE;
  return {
    type: 'heatmap',
    x: state.curtain.header.dist_km,
    y: state.curtain.heights,
    z: state.curtain.z,
    zmin: DBZ_RANGE[0],
    zmax: DBZ_RANGE[1],
    colorscale: ramp.map((hex, i) => [i / (ramp.length - 1), hex]),
    hoverinfo: 'none',
    colorbar: { title: { text: 'dBZ', side: 'right' }, thickness: 10, outlinewidth: 0, len: 0.9, tickfont: { color: cssVar('--ink-2') } },
  };
}

function renderCurtain() {
  if (!state.curtain) return;
  const el = $('#curtain');
  Plotly.react(el, [curtainTrace()], curtainLayout(), { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['select2d', 'lasso2d'] });
  if (!el.dataset.bound) {
    el.on('plotly_hover', (e) => {
      const pt = e.points[0];
      setCursor(nearestIndexByDistance(state.curtain.header.dist_km, pt.x), pt.y);
    });
    el.on('plotly_unhover', () => clearCursor());
    el.dataset.bound = '1';
  }
}

function readoutHtml(i, height) {
  const c = state.curtain;
  const h = c.header;
  const base = `<b>${utc(h.t_closest, h.t_s[i])} UTC</b> · ${fmtLat(h.lat[i])} ${fmtLon(h.lon[i])} · ${fmt(h.dist_km[i], 0, ' km')}`;
  if (height === null) return `${base} · echo top ${c.echoTop[i] === null ? 'none' : fmt(c.echoTop[i], 1, ' km')}`;
  const k = Math.round((height - h.height_km.start) / h.height_km.step);
  const dbz = c.z[k]?.[i];
  return `${base} · ${fmt(c.heights[k], 2, ' km')}: <b>${dbz === null || dbz === undefined ? 'no echo' : `${dbz.toFixed(1)} dBZ`}</b>`;
}

function setCursor(i, height) {
  state.cursor = { i, height };
  if (state.frame) return;
  state.frame = requestAnimationFrame(() => {
    state.frame = 0;
    if (!state.cursor || !state.curtain) return;
    const { i: idx, height: hgt } = state.cursor;
    const h = state.curtain.header;
    map.getSource('cursor').setData(point(h.lon[idx], h.lat[idx]));
    Plotly.relayout($('#curtain'), { 'shapes[1].x0': h.dist_km[idx], 'shapes[1].x1': h.dist_km[idx], 'shapes[1].visible': true });
    $('#readout').innerHTML = readoutHtml(idx, hgt);
  });
}

function clearCursor() {
  state.cursor = null;
  map.getSource('cursor').setData(EMPTY);
  if (state.curtain) Plotly.relayout($('#curtain'), { 'shapes[1].visible': false });
}

function panelHtml(o) {
  const i = catIndex(o.category);
  const coincidence = o.a_train
    ? 'Aqua flew about 1 minute ahead of CloudSat in the A-Train, so this MODIS image is close to simultaneous with the curtain.'
    : 'CloudSat was not flying in formation with Aqua on this date, so the MODIS image is from the same day but not simultaneous.';
  const imageryChoices = [
    ['auto', `Auto (${o.daytime ? 'true color, day pass' : 'IR, night pass'})`],
    ['truecolor', IMAGERY.truecolor.label],
    ['ir', 'Aqua MODIS 11 µm brightness temperature'],
    ['none', 'None (Blue Marble only)'],
  ];
  const radios = imageryChoices
    .map(([value, label]) => `<label class="radio"><input type="radio" name="imagery" value="${value}" ${state.imagery === value ? 'checked' : ''}> ${esc(label)}</label>`)
    .join('');
  const epochWarning = o.epoch_09
    ? `<div class="warn"><span class="icon" aria-hidden="true">!</span><span><b>Warning:</b> 2019-2020 R05 data carry a known pointing/timing error; the beam location is uncertain by up to 10 km.</span></div>`
    : '';
  return `
    <h2>${esc(titleCase(o.storm))}</h2>
    <div class="sub">${esc(o.basin_name)} · ${esc(o.t_closest.slice(0, 10))} ${esc(utc(o.t_closest))} UTC</div>
    <div class="chip"><i style="background:${INTENSITY[Math.max(0, i)]}"></i>${esc(CATEGORY_NAMES[o.category] ?? 'Unknown')} · ${fmt(o.wind_kt, 0, ' kt')} (${fmt(o.wind_ms, 1, ' m/s')})</div>
    <dl class="facts">
      <dt>Pressure</dt><dd>${fmt(o.pressure_mb, 0, ' hPa')}</dd>
      <dt>Closest approach</dt><dd>${fmt(o.min_dist_km, 1, ' km')} from best-track center</dd>
      <dt>CIRA list</dt><dd>${fmt(o.cira_min_dist_km, 1, ' km')}</dd>
      <dt>Shear</dt><dd>${fmt(o.shear_kt, 1, ' kt')}</dd>
      <dt>SST</dt><dd>${fmt(o.sst_c, 1, ' °C')}</dd>
      <dt>Pass</dt><dd>${o.daytime ? 'Day' : 'Night'} · ${localSolarTime(o.t_closest, o.lon)} local solar time</dd>
      <dt>Granule</dt><dd>${o.granule} · 2B-GEOPROF R05</dd>
      <dt>Best track</dt><dd>IBTrACS ${esc(o.sid)}</dd>
    </dl>
    ${epochWarning}
    <div class="section">
      <h3>Imagery under the track</h3>
      ${radios}
      <p class="note">${esc(coincidence)}</p>
    </div>
    <div class="section">
      <h3>Reading the curtain</h3>
      <p class="note">94 GHz reflectivity, cloud-masked (CPR_Cloud_mask ≥ 20), on a 240 m grid. The dotted line marks the closest approach to the best-track center. In heavy rain the radar is strongly attenuated, so echoes fade toward the surface under the eyewall; the bright band near 5 km is the melting layer.</p>
    </div>
    <div class="section credits">
      Source: <a href="https://www.cloudsat.cira.colostate.edu/community-products/cloudsat-tropical-cyclone-product" target="_blank" rel="noopener">CloudSat Tropical Cyclone Product</a> and <a href="https://adelaide.cira.colostate.edu/tc/" target="_blank" rel="noopener">overpass database</a>, CIRA/CSU (Tourville et al. 2015) · reflectivity: CloudSat 2B-GEOPROF R05 via OPeNDAP · tracks: IBTrACS v04r01 · imagery: NASA GIBS.
    </div>`;
}

async function select(id) {
  const o = state.byId.get(id) ?? state.overpasses[0];
  if (state.selected) map.setFeatureState({ source: 'overpasses', id: state.selected.id }, { selected: false });
  state.selected = o;
  map.setFeatureState({ source: 'overpasses', id: o.id }, { selected: true });
  history.replaceState(null, '', `#${o.id}`);
  if ([...$('#overpass').options].some((opt) => opt.value === o.id)) $('#overpass').value = o.id;
  $('#panel').innerHTML = panelHtml(o);
  $('#panel').querySelectorAll('input[name="imagery"]').forEach((input) => input.addEventListener('change', () => {
    state.imagery = input.value;
    setImagery(o);
  }));
  setImagery(o);
  map.getSource('storm-track').setData(stormTrackGeojson(o.sid));
  map.getSource('storm-center').setData(point(o.storm_lon, o.storm_lat));
  $('#readout').textContent = 'Loading curtain…';
  const curtain = await loadCurtain(o.id);
  if (state.selected.id !== o.id) return;
  state.curtain = curtain;
  const track = cloudsatTrackGeojson(curtain.header);
  map.getSource('cloudsat-track').setData(track);
  const lons = track.geometry.coordinates.map((c) => c[0]);
  const lats = track.geometry.coordinates.map((c) => c[1]);
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 56, maxZoom: 5.5, duration: 1200 });
  renderCurtain();
  $('#readout').textContent = 'Hover the curtain or the CloudSat track on the globe.';
}

function step(delta) {
  const list = filtered();
  if (!list.length) return;
  const at = list.findIndex((o) => o.id === state.selected?.id);
  select(list[(at + delta + list.length) % list.length].id);
}

function showBanner(html) {
  $('#banner').innerHTML = html;
  $('#banner').hidden = false;
}

async function main() {
  if (location.protocol === 'file:') {
    showBanner('This viewer loads its data with <code>fetch</code>, which browsers block on <code>file://</code>. From the repo, run <code>pixi run serve</code> and open <code>http://127.0.0.1:8000</code>.');
    return;
  }
  const [overpasses, tracks] = await Promise.all([fetchJson('data/overpasses.json'), fetchJson('data/storm_tracks.json')]);
  state.overpasses = overpasses;
  state.byId = new Map(overpasses.map((o) => [o.id, o]));
  state.tracks = tracks;
  buildBasinFilter();
  buildDropdown();
  buildLegend();
  map = new maplibregl.Map({ container: 'map', style: mapStyle(), center: [-50, 18], zoom: 1.3, attributionControl: { compact: true } });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.on('load', () => {
    addDataLayers();
    bindMapEvents();
    const hash = decodeURIComponent(location.hash.slice(1));
    select(state.byId.has(hash) ? hash : state.byId.has(DEFAULT_ID) ? DEFAULT_ID : overpasses[0].id);
  });
  $('#overpass').addEventListener('change', (e) => select(e.target.value));
  $('#prev').addEventListener('click', () => step(-1));
  $('#next').addEventListener('click', () => step(1));
  ['#basin', '#intensity'].forEach((sel) => $(sel).addEventListener('change', () => {
    const list = buildDropdown();
    applyMapFilter();
    if (list.length && !list.some((o) => o.id === state.selected?.id)) select(list[0].id);
  }));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderCurtain);
  window.addEventListener('hashchange', () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (state.byId.has(id) && id !== state.selected?.id) select(id);
  });
}

main().catch((error) => showBanner(`Could not load the viewer data: ${esc(error.message)}. Run <code>pixi run build</code>, then <code>pixi run serve</code>.`));
