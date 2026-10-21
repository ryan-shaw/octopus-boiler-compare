// Pure helpers: unit conversion, degree days, regression and period summaries.
// No DOM or network code here so it can be tested in Node.

// Standard UK conversion used on gas bills: m³ × volume correction × calorific value ÷ 3.6
export const VOLUME_CORRECTION = 1.02264;
export const DEFAULT_CALORIFIC_VALUE = 39.5; // MJ/m³, typical UK value
export const DEFAULT_HDD_BASE = 15.5; // °C, UK convention

export function m3ToKwh(m3, calorificValue = DEFAULT_CALORIFIC_VALUE) {
  return (m3 * VOLUME_CORRECTION * calorificValue) / 3.6;
}

// SMETS2 gas meters report m³ and SMETS1 meters report kWh, and the API doesn't
// say which. Daily kWh figures are roughly 11× larger than m³ figures, so the
// 95th percentile of daily readings separates them reliably.
export function detectUnit(dailyValues) {
  const vals = dailyValues.filter((v) => v > 0).sort((a, b) => a - b);
  if (vals.length === 0) return 'm3';
  const p95 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.95))];
  return p95 > 25 ? 'kWh' : 'm3';
}

export function heatingDegreeDays(meanTemp, base = DEFAULT_HDD_BASE) {
  return Math.max(0, base - meanTemp);
}

// Ordinary least squares fit y = a + b·x, with the standard error of the slope.
export function linearFit(points) {
  const n = points.length;
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (const [x, y] of points) { sx += x; sy += y; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  let sse = 0;
  for (const [x, y] of points) sse += (y - (a + b * x)) ** 2;
  const r2 = syy === 0 ? 1 : 1 - sse / syy;
  const seB = n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : NaN;
  return { a, b, r2, seB, n };
}

export function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// days: [{ date: 'YYYY-MM-DD', kwh, tmean }] (tmean may be null when weather is missing)
// Returns one row per day with HDD and which boiler it belongs to, or 'transition'
// for days inside the exclusion window around the install date.
export function labelDays(days, installDate, { excludeDays = 7, hddBase = DEFAULT_HDD_BASE } = {}) {
  const startEx = addDays(installDate, -excludeDays);
  const endEx = addDays(installDate, excludeDays);
  return days.map((d) => {
    let period;
    if (d.date < startEx) period = 'old';
    else if (d.date >= endEx) period = 'new';
    else period = 'transition';
    const hdd = d.tmean == null ? null : heatingDegreeDays(d.tmean, hddBase);
    return { ...d, hdd, period };
  });
}

// Usable days for the model: weather present and a non-zero reading
// (a zero almost always means the meter didn't report, since a combi heats water daily).
export function usable(day) {
  return day.hdd != null && day.kwh > 0;
}

export function summarisePeriod(labelled, period) {
  const rows = labelled.filter((d) => d.period === period && usable(d));
  const fit = linearFit(rows.map((d) => [d.hdd, d.kwh]));
  const totalKwh = rows.reduce((s, d) => s + d.kwh, 0);
  const totalHdd = rows.reduce((s, d) => s + d.hdd, 0);
  return {
    period,
    days: rows.length,
    from: rows[0]?.date ?? null,
    to: rows[rows.length - 1]?.date ?? null,
    totalKwh,
    totalHdd,
    fit,
  };
}

// Annual use for a boiler's fitted model over a reference year of daily HDD values.
export function annualFromFit(fit, referenceHdds) {
  if (!fit) return null;
  return referenceHdds.reduce((s, h) => s + Math.max(0, fit.a + fit.b * h), 0);
}

// How much we trust the comparison, based on how much heating weather each side saw.
export function confidence(summary) {
  if (!summary.fit || summary.days < 14) return 'none';
  if (summary.totalHdd < 300 || summary.days < 45) return 'low';
  if (summary.totalHdd < 1000) return 'medium';
  return 'high';
}

// Group daily rows into Monday-starting weeks.
export function weekly(labelled) {
  const weeks = new Map();
  for (const d of labelled) {
    const dt = new Date(d.date + 'T00:00:00Z');
    const dow = (dt.getUTCDay() + 6) % 7;
    const wk = addDays(d.date, -dow);
    if (!weeks.has(wk)) weeks.set(wk, { week: wk, kwh: 0, hdd: 0, days: 0, periods: {} });
    const w = weeks.get(wk);
    w.kwh += d.kwh;
    if (d.hdd != null) w.hdd += d.hdd;
    w.days += 1;
    w.periods[d.period] = (w.periods[d.period] || 0) + 1;
  }
  return [...weeks.values()].map((w) => ({
    ...w,
    period: Object.entries(w.periods).sort((a, b) => b[1] - a[1])[0][0],
  }));
}

export function monthly(labelled) {
  const months = new Map();
  for (const d of labelled) {
    const m = d.date.slice(0, 7);
    if (!months.has(m)) months.set(m, { month: m, kwh: 0, hdd: 0, days: 0, periods: {} });
    const r = months.get(m);
    r.kwh += d.kwh;
    if (d.hdd != null) r.hdd += d.hdd;
    r.days += 1;
    r.periods[d.period] = (r.periods[d.period] || 0) + 1;
  }
  return [...months.values()].map((r) => ({
    ...r,
    period: Object.entries(r.periods).sort((a, b) => b[1] - a[1])[0][0],
  }));
}

// Deterministic fake data so the page can be tried without an Octopus account.
export function demoData(installDate, { days = 760, endDate } = {}) {
  const end = endDate ?? new Date().toISOString().slice(0, 10);
  const start = addDays(end, -days);
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const out = [];
  for (let i = 0; i <= days; i++) {
    const date = addDays(start, i);
    const doy = (new Date(date + 'T00:00:00Z') - new Date(date.slice(0, 4) + '-01-01T00:00:00Z')) / 864e5;
    const tmean = 10.5 - 6.5 * Math.cos(((doy - 20) / 365) * 2 * Math.PI) + (rand() - 0.5) * 6;
    const hdd = heatingDegreeDays(tmean);
    const isNew = date >= installDate;
    const base = isNew ? 7 : 9;
    const slope = isNew ? 4.3 : 5.4;
    const kwh = Math.max(0.5, base + slope * hdd + (rand() - 0.5) * 8);
    out.push({ date, kwh, tmean });
  }
  return out;
}
