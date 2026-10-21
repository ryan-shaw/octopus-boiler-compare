// Network calls: Octopus Energy API, postcodes.io and Open-Meteo.
// Everything runs in the browser; the API key is only ever sent to api.octopus.energy.

const OCTOPUS = 'https://api.octopus.energy/v1';

function authHeader(apiKey) {
  // Octopus uses HTTP basic auth with the key as the username and no password.
  return { Authorization: 'Basic ' + btoa(apiKey + ':') };
}

async function getJson(url, headers = {}) {
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw new Error(`Couldn't reach ${new URL(url).host} (${err.message}). Check your connection or any ad/tracker blocker.`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Octopus rejected the API key. Copy it again from your Octopus dashboard (Personal details > API access).');
  }
  if (res.status === 404) throw new Error(`Not found: ${url.replace(OCTOPUS, '')}. Check the account number.`);
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return res.json();
}

export async function fetchAccount(apiKey, accountNumber) {
  return getJson(`${OCTOPUS}/accounts/${encodeURIComponent(accountNumber.trim().toUpperCase())}/`, authHeader(apiKey));
}

// Pull out every gas meter on the account, newest property first.
export function gasMetersFromAccount(account) {
  const meters = [];
  const props = [...(account.properties || [])].sort((a, b) => (b.moved_in_at || '').localeCompare(a.moved_in_at || ''));
  for (const p of props) {
    for (const mp of p.gas_meter_points || []) {
      for (const m of mp.meters || []) {
        if (!m.serial_number) continue;
        meters.push({ mprn: mp.mprn, serial: m.serial_number, postcode: p.postcode, agreements: mp.agreements || [] });
      }
    }
  }
  return meters;
}

// Daily gas consumption for one meter, in the meter's native unit (m³ or kWh).
export async function fetchDailyConsumption(apiKey, mprn, serial, periodFrom, onProgress) {
  let url = `${OCTOPUS}/gas-meter-points/${mprn}/meters/${encodeURIComponent(serial)}/consumption/` +
    `?period_from=${periodFrom}T00:00:00Z&group_by=day&order_by=period&page_size=25000`;
  const out = [];
  while (url) {
    const page = await getJson(url, authHeader(apiKey));
    for (const r of page.results || []) {
      // interval_start carries the local offset, so its first 10 chars are the UK date.
      out.push({ date: r.interval_start.slice(0, 10), value: r.consumption });
    }
    onProgress?.(out.length);
    url = page.next;
  }
  return out;
}

// Current gas unit rate (p/kWh inc VAT) from the active agreement, if we can work it out.
export async function fetchGasUnitRate(agreements) {
  const now = new Date().toISOString();
  const active = agreements.find((a) => a.valid_from <= now && (!a.valid_to || a.valid_to > now)) || agreements[agreements.length - 1];
  if (!active) return null;
  const tariff = active.tariff_code; // e.g. G-1R-VAR-22-11-01-C
  const product = tariff.replace(/^G-1R-/, '').replace(/-[A-P]$/, '');
  try {
    const data = await getJson(`${OCTOPUS}/products/${product}/gas-tariffs/${tariff}/standard-unit-rates/?page_size=5`);
    const current = (data.results || []).find((r) => r.valid_from <= now && (!r.valid_to || r.valid_to > now)) || data.results?.[0];
    return current ? { pence: current.value_inc_vat, tariff } : null;
  } catch {
    return null;
  }
}

export async function geocodePostcode(postcode) {
  const pc = postcode.replace(/\s+/g, '');
  const data = await getJson(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`);
  if (!data.result) throw new Error(`Couldn't find postcode ${postcode}`);
  return { lat: data.result.latitude, lon: data.result.longitude };
}

// Daily mean air temperature from Open-Meteo's historical archive (lags a few days behind today).
export async function fetchDailyTemps(lat, lon, startDate, endDate) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    `&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_mean&timezone=Europe%2FLondon`;
  const data = await getJson(url);
  const temps = new Map();
  const { time = [], temperature_2m_mean: t = [] } = data.daily || {};
  time.forEach((d, i) => { if (t[i] != null) temps.set(d, t[i]); });
  return temps;
}
