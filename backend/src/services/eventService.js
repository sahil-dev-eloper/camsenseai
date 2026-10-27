import { Detection } from '../models/Detection.js';
import { Alert } from '../models/Alert.js';
import { Camera } from '../models/Camera.js';
import { env } from '../config/env.js';
import { saveSnapshot } from '../utils/snapshot.js';
import { emit, SocketEvents } from '../sockets/index.js';
import { computeDashboardStats } from './dashboardService.js';
import { logger } from '../utils/logger.js';

/**
 * Turns raw AI detections into stored events + alerts, with throttling.
 *
 * The AI service reports significant detections; this service is the single
 * gate that decides what becomes a persisted Detection and what escalates to an
 * Alert — applying per-(camera,type) cooldowns so a knife visible for 5 seconds
 * produces one event, not 500 (spec §14).
 */

// In-memory cooldown clocks: key `${cameraId}:${kind}` -> last epoch ms.
const lastDetectionAt = new Map();
const lastAlertAt = new Map();

function withinCooldown(map, key, cooldownSec) {
  const now = Date.now();
  const last = map.get(key) || 0;
  if (now - last < cooldownSec * 1000) return true;
  map.set(key, now);
  return false;
}

/** Picks the highest-confidence detection of a given type from a batch. */
function pickBest(detections, type) {
  return detections
    .filter((d) => d.type === type)
    .sort((a, b) => b.confidence - a.confidence)[0];
}

export async function ingestDetections(payload) {
  const { cameraId, detections = [], snapshot, mode = 'demo' } = payload;
  if (!cameraId || detections.length === 0) {
    return { stored: 0, alerts: 0 };
  }

  const camera = await Camera.findOne({ cameraId });
  const cameraName = camera?.name || cameraId;

  let stored = 0;
  let alerts = 0;
  const types = [...new Set(detections.map((d) => d.type))];

  for (const type of types) {
    const best = pickBest(detections, type);
    if (!best) continue;

    // ── Store a representative detection event (throttled) ─────
    if (!withinCooldown(lastDetectionAt, `${cameraId}:${type}`, env.detection.eventCooldownSec)) {
      const detection = await Detection.create({
        cameraId,
        type,
        class: best.label,
        confidence: best.confidence,
        boundingBox: best.bbox,
        source: (best.source === 'demo' || mode === 'demo') ? 'demo' : 'real',
        timestamp: new Date(),
      });
      stored += 1;
      emit(SocketEvents.DETECTION_NEW, {
        id: detection._id.toString(),
        cameraId,
        cameraName,
        type,
        class: best.label,
        confidence: best.confidence,
        source: detection.source,
        timestamp: detection.timestamp,
      });

      // ── Escalate to an alert where warranted (separate cooldown) ──
      const alert = await maybeCreateAlert({ type, best, cameraId, cameraName, snapshot, detectionId: detection._id });
      if (alert) alerts += 1;
    }
  }

  if (stored > 0) {
    // Push fresh KPIs so the dashboard updates live.
    computeDashboardStats()
      .then((stats) => emit(SocketEvents.DASHBOARD_UPDATE, stats))
      .catch((err) => logger.warn(`dashboard emit failed: ${err.message}`));
  }

  return { stored, alerts };
}

async function maybeCreateAlert({ type, best, cameraId, cameraName, snapshot, detectionId }) {
  let severity;
  let message;
  let cooldownSec;

  if (type === 'weapon') {
    severity = 'critical';
    message = `Weapon detected (${best.label}) at ${cameraName}`;
    cooldownSec = env.detection.weaponAlertCooldownSec;
  } else if (type === 'human') {
    severity = 'info';
    message = `Person detected at ${cameraName}`;
    cooldownSec = env.detection.personAlertCooldownSec;
  } else {
    return null;
  }

  if (withinCooldown(lastAlertAt, `${cameraId}:${type}`, cooldownSec)) {
    return null;
  }

  // Only weapons carry a snapshot; store it by reference, not embedded.
  const snapshotUrl = type === 'weapon' ? await saveSnapshot(snapshot, cameraId) : undefined;

  const alert = await Alert.create({
    type: type === 'weapon' ? 'weapon' : 'intrusion',
    severity,
    cameraId,
    detectionId,
    message,
    snapshot: snapshotUrl,
    status: 'new',
    timestamp: new Date(),
  });

  emit(SocketEvents.ALERT_NEW, serializeAlert(alert, cameraName, best.confidence, best.label));
  return alert;
}

/** Client-facing alert shape, enriched with camera name + detection context. */
export function serializeAlert(alert, cameraName, confidence, objectClass) {
  return {
    id: alert._id.toString(),
    type: alert.type,
    severity: alert.severity,
    cameraId: alert.cameraId,
    cameraName,
    objectClass,
    confidence,
    message: alert.message,
    snapshot: alert.snapshot,
    status: alert.status,
    timestamp: alert.timestamp,
  };
}
