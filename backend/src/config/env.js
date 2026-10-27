import dotenv from 'dotenv';

dotenv.config();

/**
 * Centralized, validated access to environment variables.
 * Every module reads config from here instead of touching process.env directly,
 * so misconfiguration surfaces once, at startup, with a clear message.
 */
const required = ['MONGODB_URI', 'JWT_SECRET'];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  // In development we warn but keep running with safe fallbacks so the
  // foundation can boot on a fresh clone. In production this is fatal.
  const message = `Missing required environment variables: ${missing.join(', ')}`;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(message);
  }
  console.warn(`[config] ${message} — using development fallbacks.`);
}

// Not fatal (a deployment may run the backend alone), but nothing involving
// the AI service works without it, so say so once at startup rather than
// letting every call fail with an authentication error.
if (!process.env.AI_INGEST_SECRET) {
  console.warn(
    '[config] AI_INGEST_SECRET is not set. Every call to and from the AI service will be ' +
      "refused until it is set to the same value as the AI service's AI_SERVICE_INGEST_SECRET."
  );
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 5000,
  // Loopback by DEFAULT. This process serves JWT-authenticated operator APIs,
  // snapshot images and registration portraits, so it must not listen on every
  // interface out of the box. Set HOST explicitly (e.g. 0.0.0.0 inside a
  // container whose ports are published to 127.0.0.1) when a deployment really
  // needs a wider bind.
  host: process.env.HOST || '127.0.0.1',
  clientOrigins: (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/camsense',
  jwtSecret: process.env.JWT_SECRET || 'dev_insecure_secret_change_me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  // Lifetime of the NARROWED token used in /uploads image URLs. An <img> tag
  // cannot send an Authorization header, so that credential ends up in browser
  // history and any fronting proxy's log; it is therefore scoped to the asset
  // mount and expires well before the session does. Shorten it freely — the
  // only cost of expiry is that open tabs must be reloaded for images.
  assetTokenExpiresIn: process.env.ASSET_TOKEN_EXPIRES_IN || '1d',
  aiServiceUrl: process.env.AI_SERVICE_URL || 'http://127.0.0.1:8000',
  seedAdmin: {
    name: process.env.SEED_ADMIN_NAME || 'Administrator',
    email: process.env.SEED_ADMIN_EMAIL || 'admin@camsense.ai',
    password: process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!',
  },

  // Shared secret for service-to-service AI → backend event ingestion, and for
  // the backend's own calls to the AI service. NO DEFAULT, deliberately: a
  // default value could not match the AI service's, so a half-configured
  // deployment would 401 every call instead of saying what is missing. Unset
  // means both sides fail closed with a message naming the variable to set
  // (requireInternalSecret rejects every service request; the AI service
  // returns 503). It MUST equal the AI service's AI_SERVICE_INGEST_SECRET.
  aiIngestSecret: process.env.AI_INGEST_SECRET || '',

  // Where detection snapshots are written and served from.
  snapshotDir: process.env.SNAPSHOT_DIR || 'uploads/snapshots',

  // Detection/alert throttling (seconds). Prevents flooding the DB with the
  // same object across consecutive frames. See eventService.
  detection: {
    // A stored detection event of the same (camera, type) inside this window
    // is treated as the same ongoing event.
    eventCooldownSec: Number(process.env.DETECTION_EVENT_COOLDOWN) || 5,
    weaponAlertCooldownSec: Number(process.env.WEAPON_ALERT_COOLDOWN) || 10,
    personAlertCooldownSec: Number(process.env.PERSON_ALERT_COOLDOWN) || 60,
  },

  // Face recognition / attendance (Review 2). The backend re-checks the match
  // threshold itself rather than trusting the AI service's verdict, so this
  // value is the authority for whether an identity claim is accepted.
  recognition: {
    // Cosine-similarity threshold an identity claim must clear. Default 0.363
    // is OpenCV's published STARTING POINT for the SFace model — it requires
    // validation on real enrolled data and is deliberately adjustable. It is
    // not a calibrated probability and implies no accuracy guarantee.
    matchThreshold: Number(process.env.RECOGNITION_MATCH_THRESHOLD) || 0.30,
    // Temporal verification before an unknown-identity event is raised: the
    // same camera+track must be seen this many times inside this window.
    unknownPersistenceCount: Number(process.env.UNKNOWN_PERSISTENCE_COUNT) || 2,
    unknownPersistenceWindowSec: Number(process.env.UNKNOWN_PERSISTENCE_WINDOW) || 10,
    // Per-camera/track cooldown so one continuously visible unmatched face
    // produces one alert, not one per frame.
    unknownAlertCooldownSec: Number(process.env.UNKNOWN_ALERT_COOLDOWN) || 60,
    // Per-camera/person cooldown for STORED 'known' recognition events and
    // their socket emits. Without it, one recognised person standing in view
    // writes one event per recognition report (≈1/s/camera) indefinitely.
    // Mirrors detection.eventCooldownSec, which does the same job for Review
    // 1 detection events.
    knownEventCooldownSec: Number(process.env.KNOWN_EVENT_COOLDOWN) || 30,
    // Minimum gap between lastSeen writes for an already-marked person.
    attendanceCooldownSec: Number(process.env.ATTENDANCE_UPDATE_COOLDOWN) || 30,
    // Embedding dimension the configured recognition model produces (SFace is
    // 128-d). Passed to the trust boundary so a stored vector from a different
    // embedding space is rejected rather than scored.
    embeddingDim: Number(process.env.RECOGNITION_EMBEDDING_DIM) || 128,
    // Registration photograph limits (decoded byte length).
    faceUploadMaxBytes: Number(process.env.FACE_UPLOAD_MAX_BYTES) || 5000000,
    allowedImageMimes: ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'],
    // Seconds the "is anybody enrolled?" count is cached for. A system with
    // nobody enrolled must not raise unknown-identity alerts on every face,
    // and that check must not cost a query per reported face.
    enrolledCountTtlSec: Number(process.env.ENROLLED_COUNT_TTL) || 30,
  },
};

export const isProduction = env.nodeEnv === 'production';
