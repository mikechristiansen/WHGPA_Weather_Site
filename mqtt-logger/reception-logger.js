const fs = require('fs');
const path = require('path');

const DATA_DIR = '/data';
const LOG_FILE = path.join(DATA_DIR, 'reception-logs.json');
const HOURS_TO_KEEP = 24;

// Data structure: { stationId: { slotKey: { received, receivedAt, postStatus, validationStatus, rejectionReasons } } }
let slots = {};

// Track the last slot key used for each station (so updatePostStatus updates the correct slot)
let lastSlotKey = {};

// Load existing logs on startup
function loadLogs() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      slots = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
      console.log(`Loaded reception logs for ${Object.keys(slots).length} stations`);
    }
  } catch (err) {
    console.error('Error loading reception logs:', err.message);
    slots = {};
  }
}

// Save logs to file
function saveLogs() {
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(slots, null, 2));
  } catch (err) {
    console.error('Error saving reception logs:', err.message);
  }
}

// Get slot key for a timestamp (rounded to 5-minute interval)
function getSlotKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const minutes = Math.floor(date.getMinutes() / 5) * 5;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const min = String(minutes).padStart(2, '0');
  return `${year}-${month}-${day}-${hour}-${min}`;
}

// Log data reception
function logReception(stationId, validationResult) {
  const slotKey = getSlotKey();

  if (!slots[stationId]) {
    slots[stationId] = {};
  }

  // Create or update slot
  slots[stationId][slotKey] = {
    received: true,
    receivedAt: Date.now(),
    postStatus: slots[stationId][slotKey]?.postStatus || { wu: null, windy: null },
    validationStatus: validationResult.status,
    rejectionReasons: validationResult.reasons || []
  };

  // Track the slot key so updatePostStatus can update the same slot
  lastSlotKey[stationId] = slotKey;

  saveLogs();
}

// Update post status for a station (called after upload attempt)
function updatePostStatus(stationId, service, status) {
  // Use the last slot key that was logged for this station (handles timing across 5-min boundaries)
  const slotKey = lastSlotKey[stationId] || getSlotKey();

  if (!slots[stationId]) {
    slots[stationId] = {};
  }

  if (!slots[stationId][slotKey]) {
    // Create slot if it doesn't exist (shouldn't happen normally)
    slots[stationId][slotKey] = {
      received: true,
      receivedAt: Date.now(),
      postStatus: { wu: null, windy: null },
      validationStatus: 'valid',
      rejectionReasons: []
    };
  }

  slots[stationId][slotKey].postStatus[service] = status;
  saveLogs();
}

// Get health grid for a specific station (24 hours x 12 slots)
function getHealthGrid(stationId, stationName) {
  const grid = [];
  const now = Date.now();

  // Generate 24 hours of slots (oldest first)
  for (let h = 23; h >= 0; h--) {
    const hourStart = now - (h * 60 * 60 * 1000);
    const hourDate = new Date(hourStart);
    hourDate.setMinutes(0, 0, 0);

    const hourSlots = [];
    for (let m = 0; m < 60; m += 5) {
      const slotTime = new Date(hourDate.getTime() + m * 60 * 1000);
      const slotKey = getSlotKey(slotTime.getTime());
      const slotData = slots[stationId]?.[slotKey];

      let status = 'no_data';
      if (slotData?.received) {
        if (slotData.validationStatus === 'rejected') {
          status = 'rejected';
        } else if (slotData.postStatus?.wu === 'error' || slotData.postStatus?.windy === 'error') {
          status = 'post_error';
        } else if (slotData.postStatus?.wu === 'success' || slotData.postStatus?.windy === 'success') {
          status = 'success';
        } else {
          // Received but no post status yet (rate limited or not configured)
          status = 'received';
        }
      }

      hourSlots.push({
        minute: m,
        status: status,
        received: slotData?.received || false,
        postStatus: slotData?.postStatus || null,
        validationStatus: slotData?.validationStatus || null,
        rejectionReasons: slotData?.rejectionReasons || []
      });
    }

    grid.push({
      hour: hourDate.toISOString(),
      hourLabel: hourDate.getHours(),
      slots: hourSlots
    });
  }

  return {
    stationId,
    stationName: stationName || stationId,
    generated: new Date().toISOString(),
    grid
  };
}

// Get health grids for all configured stations
function getHealthGridAll(stationsConfig) {
  const grids = [];

  // Get all station IDs (from config and from reception data)
  const allStationIds = new Set([
    ...Object.keys(stationsConfig || {}),
    ...Object.keys(slots)
  ]);

  for (const configId of allStationIds) {
    // Map config IDs to actual station IDs
    let stationId = configId;
    let stationName = stationsConfig[configId]?.name || configId;

    // Handle numeric Meshtastic IDs
    if (/^\d+$/.test(configId)) {
      stationId = `meshtastic-${configId}`;
    }

    // Only include stations that have reception data or are configured
    if (slots[stationId] || stationsConfig[configId]) {
      grids.push(getHealthGrid(stationId, stationName));
    }
  }

  // Sort by station name
  grids.sort((a, b) => a.stationName.localeCompare(b.stationName));

  return grids;
}

// Cleanup old slots (older than 24 hours)
function cleanup() {
  const cutoff = Date.now() - (HOURS_TO_KEEP * 60 * 60 * 1000);
  let removed = 0;

  for (const stationId of Object.keys(slots)) {
    for (const slotKey of Object.keys(slots[stationId])) {
      const slotData = slots[stationId][slotKey];
      if (slotData.receivedAt && slotData.receivedAt < cutoff) {
        delete slots[stationId][slotKey];
        removed++;
      }
    }

    // Remove station if no slots left
    if (Object.keys(slots[stationId]).length === 0) {
      delete slots[stationId];
    }
  }

  if (removed > 0) {
    saveLogs();
    console.log(`Cleaned ${removed} old reception log slots`);
  }
}

// Initialize on module load
loadLogs();

module.exports = {
  logReception,
  updatePostStatus,
  getHealthGrid,
  getHealthGridAll,
  cleanup,
  loadLogs
};
