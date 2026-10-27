import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../utils/logger.js';
import { Attendance } from '../models/Attendance.js';
import { Person } from '../models/Person.js';

/**
 * Establishes the MongoDB connection.
 *
 * The rest of the app never calls mongoose.connect directly — it goes through
 * here so connection options, logging, and retry policy live in one place.
 */
export async function connectDatabase() {
  mongoose.set('strictQuery', true);

  mongoose.connection.on('connected', () => {
    logger.info('MongoDB connected');
  });
  mongoose.connection.on('error', (err) => {
    logger.error('MongoDB connection error', err.message);
  });
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });

  await mongoose.connect(env.mongoUri);
  await ensureCriticalIndexes();
  return mongoose.connection;
}

/**
 * Whether the unique attendance index has been built AND verified in this
 * process. `{ verified: false }` means duplicate attendance prevention is NOT
 * in force, and attendanceService refuses to write while that is the case.
 */
let attendanceIndexState = { verified: false, error: null };

/** The current attendance duplicate-prevention state (read by attendanceService). */
export function getAttendanceIndexState() {
  return { ...attendanceIndexState };
}

/** Test hook: lets a unit test drive the guarded code path. */
export function setAttendanceIndexStateForTests(state) {
  attendanceIndexState = { verified: false, error: null, ...state };
}

/**
 * Builds the indexes the application's correctness depends on, and records
 * whether the critical one could be verified.
 *
 * Attendance duplicate prevention is the unique compound index
 * `{ personId: 1, date: 1 }`: the atomic upsert in attendanceService is keyed
 * on it, and WITHOUT the index that upsert can race — two concurrent
 * operations that both find nothing can both insert. Mongoose would otherwise
 * create it implicitly via `autoIndex`, asynchronously, and swallow a failure
 * (for example when the collection already contains duplicates, or when a
 * deployment disables autoIndex for startup cost). So it is built explicitly
 * here and verified to exist.
 *
 * TWO DELIBERATE CHOICES, both from review findings:
 *
 * 1. `createIndexes()`, NOT `syncIndexes`. syncIndexes also DROPS any index
 *    that is not declared in the schema, which would silently remove an index
 *    an operator added out of band (a reporting compound index, a TTL index for
 *    image/record retention). createIndexes builds what the schema declares and
 *    leaves everything else alone; the verification below is what actually
 *    guarantees the unique index exists, so nothing is lost by not dropping.
 *
 * 2. A failure here DEGRADES THE ATTENDANCE PATH rather than killing the
 *    process. Throwing from connectDatabase() meant an `attendances` collection
 *    that already contained duplicate {personId, date} pairs — or a Mongo user
 *    without index privileges — stopped the whole backend from booting, taking
 *    Review 1's detection ingest, alerts and camera control down with it, none
 *    of which depend on attendance. Instead: log loudly with the remediation,
 *    mark duplicate prevention unverified, and let attendanceService refuse
 *    attendance writes while it stays that way. Nothing is written without the
 *    guarantee, and everything that does not need the guarantee keeps working.
 *    `npm run dedupe:attendance` reports and removes the duplicates.
 */
export async function ensureCriticalIndexes() {
  attendanceIndexState = { verified: false, error: null };

  const fail = (message) => {
    attendanceIndexState = { verified: false, error: message };
    logger.error(
      `Attendance duplicate-prevention index NOT verified: ${message} ` +
        'Attendance writes are DISABLED until this is fixed (nothing is written without ' +
        'the unique index that prevents duplicates). Camera monitoring, detection, alerts ' +
        'and people management are unaffected. If `attendances` already contains duplicate ' +
        '{ personId, date } pairs, run `npm run dedupe:attendance` and restart.'
    );
    return attendanceIndexState;
  };

  try {
    // Builds the schema-declared indexes. Does NOT drop anything it did not
    // declare (see choice 1 above).
    await Attendance.createIndexes();
    await Person.createIndexes();
  } catch (err) {
    return fail(`the indexes could not be built (${err.message}).`);
  }

  // Verify rather than assume: a present-but-non-unique index would silently
  // leave the upsert as the only protection.
  let indexes;
  try {
    indexes = await Attendance.collection.indexes();
  } catch (err) {
    return fail(`the indexes on \`attendances\` could not be read (${err.message}).`);
  }

  const unique = indexes.find(
    (index) =>
      index.unique === true &&
      index.key &&
      Object.keys(index.key).length === 2 &&
      index.key.personId === 1 &&
      index.key.date === 1
  );
  if (!unique) {
    return fail('no unique { personId: 1, date: 1 } index exists on `attendances`.');
  }

  attendanceIndexState = { verified: true, error: null };
  logger.info('Attendance duplicate-prevention index verified (unique personId + date)');
  return attendanceIndexState;
}

export async function disconnectDatabase() {
  await mongoose.connection.close();
}
