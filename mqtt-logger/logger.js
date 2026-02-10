const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const https = require('https');
const chokidar = require('chokidar');
const uploadLogger = require('./upload-logger');
const receptionLogger = require('./reception-logger');
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
  
  // Remove stale unconfigured stations entirely
  for (const stationId in stationsData) {
    const lastSeen = new Date(stationsData[stationId].lastSeen).getTime();
    if (lastSeen < cutoff && !getStationConfig(stationId)) {
      delete stationsData[stationId];
      console.log(`Removed stale unconfigured station: ${stationId}`);
    }
  }

  saveData();
  console.log('Cleaned old data');
}

// Save data to file
function saveData() {
  fs.writeFileSync(dataFile, JSON.stringify(stationsData, null, 2));
}

// Get station config by ID (checks multiple ID formats)
function getStationConfig(stationId) {
  // Direct match
  if (weatherConfig.stations[stationId]) {
    return weatherConfig.stations[stationId];
  }
  // Try numeric ID for meshtastic stations
  const numericId = stationId.replace(/^meshtastic-/, '');
  if (weatherConfig.stations[numericId]) {
    return weatherConfig.stations[numericId];
  }
  return null;
}

// Store reading
function storeReading(stationId, type, data) {
  // Get station config to check for options like excludeWind
  const cfg = getStationConfig(stationId);
  const excludeWind = cfg?.options?.excludeWind ?? false;

  if (!stationsData[stationId]) {
    stationsData[stationId] = {
      id: stationId,
      type: type,
      history: [],
      excludeWind: excludeWind
    };
  } else {
    // Update type in case it changed (e.g., FANET-Direct -> MQTT-FANET)
    stationsData[stationId].type = type;
    // Update excludeWind in case config changed
    stationsData[stationId].excludeWind = excludeWind;
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

// Default validation bounds for weather data
const DEFAULT_VALIDATION_BOUNDS = {
  temperature: { min: -50, max: 60 },       // Celsius
  windSpeed: { min: 0, max: 200 },          // km/h (storage format)
  windGust: { min: 0, max: 300 },           // km/h
  windDirection: { min: 0, max: 360 },      // Degrees
  humidity: { min: 0, max: 100 },           // Percent
  pressure: { min: 85000, max: 110000 }     // Pa
};

// Validate weather data and return validation result
function validateWeatherData(data, cfg = {}, stationName = 'Unknown') {
  const bounds = { ...DEFAULT_VALIDATION_BOUNDS };

  const result = {
    status: 'valid',
    reasons: [],
    cleanedData: { ...data }
  };

  // Validate temperature
  if (data.temp !== undefined && data.temp !== null) {
    if (data.temp < bounds.temperature.min || data.temp > bounds.temperature.max) {
      result.reasons.push(`temperature_out_of_range:${data.temp}`);
      console.log(`[${stationName}] Rejected temperature: ${data.temp}C (valid: ${bounds.temperature.min} to ${bounds.temperature.max})`);
      result.cleanedData.temp = undefined;
    }
  }

  // Validate wind speed (stored in km/h)
  if (data.windSpeed !== undefined && data.windSpeed !== null) {
    if (data.windSpeed < bounds.windSpeed.min || data.windSpeed > bounds.windSpeed.max) {
      result.reasons.push(`wind_speed_out_of_range:${data.windSpeed}`);
      console.log(`[${stationName}] Rejected wind speed: ${data.windSpeed}km/h (valid: ${bounds.windSpeed.min} to ${bounds.windSpeed.max})`);
      result.cleanedData.windSpeed = undefined;
    }
  }

  // Validate wind gust
  if (data.windGust !== undefined && data.windGust !== null) {
    if (data.windGust < bounds.windGust.min || data.windGust > bounds.windGust.max) {
      result.reasons.push(`wind_gust_out_of_range:${data.windGust}`);
      console.log(`[${stationName}] Rejected wind gust: ${data.windGust}km/h (valid: ${bounds.windGust.min} to ${bounds.windGust.max})`);
      result.cleanedData.windGust = undefined;
    }
  }

  // Validate wind direction
  if (data.windDir !== undefined && data.windDir !== null) {
    if (data.windDir < bounds.windDirection.min || data.windDir > bounds.windDirection.max) {
      result.reasons.push(`wind_direction_out_of_range:${data.windDir}`);
      console.log(`[${stationName}] Rejected wind direction: ${data.windDir} (valid: ${bounds.windDirection.min} to ${bounds.windDirection.max})`);
      result.cleanedData.windDir = undefined;
    }
  }

  // Validate humidity
  if (data.humidity !== undefined && data.humidity !== null) {
    if (data.humidity < bounds.humidity.min || data.humidity > bounds.humidity.max) {
      result.reasons.push(`humidity_out_of_range:${data.humidity}`);
      console.log(`[${stationName}] Rejected humidity: ${data.humidity}% (valid: ${bounds.humidity.min} to ${bounds.humidity.max})`);
      result.cleanedData.humidity = undefined;
    }
  }

  // Validate pressure (stored in Pa)
  if (data.pressure !== undefined && data.pressure !== null) {
    if (data.pressure < bounds.pressure.min || data.pressure > bounds.pressure.max) {
      result.reasons.push(`pressure_out_of_range:${data.pressure}`);
      console.log(`[${stationName}] Rejected pressure: ${data.pressure}Pa (valid: ${bounds.pressure.min} to ${bounds.pressure.max})`);
      result.cleanedData.pressure = undefined;
    }
  }

  // Cross-field validation: gust should be >= speed (warning only)
  if (result.cleanedData.windSpeed !== undefined &&
      result.cleanedData.windGust !== undefined &&
      result.cleanedData.windGust < result.cleanedData.windSpeed) {
    console.log(`[${stationName}] Warning: wind gust (${data.windGust}) < wind speed (${data.windSpeed})`);
  }

  // Determine overall status
  if (result.reasons.length > 0) {
    const rejectedFields = result.reasons.filter(r => r.includes('out_of_range')).length;
    const weatherFields = ['temp', 'windSpeed', 'windGust', 'windDir', 'humidity', 'pressure'];
    const presentFields = weatherFields.filter(f => data[f] !== undefined && data[f] !== null).length;

    if (rejectedFields === presentFields && presentFields > 0) {
      result.status = 'rejected';
    } else if (rejectedFields > 0) {
      result.status = 'partial';
    }
  }

  return result;
}

// Post to Weather Underground
async function postToWeatherUnderground(stationFromId, payload, timestamp, source = 'MQTT', logStationId = null) {
  const cfg = weatherConfig.stations[stationFromId];
  if (!cfg || !cfg.wunderground) return;

  // Use logStationId for reception logger (may differ from config ID for Meshtastic)
  const receptionId = logStationId || stationFromId;

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

  // Check if wind data should be excluded
  const excludeWind = cfg.options?.excludeWind ?? false;
  const hasWind = !excludeWind && payload.wind_speed !== undefined;
  const wuDateUtc = new Date(timestamp * 1000).toISOString().slice(0, 19).replace('T', ' ');

  // Parse values
  const windSpeed = excludeWind ? NaN : parseFloat(payload.wind_speed);
  const windGust = excludeWind ? NaN : parseFloat(payload.wind_gust);
  const windDir = excludeWind ? NaN : parseFloat(payload.wind_direction);
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
      receptionLogger.updatePostStatus(receptionId, 'wu', 'success');
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
      receptionLogger.updatePostStatus(receptionId, 'wu', 'error');
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
    receptionLogger.updatePostStatus(receptionId, 'wu', 'error');
  }
}

// Post to Windy (V2 API)
async function postToWindy(stationFromId, payload, timestamp, source = 'MQTT', logStationId = null) {
  const cfg = weatherConfig.stations[stationFromId];
  if (!cfg || !cfg.windy) return;

  // Use logStationId for reception logger (may differ from config ID for Meshtastic)
  const receptionId = logStationId || stationFromId;

  // V2 API requires stationId and stationPassword
  if (!cfg.windy.stationId || !cfg.windy.stationPassword) {
    console.log(`[${cfg.name}] Windy V2 not configured (missing stationId or stationPassword)`);
    return;
  }

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

  // Check if wind data should be excluded
  const excludeWind = cfg.options?.excludeWind ?? false;
  const hasWind = !excludeWind && payload.wind_speed !== undefined;

  // Parse values (Windy V2 expects m/s for wind)
  const windSpeed = excludeWind ? NaN : parseFloat(payload.wind_speed);
  const windGust = excludeWind ? NaN : parseFloat(payload.wind_gust);
  const windDir = excludeWind ? NaN : parseFloat(payload.wind_direction);
  const tempC = parseFloat(payload.temperature);
  let humidity = parseFloat(payload.relative_humidity);
  if (humidity === 0) humidity = NaN;

  // Pressure - V2 API expects Pa (not hPa), so don't divide by 100
  let pressure = parseFloat(payload.barometric_pressure);
  if (!isNaN(pressure)) {
    // Sanity check: pressure should be around 85000-110000 Pa
    if (pressure < 85000) pressure = NaN;
  }

  // Validate rain
  const { validRain1h } = validateRain(
    parseFloat(payload.rainfall_1h),
    parseFloat(payload.rainfall_1d),
    cfg
  );

  // Build params for V2 API
  const params = {
    id: cfg.windy.stationId,
    PASSWORD: cfg.windy.stationPassword,
    ts: Math.floor(timestamp),  // Unix timestamp in seconds
    stationtype: cfg.windy.stationType || 'WS85',
    softwaretype: isFanet ? 'FANET' : 'Meshtastic'
  };

  if (!isNaN(windDir)) params.winddir = Math.round(windDir);
  if (!isNaN(windSpeed)) params.wind = windSpeed.toFixed(1);
  if (!isNaN(windGust)) params.gust = windGust.toFixed(1);
  if (!isNaN(tempC) && (!cfg.options.tempOnlyIfWind || hasWind)) params.temp = tempC.toFixed(1);
  if (!isNaN(humidity) && (!cfg.options.humidityOnlyIfWind || hasWind)) params.humidity = Math.round(humidity);
  if (!isNaN(pressure)) params.pressure = Math.round(pressure);
  if (cfg.options.rain && validRain1h !== null) params.precip = validRain1h.toFixed(1);

  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

  const url = `https://stations.windy.com/api/v2/observation/update?${query}`;

  try {
    const result = await httpsGet(url);
    if (result.status === 200) {
      lastWindyPost[stationFromId] = now;
      // Only log to console for non-FANET stations
      if (!isFanet) {
        console.log(`[${cfg.name}] Posted to Windy V2`);
      }
      uploadLogger.addLog({
        service: 'windy',
        status: 'success',
        stationId: stationFromId,
        stationName: cfg.name,
        source: source,
        httpStatus: result.status
      });
      receptionLogger.updatePostStatus(receptionId, 'windy', 'success');
    } else {
      console.log(`[${cfg.name}] Windy V2 error: ${result.status} - ${result.data}`);
      uploadLogger.addLog({
        service: 'windy',
        status: 'error',
        stationId: stationFromId,
        stationName: cfg.name,
        source: source,
        httpStatus: result.status,
        error: result.data
      });
      receptionLogger.updatePostStatus(receptionId, 'windy', 'error');
    }
  } catch (err) {
    console.error(`[${cfg.name}] Windy V2 request failed:`, err.message);
    uploadLogger.addLog({
      service: 'windy',
      status: 'error',
      stationId: stationFromId,
      stationName: cfg.name,
      source: source,
      error: err.message
    });
    receptionLogger.updatePostStatus(receptionId, 'windy', 'error');
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
// receptionStationId is the ID used for reception logging (may differ from config ID for Meshtastic)
async function postToWeatherServices(stationFromId, payload, timestamp, source = 'MQTT', receptionStationId = null) {
  if (!weatherConfig.stations[stationFromId]) return;

  // Use provided receptionStationId or fall back to stationFromId
  const logStationId = receptionStationId || stationFromId;

  // Post to both services (WU immediately, Windy respects rate limit)
  await Promise.all([
    postToWeatherUnderground(stationFromId, payload, timestamp, source, logStationId),
    postToWindy(stationFromId, payload, timestamp, source, logStationId)
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
      const cfg = getStationConfig(stationId);
      const stationName = cfg?.name || stationId;

      // Validate weather data
      const rawData = {
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
      };

      const validation = validateWeatherData(rawData, cfg, stationName);

      // Log reception
      receptionLogger.logReception(stationId, validation);

      if (validation.status === 'rejected') {
        console.log(`[${stationName}] Data rejected: ${validation.reasons.join(', ')}`);
        return;
      }

      storeReading(stationId, 'FANET-RX', validation.cleanedData);

      // Post to weather services (WU and Windy) using the prefixed station ID
      const fanetPayload = convertFanetPayload(data);
      const timestamp = Math.floor(Date.now() / 1000);
      postToWeatherServices(stationId, fanetPayload, timestamp);
    }
    // MQTT-FANET wind data
    else if (topic.includes('GXAirCom') && topic.endsWith('/WD')) {
      const deviceId = topic.split('/')[1];
      const stationId = `fanet-direct-${deviceId}`;
      const cfg = getStationConfig(stationId);
      const stationName = cfg?.name || stationId;

      // Validate weather data
      const rawData = {
        windDir: data.wDir,
        windSpeed: data.wSpeed,
        windGust: data.wGust,
        temp: data.temp
      };

      const validation = validateWeatherData(rawData, cfg, stationName);

      // Log reception
      receptionLogger.logReception(stationId, validation);

      if (validation.status === 'rejected') {
        console.log(`[${stationName}] Data rejected: ${validation.reasons.join(', ')}`);
        return;
      }

      storeReading(stationId, 'MQTT-FANET', validation.cleanedData);

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
      const cfg = getStationConfig(stationId);
      const stationName = cfg?.name || stationId;
      const msToKmh = 3.6;

      // Validate weather data (convert to km/h for validation since that's our storage format)
      const rawData = {
        windDir: data.payload.wind_direction,
        windSpeed: data.payload.wind_speed * msToKmh,
        windGust: data.payload.wind_gust !== undefined ? data.payload.wind_gust * msToKmh : undefined,
        windLull: data.payload.wind_lull !== undefined ? data.payload.wind_lull * msToKmh : undefined,
        temp: data.payload.temperature,
        rainfall1h: data.payload.rainfall_1h,
        sensorVoltage: data.payload.voltage,
        rssi: data.rssi
      };

      const validation = validateWeatherData(rawData, cfg, stationName);

      // Log reception
      receptionLogger.logReception(stationId, validation);

      if (validation.status === 'rejected') {
        console.log(`[${stationName}] Data rejected: ${validation.reasons.join(', ')}`);
        return;
      }

      storeReading(stationId, 'Meshtastic', validation.cleanedData);

      // Post to weather services (WU and Windy)
      // Use numeric ID for config lookup, but pass stationId for reception logger
      postToWeatherServices(String(data.from), data.payload, data.timestamp, 'MQTT', stationId);
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
setInterval(() => {
  cleanOldData();
  receptionLogger.cleanup();
}, 60 * 60 * 1000);

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

      // Validate weather data
      const rawData = {
        windDir: metric.wind_direction,
        windSpeed: windSpeed !== undefined ? windSpeed * msToKmh : undefined,
        windGust: windGust !== undefined ? windGust * msToKmh : undefined,
        windLull: windLull !== undefined ? windLull * msToKmh : undefined,
        temp: metric.temperature !== null ? parseFloat(metric.temperature) : undefined,
        sensorVoltage: metric.voltage !== null ? parseFloat(metric.voltage) : undefined
      };

      const validation = validateWeatherData(rawData, cfg, cfg.name);

      // Log reception
      receptionLogger.logReception(stationId, validation);

      if (validation.status === 'rejected') {
        console.log(`[${cfg.name}] Fallback API data rejected: ${validation.reasons.join(', ')}`);
        continue;
      }

      storeReading(stationId, 'Meshtastic', validation.cleanedData);

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
      postToWeatherServices(nodeId, payload, timestamp, 'HTTP', stationId);

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
