import {
  m3ToKwh, detectUnit, labelDays, summarisePeriod, annualFromFit, confidence,
  weekly, monthly, demoData, addDays, usable,
} from './lib.js';
import {
  fetchAccount, gasMetersFromAccount, fetchDailyConsumption, fetchGasUnitRate,
  geocodePostcode, fetchDailyTemps,
} from './api.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'boiler-compare-settings';
const FIELDS = ['apiKey', 'account', 'install', 'postcode', 'unit', 'cv', 'base', 'exclude', 'rate', 'history'];

let state = null; // { days, demo, ratePence, notes }
const charts = {};

// ---------- settings ----------

function loadSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { /* storage unavailable */ }
  if (!saved) return;
  for (const f of FIELDS) if (saved[f] != null && $(f)) $(f).value = saved[f];
  $('remember').checked = true;
}

function saveSettings() {
  try {
    if ($('remember').checked) {
      localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(FIELDS.map((f) => [f, $(f).value]))));
    } else {
      localStorage.removeItem(STORE_KEY);
    }
  } catch { /* storage unavailable */ }
}

function settings() {
  return {
    install: $('install').value,
    unit: $('unit').value,
    cv: parseFloat($('cv').value) || 39.5,
    base: parseFloat($('base').value) || 15.5,
    exclude: Math.max(0, parseInt($('exclude').value, 10) || 0),
    rate: parseFloat($('rate').value) || null,
    years: parseInt($('history').value, 10) || 3,
  };
}

function setStatus(msg, isError = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', isError);
}

// ---------- loading ----------

async function loadReal() {
  const apiKey = $('apiKey').value.trim();
  const account = $('account').value.trim();
  const s = settings();
  if (!apiKey || !account) return setStatus('Enter your API key and account number first.', true);
  if (!s.install) return setStatus('Enter the date the new boiler was installed.', true);
  saveSettings();

  setStatus('Looking up your account…');
  const acct = await fetchAccount(apiKey, account);
  const meters = gasMetersFromAccount(acct);
  if (meters.length === 0) throw new Error('No gas meters found on this account.');
  // Only the current property's meters, in case the account has moved home.
  const current = meters.filter((m) => m.postcode === meters[0].postcode);

  const today = new Date().toISOString().slice(0, 10);
  const from = addDays(today, -365 * s.years);
  const byDate = new Map();
  const notes = [];
  for (const m of current) {
    setStatus(`Downloading readings for gas meter ${m.serial}…`);
    const rows = await fetchDailyConsumption(apiKey, m.mprn, m.serial, from,
      (n) => setStatus(`Downloading readings for gas meter ${m.serial}… ${n} days`));
    if (rows.length === 0) continue;
    const unit = s.unit === 'auto' ? detectUnit(rows.map((r) => r.value)) : s.unit;
    notes.push(`Meter ${m.serial}: ${rows.length} days from ${rows[0].date}, read as ${unit === 'm3' ? 'm³' : 'kWh'}.`);
    for (const r of rows) {
      const kwh = unit === 'm3' ? m3ToKwh(r.value, s.cv) : r.value;
      byDate.set(r.date, (byDate.get(r.date) || 0) + kwh);
    }
  }
  if (byDate.size === 0) throw new Error("Octopus returned no gas readings. Smart meter data can take a few days to appear after setup.");

  const dates = [...byDate.keys()].sort();
  const postcode = $('postcode').value.trim() || current[0].postcode;
  if (!postcode) throw new Error('Enter your postcode so we can fetch local weather.');
  if (!$('postcode').value.trim()) $('postcode').value = postcode;

  setStatus(`Fetching weather for ${postcode}…`);
  const { lat, lon } = await geocodePostcode(postcode);
  const temps = await fetchDailyTemps(lat, lon, dates[0], addDays(today, -1));

  let ratePence = s.rate;
  if (!ratePence) {
    const r = await fetchGasUnitRate(current[0].agreements);
    if (r) { ratePence = r.pence; notes.push(`Gas unit rate ${r.pence.toFixed(2)}p/kWh from tariff ${r.tariff}.`); }
  }

  const days = dates.map((date) => ({ date, kwh: byDate.get(date), tmean: temps.has(date) ? temps.get(date) : null }));
  state = { days, demo: false, ratePence, notes };
  setStatus(`Loaded ${days.length} days of gas data.`);
  render();
}

function loadDemo() {
  const s = settings();
  state = { days: demoData(s.install || '2026-07-01'), demo: true, ratePence: s.rate || 6.3, notes: [] };
  setStatus('Loaded demo data.');
  render();
}

// ---------- rendering ----------

const fmt = (n, dp = 0) => n.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtDate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function render() {
  if (!state) return;
  const s = settings();
  const labelled = labelDays(state.days, s.install, { excludeDays: s.exclude, hddBase: s.base });
  const old = summarisePeriod(labelled, 'old');
  const neu = summarisePeriod(labelled, 'new');
  const refHdds = labelled.filter((d) => d.hdd != null).slice(-365).map((d) => d.hdd);

  $('results').hidden = false;
  $('demoBanner').hidden = !state.demo;
  renderTiles(old, neu, refHdds);
  renderWarnings(old, neu, labelled);
  renderScatter(labelled, old, neu);
  renderWeekly(labelled);
  renderTable(labelled);
  state.labelled = labelled;
}

function tile(label, value, detail, swatch) {
  const sw = swatch ? `<span class="swatch" style="background:${swatch}"></span>` : '';
  return `<div class="tile"><div class="label">${sw}${label}</div><div class="value">${value}</div><div class="detail">${detail}</div></div>`;
}

function renderTiles(old, neu, refHdds) {
  const parts = [];
  const slopeTile = (sum, name, colour) => sum.fit
    ? tile(`${name}: kWh per degree day`, fmt(sum.fit.b, 2),
      `±${fmt(sum.fit.seB * 1.96, 2)} · ${fmt(sum.fit.a, 1)} kWh/day warm-day baseline · ${sum.days} days`, colour)
    : tile(`${name}: kWh per degree day`, '–', `Not enough data (${sum.days} days)`, colour);
  parts.push(slopeTile(old, 'Old boiler', css('--series-old')));
  parts.push(slopeTile(neu, 'New boiler', css('--series-new')));

  let verdict = '';
  if (old.fit && neu.fit) {
    const change = (neu.fit.b - old.fit.b) / old.fit.b;
    const se = Math.sqrt(old.fit.seB ** 2 + neu.fit.seB ** 2) / old.fit.b;
    parts.push(tile('Heating gas per degree day', `${change <= 0 ? '−' : '+'}${fmt(Math.abs(change) * 100, 0)}%`,
      `new vs old, ±${fmt(se * 1.96 * 100, 0)}% (95% range)`));

    const aOld = annualFromFit(old.fit, refHdds);
    const aNew = annualFromFit(neu.fit, refHdds);
    const saved = aOld - aNew;
    const money = state.ratePence ? ` · about £${fmt((Math.abs(saved) * state.ratePence) / 100)} at ${fmt(state.ratePence, 2)}p/kWh` : '';
    parts.push(tile(saved >= 0 ? 'Yearly gas saving, same weather' : 'Yearly extra gas, same weather', `${fmt(Math.abs(saved))} kWh`,
      `${fmt(aOld)} kWh old vs ${fmt(aNew)} kWh new${money}`));

    const better = change < 0;
    verdict = `In the same weather, the new boiler is using about <strong>${fmt(Math.abs(change) * 100, 0)}% ${better ? 'less' : 'more'}</strong> gas for heating, ` +
      `and ${neu.fit.a < old.fit.a ? 'less' : 'more'} on warm days (${fmt(neu.fit.a, 1)} vs ${fmt(old.fit.a, 1)} kWh/day for hot water and cooking).`;
  }
  $('tiles').innerHTML = parts.join('');
  $('verdict').innerHTML = verdict;
}

function renderWarnings(old, neu, labelled) {
  const w = [];
  const cNew = confidence(neu);
  const cOld = confidence(old);
  if (cNew === 'none') {
    w.push(`<strong>Not enough data since the install yet.</strong> We need at least a couple of weeks of readings after ${fmtDate(settings().install)}.`);
  } else if (cNew === 'low' || cNew === 'medium') {
    w.push(`<strong>The new boiler hasn't seen much cold weather yet</strong> (${fmt(neu.totalHdd)} degree days since install, vs ${fmt(old.totalHdd)} for the old one). ` +
      `The heating figure will firm up as winter goes on, so treat it as provisional for now. The warm-day baseline is already reliable.`);
  }
  if (cOld === 'none' || cOld === 'low') {
    w.push(`<strong>Not much history before the install.</strong> Only ${old.days} usable days for the old boiler, so its figure is uncertain.`);
  }
  const missing = labelled.filter((d) => d.period !== 'transition' && !usable(d)).length;
  if (missing > 20) w.push(`${missing} days were skipped because the meter reported zero or weather data wasn't available yet.`);
  for (const n of state.notes) w.push(n);
  $('warnings').innerHTML = w.map((x) => `<div class="warn">${x}</div>`).join('');
}

function legend(el, items) {
  $(el).innerHTML = items.map(([label, colour]) => `<span style="--c:${colour}">${label}</span>`).join('');
}

function baseOptions() {
  const grid = css('--grid'), text = css('--text-secondary');
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: css('--surface-1'), titleColor: css('--text-primary'), bodyColor: css('--text-secondary'),
        borderColor: css('--border'), borderWidth: 1, padding: 10, boxPadding: 4,
      },
    },
    scales: {
      x: { grid: { color: grid }, border: { display: false }, ticks: { color: text } },
      y: { grid: { color: grid }, border: { display: false }, ticks: { color: text }, beginAtZero: true },
    },
  };
}

function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function renderScatter(labelled, old, neu) {
  const cOld = css('--series-old'), cNew = css('--series-new');
  const pts = (p) => labelled.filter((d) => d.period === p && usable(d)).map((d) => ({ x: d.hdd, y: d.kwh, date: d.date }));
  const maxX = Math.max(1, ...labelled.filter(usable).map((d) => d.hdd));
  const line = (fit) => fit ? [{ x: 0, y: fit.a }, { x: maxX, y: fit.a + fit.b * maxX }] : [];
  const surface = css('--surface-1');
  const datasets = [
    { type: 'scatter', label: 'Old boiler', data: pts('old'), backgroundColor: withAlpha(cOld, 0.45), borderColor: surface, borderWidth: 1, pointRadius: 3.5, pointHoverRadius: 6 },
    { type: 'scatter', label: 'New boiler', data: pts('new'), backgroundColor: withAlpha(cNew, 0.55), borderColor: surface, borderWidth: 1, pointRadius: 3.5, pointHoverRadius: 6 },
    { type: 'line', label: 'Old boiler trend', data: line(old.fit), borderColor: cOld, borderWidth: 2, pointRadius: 0, pointHitRadius: 0 },
    { type: 'line', label: 'New boiler trend', data: line(neu.fit), borderColor: cNew, borderWidth: 2, pointRadius: 0, pointHitRadius: 0 },
  ];
  legend('scatterLegend', [['Old boiler', cOld], ['New boiler', cNew]]);
  const opts = baseOptions();
  opts.scales.x = { ...opts.scales.x, type: 'linear', min: 0, title: { display: true, text: 'Heating degree days (colder →)', color: css('--text-secondary') } };
  opts.scales.y.title = { display: true, text: 'Gas used that day (kWh)', color: css('--text-secondary') };
  opts.plugins.tooltip.filter = (item) => item.dataset.type === 'scatter';
  opts.plugins.tooltip.callbacks = {
    title: (items) => fmtDate(items[0].raw.date),
    label: (item) => `${item.dataset.label}: ${fmt(item.raw.y, 1)} kWh · ${fmt(item.raw.x, 1)} degree days`,
  };
  draw('scatter', { data: { datasets }, options: opts });
}

function renderWeekly(labelled) {
  const weeks = weekly(labelled);
  const colours = { old: css('--series-old'), new: css('--series-new'), transition: css('--series-neutral') };
  const names = { old: 'Old boiler', new: 'New boiler', transition: 'Install week(s)' };
  const labels = weeks.map((w) => w.week);
  legend('weeklyLegend', [['Old boiler', colours.old], ['New boiler', colours.new], ['Install period (ignored)', colours.transition]]);

  const tickCb = function (value) {
    const iso = this.getLabelForValue(value);
    return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  };
  const bar = { borderRadius: { topLeft: 3, topRight: 3 }, borderSkipped: 'bottom', categoryPercentage: 1, barPercentage: 0.85 };

  const o1 = baseOptions();
  o1.scales.x = { ...o1.scales.x, grid: { display: false }, ticks: { ...o1.scales.x.ticks, maxTicksLimit: 12, autoSkip: true, callback: tickCb, maxRotation: 0 } };
  o1.scales.y.title = { display: true, text: 'kWh per week', color: css('--text-secondary') };
  o1.plugins.tooltip.callbacks = {
    title: (items) => `Week of ${fmtDate(items[0].label)}`,
    label: (item) => {
      const w = weeks[item.dataIndex];
      return [`${names[w.period]}: ${fmt(w.kwh)} kWh`, `${fmt(w.hdd)} degree days`, w.hdd > 5 ? `${fmt(w.kwh / w.hdd, 1)} kWh per degree day` : 'Too warm for a per-degree-day figure'];
    },
  };
  draw('weekly', {
    type: 'bar',
    data: { labels, datasets: [{ data: weeks.map((w) => w.kwh), backgroundColor: weeks.map((w) => colours[w.period]), ...bar }] },
    options: o1,
  });

  const o2 = baseOptions();
  o2.scales.x = { ...o1.scales.x };
  o2.scales.y.ticks = { ...o2.scales.y.ticks, maxTicksLimit: 3 };
  o2.plugins.tooltip.callbacks = {
    title: (items) => `Week of ${fmtDate(items[0].label)}`,
    label: (item) => `${fmt(item.raw)} degree days`,
  };
  draw('weeklyHdd', {
    type: 'bar',
    data: { labels, datasets: [{ data: weeks.map((w) => w.hdd), backgroundColor: css('--series-neutral'), ...bar }] },
    options: o2,
  });
}

function renderTable(labelled) {
  const names = { old: 'Old', new: 'New', transition: 'Install' };
  const rows = monthly(labelled).reverse();
  $('monthTable').querySelector('tbody').innerHTML = rows.map((r) => `<tr>
    <td>${new Date(r.month + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })}</td>
    <td>${names[r.period]}</td>
    <td class="num">${fmt(r.kwh)}</td>
    <td class="num">${fmt(r.hdd)}</td>
    <td class="num">${r.hdd > 20 ? fmt(r.kwh / r.hdd, 2) : '–'}</td>
    <td class="num">${r.days}</td></tr>`).join('');
}

function draw(id, config) {
  charts[id]?.destroy();
  charts[id] = new Chart($(id), config);
}

function downloadCsv() {
  if (!state?.labelled) return;
  const lines = ['date,gas_kwh,mean_temp_c,heating_degree_days,boiler'];
  for (const d of state.labelled) {
    lines.push([d.date, d.kwh.toFixed(3), d.tmean ?? '', d.hdd != null ? d.hdd.toFixed(2) : '', d.period].join(','));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = 'gas-usage-daily.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- wiring ----------

async function run(fn) {
  const buttons = [$('go'), $('demo')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (err) {
    console.error(err);
    setStatus(err.message, true);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

loadSettings();
$('form').addEventListener('submit', (e) => { e.preventDefault(); run(loadReal); });
$('demo').addEventListener('click', () => run(loadDemo));
$('forget').addEventListener('click', () => {
  try { localStorage.removeItem(STORE_KEY); } catch { /* storage unavailable */ }
  $('apiKey').value = ''; $('account').value = ''; $('remember').checked = false;
  setStatus('Saved details removed from this browser.');
});
$('csv').addEventListener('click', downloadCsv);
// Settings that only change the analysis re-render without refetching.
for (const id of ['install', 'base', 'exclude', 'rate']) $(id).addEventListener('change', () => { if (state) { if (id === 'rate') state.ratePence = parseFloat($('rate').value) || state.ratePence; render(); saveSettings(); } });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
