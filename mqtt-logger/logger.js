const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const https = require('https');
const chokidar = require('chokidar');
const uploadLogger = require('./upload-logger');
const { startServer } = require('./admin-api');

// Configuration
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://mosquitto:1883';
const MQTT_USER = process.env.MQTT_USER || 'admin';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const DATA_DIR = '/data';
const HOURS_TO_KEEP = 24;

// Load weather services configuration
let weatherConfig = { stations: {} };
const weatherConfigFile = path.join(__dirname, 'weather-services.json');
if (fs.existsSync(weatherConfigFile)) {
  weatherConfig = JSON.parse(fs.readFileSync(weatherConfigFile, 'utf8'));
  console.log(`Loaded weather services config with ${Object.keys(weatherConfig.stations).length} stations`);
}

// Track last post time per station (for rate limiting)
const lastWindyPost = {};
const lastWuPost = {};

// Check if station is a FANET station (for silent rate limiting)
function isFanetStation(stationId) {
  return stationId.startsWith('fanet-');
}

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load existing data
let stationsData = {};
const dataFile = path.join(DATA_DIR, 'stations.json');

if (fs.existsSync(dataFile)) {
  stationsData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  console.log('Loaded existing data');
}

// Clean old data
function cleanOldData() {
  const cutoff = Date.now() - (HOURS_TO_KEEP * 60 * 60 * 1000);
  
  for (const stationId in stationsData) {
    if (stationsData[stationId].history) {
      stationsData[stationId].history = stationsData[stationId].history.filter(
        reading => reading.timestamp > cutoff
      );
    }
  }
  
  saveData();
  console.log('Cleaned old data');
}

// Save data to file
function saveData() {
  fs.writeFileSync(dataFile, JSON.stringify(stationsData, null, 2));
}

// Store reading
function storeReading(stationId, type, data) {
  if (!stationsData[stationId]) {
    stationsData[stationId] = {
      id: stationId,
      type: type,
      history: []
    };
  } else {
    // Update type in case it changed (e.g., FANET-Direct -> MQTT-FANET)
    stationsData[stationId].type = type;
  }

  // Carry forward values from previous reading that aren't in new data
  const prevReading = stationsData[stationId].lastReading || {};
  const reading = {
    timestamp: Date.now(),
    // Carry forward location if not in new data
    lat: data.lat !== undefined ? data.lat : prevReading.lat,
    lon: data.lon !== undefined ? data.lon : prevReading.lon,
    alt: data.alt !== undefined ? data.alt : prevReading.alt,
    // Carry forward voltages if not in new data
    stationVoltage: data.stationVoltage !== undefined ? data.stationVoltage : prevReading.stationVoltage,
    batteryPercent: data.batteryPercent !== undefined ? data.batteryPercent : prevReading.batteryPercent,
    ...data
  };

  stationsData[stationId].history.push(reading);
  stationsData[stationId].lastReading = reading;
  stationsData[stationId].lastSeen = new Date().toISOString();
  
  // Keep only last 1000 readings per station
  if (stationsData[stationId].history.length > 1000) {
    stationsData[stationId].history.shift();
  }
  
  saveData();
}

// =====================
// Weather Service Posting
// =====================

// Helper to make HTTPS GET request
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

// Validate rain values
function validateRain(rain1h, rain1d, cfg) {
  let validRain1h = null;
  let validRain1d = null;

  if (rain1h !== undefined && !isNaN(rain1h)) {
    if (rain1h >= 0 && rain1h <= cfg.options.maxRain1h) {
      validRain1h = rain1h;
    } else {
      console.log(`[${cfg.name}] Rejected excessive 1h rain: ${rain1h.toFixed(1)}mm (max: ${cfg.options.maxRain1h}mm)`);
    }
  }

  if (rain1d !== undefined && !isNaN(rain1d)) {
    if (rain1d >= 0 && rain1d <= cfg.options.maxRain1d) {
      validRain1d = rain1d;
    } else {
      console.log(`[${cfg.name}] Rejected excessive 24h rain: ${rain1d.toFixed(1)}mm (max: ${cfg.options.maxRain1d}mm)`);
    }
  }

  // Sanity check: 1h rain should not exceed 24h rain
  if (validRain1h !== null && validRain1d !== null && validRain1h > validRain1d) {
    console.log(`[${cfg.name}] Invalid: 1h rain (${validRain1h.toFixed(1)}mm) > 24h rain (${validRain1d.toFixed(1)}mm). Discarding.`);
    validRain1h = null;
    validRain1d = null;
  }

  return { validRain1h, validRain1d };
}

// Post to Weather Underground
async function postToWeatherUnderground(stationFromId, payload, timestamp, source = 'MQTT') {
  const cfg = weatherConfig.stations[stationFromId];
  if (!cfg || !cfg.wunderground) return;

  // Check rate limit (2 minutes)
  const rateLimitMs = (weatherConfig.wuRateLimitMinutes || 2) * 60 * 1000;
  const now = Date.now();
  const lastPost = lastWuPost[stationFromId] || 0;
  const isFanet = isFanetStation(stationFromId);

  if (now - lastPost < rateLimitMs) {
    // Silent rate limiting for FANET stations (no console or upload logs)
    if (!isFanet) {
      const waitSecs = Math.round((rateLimitMs - (now - lastPost)) / 1000);
      console.log(`[${cfg.name}] WU rate limited, ${waitSecs}s remaining`);
      uploadLogger.addLog({
        service: 'wu',
        status: 'rate_limited',
        stationId: stationFromId,
        stationName: cfg.name,
        source: source,
        waitSeconds: waitSecs
      });
    }
    return;
  }

  const hasWind = payload.wind_speed !== undefined;
  const wuDateUtc = new Date(timestamp * 1000).toISOString().slice(0, 19).replace('T', ' ');

  // Parse values
  const windSpeed = parseFloat(payload.wind_speed);
  const windGust = parseFloat(payload.wind_gust);
  const windDir = parseFloat(payload.wind_direction);
  const tempC = parseFloat(payload.temperature);
  let humidity = parseFloat(payload.relative_humidity);
  if (humidity === 0) humidity = NaN;

  // Pressure conversion (Pa → hPa)
  let pressure = parseFloat(payload.barometric_pressure);
  if (!isNaN(pressure)) {
    pressure /= 100;
    if (pressure < 850) pressure = NaN;
  }

  // Validate rain
  const { validRain1h, validRain1d } = validateRain(
    parseFloat(payload.rainfall_1h),
    parseFloat(payload.rainfall_1d),
    cfg
  );

  // Build params
  const params = [
    `ID=${cfg.wunderground.id}`,
    `PASSWORD=${cfg.wunderground.password}`,
    `dateutc=${encodeURIComponent(wuDateUtc)}`
  ];

  if (!isNaN(windSpeed)) params.push(`windspeedmph=${(windSpeed * 2.23694).toFixed(1)}`);
  if (!isNaN(windGust)) params.push(`windgustmph=${(windGust * 2.23694).toFixed(1)}`);
  if (!isNaN(windDir)) params.push(`winddir=${windDir}`);
  if (!isNaN(tempC) && (!cfg.options.tempOnlyIfWind || hasWind)) {
    params.push(`tempf=${(tempC * 9 / 5 + 32).toFixed(1)}`);
  }
  if (!isNaN(humidity) && (!cfg.options.humidityOnlyIfWind || hasWind)) {
    params.push(`humidity=${humidity.toFixed(0)}`);
  }
  if (!isNaN(pressure)) params.push(`baromin=${(pressure * 0.02953).toFixed(3)}`);

  if (cfg.options.rain) {
    if (validRain1h !== null) params.push(`rainin=${(validRain1h / 25.4).toFixed(2)}`);
    if (validRain1d !== null) params.push(`dailyrainin=${(validRain1d / 25.4).toFixed(2)}`);
  }

  const url = `https://weatherstation.wunderground.com/weatherstation/updateweatherstation.php?${params.join('&')}`;

  try {
    const result = await httpsGet(url);
    if (result.status === 200) {
      lastWuPost[stationFromId] = now;
      // Only log to console for non-FANET stations
      if (!isFanet) {
        console.log(`[${cfg.name}] Posted to Weather Underground`);
      }
      uploadLogger.addLog({
        service: 'wu',
        status: 'success',
        stationId: stationFromId,
        stationName: cfg.name,
        source: source,
        httpStatus: result.status
      });
    } else {
      console.log(`[${cfg.name}] WU error: ${result.status} - ${result.data}`);
      uploadLogger.addLog({
        service: 'wu',
        status: 'error',
        stationId: stationFromId,
        stationName: cfg.name,
        source: source,
        httpStatus: result.status,
        error: result.data
      });
    }
  } catch (err) {
    console.error(`[${cfg.name}] WU request failed:`, err.message);
    uploadLogger.addLog({
      service: 'wu',
      status: 'error',
      stationId: stationFromId,
      stationName: cfg.name,
      source: source,
      error: err.message
    });
  }
}

// Post to Windy
async function postToWindy(stationFromId, payload, timestamp, source = 'MQTT') {
  const cfg = weatherConfig.stations[stationFromId];
  if (!cfg || !cfg.windy) return;

  // Check rate limit (5 minutes)
  const rateLimitMs = (weatherConfig.windyRateLimitMinutes || 5) * 60 * 1000;
  const now = Date.now();
  const lastPost = lastWindyPost[stationFromId] || 0;
  const isFanet = isFanetStation(stationFromId);

  if (now - lastPost < rateLimitMs) {
    // Silent rate limiting for FANET stations (no console or upload logs)
    if (!isFanet) {
      const waitSecs = Math.round((rateLimitMs - (now - lastPost)) / 1000);
      console.log(`[${cfg.name}] Windy rate limited, ${waitSecs}s remaining`);
      uploadLogger.addLog({
        service: 'windy',
        status: 'rate_limited',
        stationId: stationFromId,
        stationName: cfg.name,
        source: source,
        waitSeconds: waitSecs
      });
    }
    return;
  }

  const hasWind = payload.wind_speed !== undefined;
  const updatedAt = new Date(timestamp * 1000).toISOString();

  // Parse values (Windy expects m/s for wind)
  const windSpeed = parseFloat(payload.wind_speed);
  const windGust = parseFloat(payload.wind_gust);
  const windDir = parseFloat(payload.wind_direction);
  const tempC = parseFloat(payload.temperature);
  let humidity = parseFloat(payload.relative_humidity);
  if (humidity === 0) humidity = NaN;

  // Pressure conversion (Pa → hPa)
  let pressure = parseFloat(payload.barometric_pressure);
  if (!isNaN(pressure)) {
    pressure /= 100;
    if (pressure < 850) pressure = NaN;
  }

  // Validate rain
  const { validRain1h } = validateRain(
    parseFloat(payload.rainfall_1h),
    parseFloat(payload.rainfall_1d),
    cfg
  );

  // Build params
  const params = {
    station: cfg.windy.station,
    time: updatedAt
  };

  if (!isNaN(windDir)) params.winddir = windDir;
  if (!isNaN(windSpeed)) params.wind = windSpeed.toFixed(1);
  if (!isNaN(windGust)) params.gust = windGust.toFixed(1);
  if (!isNaN(tempC) && (!cfg.options.tempOnlyIfWind || hasWind)) params.temp = tempC.toFixed(1);
  if (!isNaN(humidity) && (!cfg.options.humidityOnlyIfWind || hasWind)) params.rh = humidity.toFixed(0);
  if (!isNaN(pressure)) params.pressure = pressure.toFixed(1);
  if (cfg.options.rain && validRain1h !== null) params.precip = validRain1h.toFixed(1);

  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

  const url = `https://stations.windy.com/pws/update/${cfg.windy.apiKey}?${query}`;

  try {
    const result = await httpsGet(url);
    if (result.status === 200) {
      lastWindyPost[stationFromId] = now;
      // Only log to console for non-FANET stations
      if (!isFanet) {
        console.log(`[${cfg.name}] Posted to Windy`);
      }
      uploadLogger.addLog({
        service: 'windy',
        status: 'success',
        stationId: stationFromId,
        stationName: cfg.name,
        source: source,
        httpStatus: result.status
      });
    } else {
      console.log(`[${cfg.name}] Windy error: ${result.status} - ${result.data}`);
      uploadLogger.addLog({
        service: 'windy',
        status: 'error',
        stationId: stationFromId,
        stationName: cfg.name,
        source: source,
        httpStatus: result.status,
        error: result.data
      });
    }
  } catch (err) {
    console.error(`[${cfg.name}] Windy request failed:`, err.message);
    uploadLogger.addLog({
      service: 'windy',
      status: 'error',
      stationId: stationFromId,
      stationName: cfg.name,
      source: source,
      error: err.message
    });
  }
}

// Convert FANET data format to weather services format
// FANET uses km/h for wind, but weather services expect m/s
function convertFanetPayload(fanetData) {
  const kmhToMs = 1 / 3.6;
  return {
    wind_speed: fanetData.wSpeed !== undefined ? fanetData.wSpeed * kmhToMs : undefined,
    wind_gust: fanetData.wGust !== undefined ? fanetData.wGust * kmhToMs : undefined,
    wind_direction: fanetData.wDir,
    temperature: fanetData.temp,
    relative_humidity: fanetData.hum,
    barometric_pressure: fanetData.press  // Pa (same as Meshtastic)
  };
}

// Post to all configured weather services
async function postToWeatherServices(stationFromId, payload, timestamp, source = 'MQTT') {
  if (!weatherConfig.stations[stationFromId]) return;

  // Post to both services (WU immediately, Windy respects rate limit)
  await Promise.all([
    postToWeatherUnderground(stationFromId, payload, timestamp, source),
    postToWindy(stationFromId, payload, timestamp, source)
  ]);
}

// MQTT client
const client = mqtt.connect(MQTT_BROKER, {
  username: MQTT_USER,
  password: MQTT_PASSWORD
});

client.on('connect', () => {
  console.log('Connected to MQTT broker');
  client.subscribe('GXAirCom/#');
  client.subscribe('msh/#');
});

client.on('message', (topic, message) => {
  try {
    const messageStr = message.toString();

    // MQTT-FANET name (plain text, not JSON)
    if (topic.includes('GXAirCom') && topic.endsWith('/name')) {
      const deviceId = topic.split('/')[1];
      const stationId = `fanet-direct-${deviceId}`;
      if (stationsData[stationId]) {
        stationsData[stationId].longname = messageStr;
        saveData();
      }
      return;
    }

    const data = JSON.parse(messageStr);

    // FANET RX
    if (topic.includes('GXAirCom') && topic.includes('/RxWd')) {
      const stationId = `fanet-rx-${data.ID}`;
      storeReading(stationId, 'FANET-RX', {
        windDir: data.wDir,
        windSpeed: data.wSpeed,
        windGust: data.wGust,
        temp: data.temp,
        humidity: data.hum,
        pressure: data.press,
        batteryPercent: data.soc,
        rssi: data.rssi,
        lat: data.lat,
        lon: data.lon
      });

      // Post to weather services (WU and Windy) using the prefixed station ID
      const fanetPayload = convertFanetPayload(data);
      const timestamp = Math.floor(Date.now() / 1000);
      postToWeatherServices(stationId, fanetPayload, timestamp);
    }
    // MQTT-FANET wind data
    else if (topic.includes('GXAirCom') && topic.endsWith('/WD')) {
      const deviceId = topic.split('/')[1];
      const stationId = `fanet-direct-${deviceId}`;
      storeReading(stationId, 'MQTT-FANET', {
        windDir: data.wDir,
        windSpeed: data.wSpeed,
        windGust: data.wGust,
        temp: data.temp
      });

      // Post to weather services (WU and Windy) using the prefixed station ID
      const fanetPayload = convertFanetPayload(data);
      const timestamp = Math.floor(Date.now() / 1000);
      postToWeatherServices(stationId, fanetPayload, timestamp);
    }
    // MQTT-FANET GPS
    else if (topic.includes('GXAirCom') && topic.endsWith('/gps')) {
      const deviceId = topic.split('/')[1];
      const stationId = `fanet-direct-${deviceId}`;
      if (stationsData[stationId]) {
        if (stationsData[stationId].lastReading) {
          stationsData[stationId].lastReading.lat = data.lat;
          stationsData[stationId].lastReading.lon = data.lon;
          stationsData[stationId].lastReading.alt = data.alt;
        }
        saveData();
      }
    }
    // Meshtastic wind telemetry - this identifies a station as a "wind station"
    // Note: Meshtastic reports wind in m/s, convert to km/h (* 3.6)
    else if (topic.includes('msh/') && data.type === 'telemetry' && data.payload?.wind_speed !== undefined) {
      const stationId = `meshtastic-${data.from}`;
      const msToKmh = 3.6;
      storeReading(stationId, 'Meshtastic', {
        windDir: data.payload.wind_direction,
        windSpeed: data.payload.wind_speed * msToKmh,
        windGust: data.payload.wind_gust !== undefined ? data.payload.wind_gust * msToKmh : undefined,
        windLull: data.payload.wind_lull !== undefined ? data.payload.wind_lull * msToKmh : undefined,
        temp: data.payload.temperature,
        rainfall1h: data.payload.rainfall_1h,
        sensorVoltage: data.payload.voltage,
        rssi: data.rssi
      });

      // Post to weather services (WU and Windy)
      postToWeatherServices(String(data.from), data.payload, data.timestamp);
    }
    // Meshtastic device telemetry (station battery/voltage)
    else if (topic.includes('msh/') && data.type === 'telemetry' && data.payload?.battery_level !== undefined) {
      const stationId = `meshtastic-${data.from}`;
      if (stationsData[stationId]) {
        // Update last reading with station power info
        if (stationsData[stationId].lastReading) {
          stationsData[stationId].lastReading.stationVoltage = data.payload.voltage;
          stationsData[stationId].lastReading.batteryPercent = data.payload.battery_level;
        }
        saveData();
      }
    }
    // Meshtastic position - only update if station already identified as wind station
    else if (topic.includes('msh/') && data.type === 'position') {
      const stationId = `meshtastic-${data.from}`;
      if (stationsData[stationId]) {
        const lat = data.payload.latitude_i ? data.payload.latitude_i / 10000000 : data.payload.latitude;
        const lon = data.payload.longitude_i ? data.payload.longitude_i / 10000000 : data.payload.longitude;

        // Update location without creating a new reading
        if (stationsData[stationId].lastReading) {
          stationsData[stationId].lastReading.lat = lat;
          stationsData[stationId].lastReading.lon = lon;
          stationsData[stationId].lastReading.alt = data.payload.altitude;
        }
        saveData();
      }
    }
    // Meshtastic nodeinfo
    else if (topic.includes('msh/') && data.type === 'nodeinfo') {
      const stationId = `meshtastic-${data.from}`;
      if (stationsData[stationId]) {
        stationsData[stationId].longname = data.payload.longname;
        stationsData[stationId].shortname = data.payload.shortname;
        saveData();
      }
    }
  } catch (e) {
    console.error('Error processing message:', e.message);
  }
});

// Clean old data every hour
setInterval(cleanOldData, 60 * 60 * 1000);

// Watch for config file changes (hot-reload)
const configWatcher = chokidar.watch(weatherConfigFile, {
  persistent: true,
  ignoreInitial: true
});

configWatcher.on('change', () => {
  console.log('Weather services config file changed, reloading...');
  try {
    const newConfig = JSON.parse(fs.readFileSync(weatherConfigFile, 'utf8'));
    weatherConfig = newConfig;
    console.log(`Reloaded config with ${Object.keys(weatherConfig.stations).length} stations`);
  } catch (err) {
    console.error('Error reloading config:', err.message);
  }
});

// =====================
// Meshtastic Fallback API (Liam Cottle)
// =====================
const FALLBACK_API_BASE = 'https://meshtastic.liamcottle.net/api/v1/nodes';
const FALLBACK_STALE_MINUTES = 5;
const FALLBACK_CHECK_INTERVAL = 60 * 1000; // Check every minute
const lastFallbackFetch = {}; // Track last API fetch per station

// Fetch weather data from Liam Cottle API
async function fetchFromFallbackApi(nodeId) {
  const url = `${FALLBACK_API_BASE}/${nodeId}/environment-metrics?count=1`;

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`API returned ${res.statusCode}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Check for stale Meshtastic stations and fetch from fallback API
async function checkStaleMeshtasticStations() {
  const now = Date.now();
  const staleThreshold = now - (FALLBACK_STALE_MINUTES * 60 * 1000);

  // Get configured Meshtastic stations (numeric IDs)
  const meshtasticStations = Object.keys(weatherConfig.stations)
    .filter(id => /^\d+$/.test(id));

  for (const nodeId of meshtasticStations) {
    const stationId = `meshtastic-${nodeId}`;
    const station = stationsData[stationId];
    const cfg = weatherConfig.stations[nodeId];

    // Check if station is stale (not seen recently via MQTT)
    const lastSeen = station?.lastSeen ? new Date(station.lastSeen).getTime() : 0;
    if (lastSeen > staleThreshold) {
      continue; // Station is fresh, skip
    }

    // Rate limit API calls - don't fetch more than once per minute per station
    const lastFetch = lastFallbackFetch[nodeId] || 0;
    if (now - lastFetch < 60 * 1000) {
      continue;
    }

    try {
      lastFallbackFetch[nodeId] = now;
      const response = await fetchFromFallbackApi(nodeId);

      if (!response.environment_metrics || response.environment_metrics.length === 0) {
        continue;
      }

      const metric = response.environment_metrics[0];
      const metricTime = new Date(metric.created_at).getTime();

      // Only use if API data is newer than what we have
      if (metricTime <= lastSeen) {
        continue;
      }

      // Check if this is wind data
      if (metric.wind_speed === null && metric.wind_direction === null) {
        continue;
      }

      console.log(`[${cfg.name}] Fetched from fallback API (stale for ${Math.round((now - lastSeen) / 60000)}min)`);

      // API returns wind in m/s, convert to km/h for storage (same as MQTT handler)
      const msToKmh = 3.6;
      const windSpeed = metric.wind_speed !== null ? parseFloat(metric.wind_speed) : undefined;
      const windGust = metric.wind_gust !== null ? parseFloat(metric.wind_gust) : undefined;
      const windLull = metric.wind_lull !== null ? parseFloat(metric.wind_lull) : undefined;

      storeReading(stationId, 'Meshtastic', {
        windDir: metric.wind_direction,
        windSpeed: windSpeed !== undefined ? windSpeed * msToKmh : undefined,
        windGust: windGust !== undefined ? windGust * msToKmh : undefined,
        windLull: windLull !== undefined ? windLull * msToKmh : undefined,
        temp: metric.temperature !== null ? parseFloat(metric.temperature) : undefined,
        sensorVoltage: metric.voltage !== null ? parseFloat(metric.voltage) : undefined
      });

      // Build payload for weather services (expects m/s)
      const payload = {
        wind_speed: windSpeed,
        wind_gust: windGust,
        wind_direction: metric.wind_direction,
        temperature: metric.temperature !== null ? parseFloat(metric.temperature) : undefined,
        relative_humidity: metric.relative_humidity !== null ? parseFloat(metric.relative_humidity) : undefined,
        barometric_pressure: metric.barometric_pressure !== null ? parseFloat(metric.barometric_pressure) : undefined
      };

      const timestamp = Math.floor(metricTime / 1000);
      postToWeatherServices(nodeId, payload, timestamp, 'HTTP');

    } catch (err) {
      // Silent failure - don't spam logs for API errors
      if (err.message !== 'API returned 404') {
        console.error(`[${cfg.name}] Fallback API error:`, err.message);
      }
    }
  }
}

// Start fallback API check interval
setInterval(checkStaleMeshtasticStations, FALLBACK_CHECK_INTERVAL);
console.log(`Meshtastic fallback API check enabled (every ${FALLBACK_CHECK_INTERVAL / 1000}s, stale threshold: ${FALLBACK_STALE_MINUTES}min)`);

// Start Admin API server
startServer(3000);

console.log('MQTT logger started');
