# Boiler gas comparison

A static web page that pulls daily gas readings from the Octopus Energy API and compares gas use before and after a boiler replacement, adjusted for the weather.

## How it works

- Daily gas consumption comes from the Octopus API (`/v1/gas-meter-points/{mprn}/meters/{serial}/consumption/`). SMETS2 readings in m³ are converted to kWh with the standard formula (m³ × 1.02264 × calorific value ÷ 3.6).
- Daily mean temperatures for the property's postcode come from the [Open-Meteo](https://open-meteo.com/) historical archive, located via [postcodes.io](https://postcodes.io/).
- Heating degree days (base 15.5°C by default) measure how much heating each day needed.
- For each boiler, a straight line is fitted through daily kWh against degree days. The slope is heating gas per degree day, the intercept is the warm-day baseline (hot water and cooking).
- Both lines are then run over the latest 12 months of weather to give a like-for-like annual figure.

## Privacy

Everything runs in the browser. The API key is only sent to `api.octopus.energy`, and is stored in `localStorage` only if "Remember these details" is ticked. Nothing is stored in this repo or on any server.

## Running locally

Any static file server works, e.g. `python3 -m http.server`, then open http://localhost:8000. Use "Try with demo data" to see it without an Octopus account.

Chart.js 4.4.1 is vendored in `vendor/` (MIT licence).
