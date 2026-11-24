// Third-party API integration: Open-Meteo (https://open-meteo.com) - free, no API key.
// 1) Geocoding API turns a city name into latitude/longitude  2) Forecast API gives the weather for one day.
// The browser never calls Open-Meteo directly: our server does, so results can be validated and cached.
const GEO = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";
const CACHE_MS = 30 * 60 * 1000;
const cache = new Map();

const fail = (status, message) => Object.assign(new Error(message), { status });

// WMO weather codes -> short text
function describe(code) {
  if (code === 0) return "Clear sky";
  if (code <= 3) return "Partly cloudy";
  if (code <= 48) return "Fog";
  if (code <= 57) return "Drizzle";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Rain showers";
  if (code <= 86) return "Snow showers";
  return "Thunderstorm";
}

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000); // do not wait forever for the other service
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("bad status " + res.status);
    return await res.json();
  } catch {
    throw fail(502, "Weather service is not available right now. Please try again later.");
  } finally { clearTimeout(timer); }
}

async function getForecast(cityInput, dateInput) {
  const city = String(cityInput || "").trim();
  const date = String(dateInput || "");
  if (!/^[\p{L} .'-]{2,60}$/u.test(city)) throw fail(400, "Enter a valid city name");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw fail(400, "Choose a valid date");
  const days = (Date.parse(date) - Date.parse(new Date().toISOString().slice(0, 10))) / 86400000;
  if (days < 0 || days > 15) throw fail(400, "Forecast is available from today up to 15 days ahead");

  const key = city.toLowerCase() + "|" + date, hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;

  const geo = await getJson(`${GEO}?name=${encodeURIComponent(city)}&count=1&language=en&format=json`);
  const place = geo.results && geo.results[0];
  if (!place) throw fail(404, "City not found");
  const f = await getJson(`${FORECAST}?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&start_date=${date}&end_date=${date}`);
  const d = f.daily;
  if (!d || !d.time || !d.time.length) throw fail(502, "Weather service returned no data");

  const rain = d.precipitation_probability_max[0] ?? 0;
  const data = {
    city: place.name, country: place.country || "", date,
    summary: describe(d.weather_code[0]),
    tempMax: Math.round(d.temperature_2m_max[0]), tempMin: Math.round(d.temperature_2m_min[0]),
    rainChance: rain,
    advice: rain >= 60 ? "Rain is likely - outdoor work may be delayed." : rain >= 30 ? "Some chance of rain." : "Good weather for the visit."
  };
  cache.set(key, { data, expires: Date.now() + CACHE_MS });
  return data;
}

module.exports = { getForecast };
