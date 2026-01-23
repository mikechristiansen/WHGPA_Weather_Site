const fs = require('fs');
const path = require('path');

const DATA_DIR = '/data';
const LOG_FILE = path.join(DATA_DIR, 'upload-logs.json');
const MAX_ENTRIES = 1000;

let logs = [];

// Load existing logs on startup
function loadLogs() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
      console.log(`Loaded ${logs.length} upload log entries`);
    }
  } catch (err) {
    console.error('Error loading upload logs:', err.message);
    logs = [];
  }
}

// Save logs to file
function saveLogs() {
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
  } catch (err) {
    console.error('Error saving upload logs:', err.message);
  }
}

// Add a log entry
function addLog(entry) {
  const logEntry = {
    timestamp: Date.now(),
    ...entry
  };

  logs.push(logEntry);

  // Keep only last MAX_ENTRIES
  if (logs.length > MAX_ENTRIES) {
    logs = logs.slice(-MAX_ENTRIES);
  }

  saveLogs();
  return logEntry;
}

// Get logs with optional filters
function getLogs(filters = {}) {
  let result = [...logs];

  // Filter by service (wu, windy)
  if (filters.service) {
    result = result.filter(log => log.service === filters.service);
  }

  // Filter by status (success, error, rate_limited)
  if (filters.status) {
    result = result.filter(log => log.status === filters.status);
  }

  // Filter by station
  if (filters.station) {
    result = result.filter(log => log.stationId === filters.station);
  }

  // Filter by time range
  if (filters.since) {
    const sinceTime = typeof filters.since === 'number' ? filters.since : Date.parse(filters.since);
    result = result.filter(log => log.timestamp >= sinceTime);
  }

  // Sort by timestamp descending (newest first)
  result.sort((a, b) => b.timestamp - a.timestamp);

  // Limit results
  if (filters.limit) {
    result = result.slice(0, filters.limit);
  }

  return result;
}

// Get statistics
function getStats() {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const stats = {
    total: logs.length,
    lastHour: {
      wu: { success: 0, error: 0, total: 0 },
      windy: { success: 0, error: 0, rate_limited: 0, total: 0 }
    },
    last24Hours: {
      wu: { success: 0, error: 0, total: 0 },
      windy: { success: 0, error: 0, rate_limited: 0, total: 0 }
    }
  };

  for (const log of logs) {
    const service = log.service;
    const status = log.status;

    if (log.timestamp >= oneDayAgo) {
      if (stats.last24Hours[service]) {
        stats.last24Hours[service][status] = (stats.last24Hours[service][status] || 0) + 1;
        stats.last24Hours[service].total++;
      }

      if (log.timestamp >= oneHourAgo) {
        if (stats.lastHour[service]) {
          stats.lastHour[service][status] = (stats.lastHour[service][status] || 0) + 1;
          stats.lastHour[service].total++;
        }
      }
    }
  }

  return stats;
}

// Initialize on module load
loadLogs();

module.exports = {
  addLog,
  getLogs,
  getStats,
  loadLogs
};
