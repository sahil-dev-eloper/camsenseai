import { Attendance } from '../models/Attendance.js';
import { Camera } from '../models/Camera.js';
import { env } from '../config/env.js';
import { getAttendanceIndexState } from '../config/db.js';
import { logger } from '../utils/logger.js';
import {
  attendanceDateKey,
  attendanceDuplicatePreventionReady,
  attendanceWriteDue,
  interpretUpsertResult,
  validateIdentityClaim,
} from './identityRules.js';

/**
 * Attendance creation — the only place an Attendance document is ever written.
 *
 * Reachable ONLY from recognitionService, which in turn is reachable only from
 * the shared-secret service-to-service endpoint POST /api/ai/recognition. There
 * is deliberately no client-facing attendance-creation route: an authenticated
 * browser client must never be able to submit a person ID and mark attendance.
 *
 * DUPLICATE PREVENTION IS ENFORCED BY THE DATABASE, NOT BY ANY FRONTEND CHECK
 * AND NOT BY A READ-THEN-WRITE IN THIS FILE. The unique compound index
 * { personId: 1, date: 1 } on the Attendance collection is the mechanism. This
 * service performs a single atomic findOneAndUpdate upsert against that exact
 * key, so two concurrent recognition reports cannot both insert; and it still
 * handles the E11000 duplicate-key error that a genuinely simultaneous insert
 * can raise, by re-reading the winning record and reporting created:false.
 *
 * Because that index IS the mechanism, this service refuses to write at all
 * while startup could not build and verify it (see config/db.js). That failure
 * degrades attendance only: Review 1 detection, alerts, cameras and people
 * management are untouched.
 */

export { attendanceDateKey };

/**
 * lastSeen write throttle: `${personId}:${date}` -> epoch ms of the last
 * SUCCESSFUL write. Purely an efficiency guard so a recognised person standing
 * in front of a camera does not cause a database write every recognition pass.
 * It is NOT the duplicate-prevention mechanism (the unique index is), and an
 * empty map after a restart simply means the next sighting performs one upsert
 * that finds the existing record.
 *
 * The timestamp is recorded AFTER the write succeeds. Recording it before
 * would mean a failed write (a dropped connection, say) blocked every retry
 * for the length of the cooldown, so a person's first sighting of the day
 * could be lost. The map is pruned by date, so it cannot grow without bound as
 * days pass.
 */
const lastWriteAt = new Map();
const THROTTLE_MAX_KEYS = 2000;

/** Drops throttle entries for other days, and caps the map's size. */
function pruneThrottle(today) {
  for (const key of lastWriteAt.keys()) {
    // Keys are `${personId}:${YYYY-MM-DD}`; the date is the last segment.
    if (!key.endsWith(`:${today}`)) lastWriteAt.delete(key);
  }
  if (lastWriteAt.size <= THROTTLE_MAX_KEYS) return;
  // Still too big (a very large enrolled population): drop the oldest entries.
  const oldestFirst = [...lastWriteAt.entries()].sort((a, b) => a[1] - b[1]);
  for (const [key] of oldestFirst.slice(0, lastWriteAt.size - THROTTLE_MAX_KEYS)) {
    lastWriteAt.delete(key);
  }
}

/**
 * Marks attendance for a RE-VERIFIED identity.
 *
 * Validation sequence, in order, before anything is persisted:
 *   0. database-enforced duplicate prevention is verified to be in force
 *   1. the person exists
 *   2. the person is active
 *   3. recognition is enabled for the person
 *   4. a stored embedding exists with a consistent dimension, matching the
 *      dimension the configured model produces (env.recognition.embeddingDim)
 *      and — when both names are known — the same embedding model the reporter
 *      used
 *   5. a numeric similarity was supplied and MEETS env.recognition.matchThreshold
 *      — an identity assertion that does not clear the backend's own threshold
 *      never creates attendance, regardless of what the AI service reported
 *   6. the cameraId resolves to a real Camera document (a valid
 *      camera/session context)
 *
 * @returns {Promise<{ created: boolean, record: object|null,
 *                     rejected?: string, throttled?: boolean,
 *                     duplicate?: boolean }>}
 */
export async function markAttendance({
  person,
  cameraId,
  similarity,
  recognitionEventId,
  source = 'recognition',
  now = new Date(),
  expectedModel,
}) {
  // Step 0: the database guarantee must actually be in place. The unique
  // { personId, date } index IS the duplicate-prevention mechanism; if startup
  // could not build or verify it, writing anyway would mean attendance records
  // with no protection against duplicates. Refuse instead — and note that this
  // disables ONLY attendance: detection, alerts, cameras and people management
  // all keep working.
  const indexState = getAttendanceIndexState();
  if (!attendanceDuplicatePreventionReady(getAttendanceIndexState())) {
    return {
      created: false,
      record: null,
      rejected: 'duplicate_prevention_unverified',
      detail:
        indexState.error ||
        'The unique { personId, date } index on `attendances` has not been verified.',
    };
  }

  // Steps 1-5: re-verify the identity claim against our own records/threshold.
  const claim = validateIdentityClaim({
    person,
    similarity,
    threshold: env.recognition.matchThreshold,
    expectedDim: env.recognition.embeddingDim,
    expectedModel,
  });
  if (!claim.ok) {
    return { created: false, record: null, rejected: claim.reason };
  }

  // Step 6: the result must belong to a camera this system actually knows.
  const camera = await Camera.findOne({ cameraId }).select('cameraId');
  if (!camera) {
    return { created: false, record: null, rejected: 'unknown_camera' };
  }

  const date = attendanceDateKey(now);
  const throttleKey = `${person.personId}:${date}`;
  if (!attendanceWriteDue(lastWriteAt.get(throttleKey), now.getTime(), env.recognition.attendanceCooldownSec)) {
    return { created: false, record: null, throttled: true };
  }

  // Step 7: persist atomically. One round trip, keyed on the unique index.
  // $setOnInsert fields are written only when this call is the one that
  // inserts; $set keeps lastSeen current for repeat sightings.
  const update = {
    $setOnInsert: {
      cameraId,
      sessionKey: date,
      firstSeen: now,
      status: 'present',
      source,
      similarity,
      ...(recognitionEventId ? { recognitionEventId } : {}),
    },
    $set: { lastSeen: now },
  };

  try {
    // `includeResultMetadata: true` returns the raw driver ModifyResult;
    // interpretUpsertResult() reads `created` out of it (and falls back to
    // comparing firstSeen with lastSeen if no metadata came back).
    const result = await Attendance.findOneAndUpdate({ personId: person.personId, date }, update, {
      upsert: true,
      new: true,
      includeResultMetadata: true,
    });

    const { created, record } = interpretUpsertResult(result);

    // Recorded only now, AFTER a successful write, so a failed write does not
    // block retries for the length of the cooldown.
    lastWriteAt.set(throttleKey, now.getTime());
    pruneThrottle(date);

    return { created, record };
  } catch (err) {
    if (err?.code === 11000) {
      // A concurrent insert won the race. The unique index did its job: re-read
      // the surviving record and report that we did not create it.
      const record = await Attendance.findOne({ personId: person.personId, date });
      logger.debug(
        `Concurrent attendance insert for ${person.personId} on ${date} — existing record kept`
      );
      // The record exists either way, so the throttle applies from here.
      lastWriteAt.set(throttleKey, now.getTime());
      pruneThrottle(date);
      return { created: false, record, duplicate: true };
    }
    throw err;
  }
}

/** Test/maintenance hook: clears the in-memory lastSeen write throttle. */
export function resetAttendanceThrottle() {
  lastWriteAt.clear();
}
