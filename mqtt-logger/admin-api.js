const express = require('express');
const fs = require('fs');
const path = require('path');
const uploadLogger = require('./upload-logger');

const app = express();
app.use(express.json());

const CONFIG_FILE = path.join(__dirname, 'weather-services.json');

// Load configuration
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading config:', err.message);
  }
  return { stations: {}, windyRateLimitMinutes: 5 };
}

// Save configuration
function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Load stations data
const STATIONS_FILE = '/data/stations.json';
function loadStations() {
  try {
    if (fs.existsSync(STATIONS_FILE)) {
      return JSON.parse(fs.readFileSync(STATIONS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading stations:', err.message);
  }
  return {};
}

// Determine station type from ID
function getStationType(stationId) {
  if (stationId.startsWith('fanet-rx-')) return 'FANET-RX';
  if (stationId.startsWith('fanet-direct-')) return 'MQTT-FANET';
  if (stationId.startsWith('meshtastic-')) return 'Meshtastic';
  // Legacy: numeric IDs are Meshtastic
  if (/^\d+$/.test(stationId)) return 'Meshtastic';
  return 'Unknown';
}

// GET /api/stations - List known stations from stations.json
app.get('/api/stations', (req, res) => {
  const typeFilter = req.query.type;
  const stationsData = loadStations();
  const config = loadConfig();

  const stations = Object.entries(stationsData).map(([id, station]) => {
    const type = station.type || getStationType(id);
    return {
      id,
      name: station.longname || station.shortname || id,
      type,
      lastSeen: station.lastSeen,
      configured: !!config.stations[id]
    };
  });

  // Filter by type if specified
  const filtered = typeFilter
    ? stations.filter(s => s.type === typeFilter)
    : stations;

  // Sort by lastSeen descending
  filtered.sort((a, b) => {
    if (!a.lastSeen) return 1;
    if (!b.lastSeen) return -1;
    return new Date(b.lastSeen) - new Date(a.lastSeen);
  });

  res.json(filtered);
});

// GET /api/config - Get full configuration
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json(config);
});

// PUT /api/config/stations/:id - Update a station
app.put('/api/config/stations/:id', (req, res) => {
  const stationId = req.params.id;
  const stationData = req.body;

  // Validate required fields
  if (!stationData.name) {
    return res.status(400).json({ error: 'Station name is required' });
  }

  const config = loadConfig();

  // Check if station exists
  if (!config.stations[stationId]) {
    return res.status(404).json({ error: 'Station not found' });
  }

  // Update station
  config.stations[stationId] = {
    name: stationData.name,
    windy: stationData.windy || null,
    wunderground: stationData.wunderground || null,
    options: {
      tempOnlyIfWind: stationData.options?.tempOnlyIfWind ?? true,
      humidityOnlyIfWind: stationData.options?.humidityOnlyIfWind ?? false,
      rain: stationData.options?.rain ?? true,
      maxRain1h: stationData.options?.maxRain1h ?? 100,
      maxRain1d: stationData.options?.maxRain1d ?? 500
    }
  };

  saveConfig(config);
  console.log(`[Admin API] Updated station ${stationId} (${stationData.name})`);
  res.json({ success: true, station: config.stations[stationId] });
});

// POST /api/config/stations - Add a new station
app.post('/api/config/stations', (req, res) => {
  const { id, ...stationData } = req.body;

  // Validate required fields
  if (!id) {
    return res.status(400).json({ error: 'Station ID is required' });
  }
  if (!stationData.name) {
    return res.status(400).json({ error: 'Station name is required' });
  }

  const config = loadConfig();

  // Check if station already exists
  if (config.stations[id]) {
    return res.status(409).json({ error: 'Station already exists' });
  }

  // Add station
  config.stations[id] = {
    name: stationData.name,
    windy: stationData.windy || null,
    wunderground: stationData.wunderground || null,
    options: {
      tempOnlyIfWind: stationData.options?.tempOnlyIfWind ?? true,
      humidityOnlyIfWind: stationData.options?.humidityOnlyIfWind ?? false,
      rain: stationData.options?.rain ?? true,
      maxRain1h: stationData.options?.maxRain1h ?? 100,
      maxRain1d: stationData.options?.maxRain1d ?? 500
    }
  };

  saveConfig(config);
  console.log(`[Admin API] Added station ${id} (${stationData.name})`);
  res.status(201).json({ success: true, station: config.stations[id] });
});

// DELETE /api/config/stations/:id - Delete a station
app.delete('/api/config/stations/:id', (req, res) => {
  const stationId = req.params.id;
  const config = loadConfig();

  if (!config.stations[stationId]) {
    return res.status(404).json({ error: 'Station not found' });
  }

  const deletedName = config.stations[stationId].name;
  delete config.stations[stationId];
  saveConfig(config);

  console.log(`[Admin API] Deleted station ${stationId} (${deletedName})`);
  res.json({ success: true });
});

// PUT /api/config/settings - Update global settings
app.put('/api/config/settings', (req, res) => {
  const { windyRateLimitMinutes } = req.body;
  const config = loadConfig();

  if (windyRateLimitMinutes !== undefined) {
    config.windyRateLimitMinutes = parseInt(windyRateLimitMinutes, 10) || 5;
  }

  saveConfig(config);
  console.log(`[Admin API] Updated global settings`);
  res.json({ success: true, windyRateLimitMinutes: config.windyRateLimitMinutes });
});

// GET /api/logs - Get upload logs with filtering
app.get('/api/logs', (req, res) => {
  const filters = {
    service: req.query.service,
    status: req.query.status,
    station: req.query.station,
    since: req.query.since,
    limit: req.query.limit ? parseInt(req.query.limit, 10) : 100
  };

  const logs = uploadLogger.getLogs(filters);
  res.json(logs);
});

// GET /api/logs/stats - Get log statistics
app.get('/api/logs/stats', (req, res) => {
  const stats = uploadLogger.getStats();
  res.json(stats);
});

// Start server
function startServer(port = 3000) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`Admin API server listening on port ${port}`);
      resolve(server);
    });
  });
}

module.exports = { app, startServer };
