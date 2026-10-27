/**
 * Shared application types. Mirrors the backend's data contract so the app is
 * fully typed end to end.
 */

export type UserRole = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt?: string;
  updatedAt?: string;
}

export interface AuthSession {
  user: User;
  token: string;
  /**
   * Narrowed credential for the backend's authenticated `/uploads` image
   * mount. An <img> cannot send an Authorization header, so this one travels
   * in the URL; it is scoped to image reads and expires sooner than `token`,
   * which the backend refuses to accept in that query parameter.
   */
  assetToken?: string;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiErrorBody {
  success: false;
  error: { message: string; details?: unknown };
}

export type ViewStatus = 'idle' | 'loading' | 'success' | 'empty' | 'error';

export interface BackendHealth {
  service: string;
  status: string;
  environment: string;
  uptimeSeconds: number;
  database: { status: string };
  timestamp: string;
}

// ── Review 1 ─────────────────────────────────────────────────

export type CameraMode = 'demo' | 'real' | 'webcam';
export type CameraStatus = 'online' | 'offline' | 'connecting' | 'error';

export interface Camera {
  _id: string;
  cameraId: string;
  name: string;
  location: string;
  streamUrl: string;
  mode: CameraMode;
  status: CameraStatus;
  aiEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CameraInput {
  cameraId: string;
  name: string;
  location?: string;
  streamUrl?: string;
  mode: CameraMode;
  aiEnabled: boolean;
}

export type DetectionType = 'human' | 'weapon' | 'face' | 'other';

export interface Detection {
  _id: string;
  cameraId: string;
  type: DetectionType;
  class: string;
  confidence: number;
  boundingBox?: number[];
  source: 'demo' | 'real';
  timestamp: string;
}

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'new' | 'acknowledged' | 'resolved';

export interface Alert {
  id: string;
  type: string;
  severity: AlertSeverity;
  cameraId: string;
  cameraName?: string;
  objectClass?: string;
  confidence?: number;
  message: string;
  snapshot?: string;
  status: AlertStatus;
  timestamp: string;
}

export interface DetectorStatus {
  key: string;
  label: string;
  /**
   * Review 2 widened this union: the recognition and attendance rows need to be
   * able to report INACTIVE and ERROR in addition to the Review 1 states, and
   * ai-service/app/detection/base.py documents all five.
   */
  status: 'active' | 'unavailable' | 'demo' | 'inactive' | 'error';
}

export interface AiStatus {
  reachable?: boolean;
  mode: CameraMode;
  model_loaded: boolean;
  detectors: DetectorStatus[];
}

export interface DashboardStats {
  totalCameras: number;
  activeCameras: number;
  peopleDetectedToday: number;
  weaponsDetectedToday: number;
  newAlerts: number;
  totalAlerts: number;
  ai: AiStatus;
  // Review 2 (additive, and optional so an older backend response still types).
  totalPeople?: number;
  recognitionEnabledPeople?: number;
  presentToday?: number;
  unknownIdentitiesToday?: number;
}

export interface StreamStats {
  camera_id: string;
  running: boolean;
  mode: CameraMode;
  fps: number;
  inference_ms: number;
  people: number;
  weapons: number;
  model_loaded: boolean;
  // Review 2 (additive, optional for the same reason).
  faces?: number;
  known_faces?: number;
  unknown_faces?: number;
  recognition_available?: boolean;
  recognition_errors?: number;
  // Reports the AI service had to discard because its in-flight POST cap was
  // reached. Non-zero means the backend never learned about those sightings.
  recognition_reports_dropped?: number;
  detection_reports_dropped?: number;
}

export interface RecentEvent {
  kind: 'alert' | 'detection';
  id: string;
  severity: AlertSeverity;
  title: string;
  cameraName: string;
  timestamp: string;
}

/** Socket event payloads (must match backend sockets/index.js). */
export interface DetectionEventPayload {
  id: string;
  cameraId: string;
  cameraName: string;
  type: DetectionType;
  class: string;
  confidence: number;
  source: 'demo' | 'real';
  timestamp: string;
}

// ── Review 2 ─────────────────────────────────────────────────
//
// Mirrors the backend contract exactly:
//   serializePerson()            in backend/src/services/identityRules.js
//   enrich()                     in backend/src/controllers/attendanceController.js
//   enrich()                     in backend/src/controllers/recognitionEventController.js
//   getAttendanceSummary()       in backend/src/controllers/attendanceController.js
//   the Review 2 emit() payloads in backend/src/services/recognitionService.js
//
// PRIVACY: there is deliberately NO embedding field anywhere below. A face
// embedding is biometric data; the only endpoint in the whole API that emits
// one is the shared-secret-gated GET /api/ai/face-embeddings, which is
// service-to-service and never reaches the browser. Because the Person type has
// no such field, the type system itself forbids the frontend from handling a
// biometric vector. Recognition readiness is driven by the derived booleans
// (`faceRegistered`, `recognitionReady`) instead.

/** 'admin' is rendered as "Administrator" — see personCategoryLabel. */
export type PersonCategory = 'student' | 'faculty' | 'staff' | 'admin';

export interface Person {
  /** Mongo _id, serialized as `id` by the backend. */
  id: string;
  personId: string;
  name: string;
  email: string;
  category: PersonCategory;
  department: string;
  /** Pre-existing free-text field, kept alongside `category`. */
  role: string;
  /** URL reference to the stored photograph — never image bytes. */
  photo: string | null;
  recognitionEnabled: boolean;
  active: boolean;
  /** Derived: a face embedding exists for this person. */
  faceRegistered: boolean;
  /** Derived: faceRegistered AND recognitionEnabled AND active. */
  recognitionReady: boolean;
  embeddingModel: string | null;
  /** Vector LENGTH only — metadata, never the vector. */
  embeddingDim: number | null;
  faceRegisteredAt: string | null;
  registeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonInput {
  personId: string;
  name: string;
  email?: string;
  category: PersonCategory;
  department?: string;
  role?: string;
  recognitionEnabled?: boolean;
  active?: boolean;
}

/**
 * Recognition outcome. `known` is the ONLY status for which a person's name may
 * be rendered — see backend validateIdentityClaim(): being the closest
 * candidate is not a match.
 */
export type RecognitionStatus = 'known' | 'unknown' | 'low_quality' | 'recognition_unavailable';

export interface RecognitionEvent {
  id: string;
  cameraId: string;
  cameraName: string;
  location: string | null;
  status: RecognitionStatus;
  /** Populated only for a verified `known` event. */
  personId: string | null;
  personName: string | null;
  category: PersonCategory | null;
  department: string | null;
  /**
   * Cosine similarity between face embeddings. This is NOT an object-detection
   * confidence and NOT a calibrated probability — never render it with the same
   * label as Detection.confidence.
   */
  similarity: number | null;
  /** Real coordinates from the AI service: [x, y, width, height]. */
  boundingBox: number[] | null;
  snapshot: string | null;
  trackId: string | null;
  source: 'real' | 'demo';
  acknowledged: boolean;
  alertId: string | null;
  timestamp: string;
}

export type AttendanceStatus = 'present' | 'late' | 'absent';
export type AttendanceSource = 'recognition' | 'manual' | 'demo';

export interface AttendanceRecord {
  id: string;
  personId: string;
  personName: string;
  category: PersonCategory | null;
  department: string | null;
  photo: string | null;
  cameraId: string | null;
  cameraName: string | null;
  /** The attendance session key: a 'YYYY-MM-DD' calendar date. */
  date: string;
  sessionKey: string;
  firstSeen: string;
  lastSeen: string | null;
  status: AttendanceStatus;
  source: AttendanceSource;
  recognitionEventId: string | null;
  /** Face similarity, not a detector confidence. */
  similarity: number | null;
  createdAt: string;
}

/**
 * Every figure here is counted/aggregated by the backend over persisted
 * documents. The UI must render them as-is and must never recompute them from a
 * partial page of rows.
 */
export interface AttendanceSummary {
  date: string;
  totalRegistered: number;
  recognitionReadyPeople: number;
  presentToday: number;
  notMarked: number;
  attendancePercentage: number;
  recentRecords: AttendanceRecord[];
}

/** Successful outcome of POST /api/people/:id/face-registration. */
export interface FaceRegistrationResult {
  status: 'OK';
  faceDetected: boolean;
  /** Backend message, relayed verbatim: 'Face detected successfully.' */
  detectionMessage: string;
  /** Backend message, relayed verbatim: 'Face registration completed successfully.' */
  message: string;
  facesDetected: number;
  boundingBox: number[] | null;
  /** Face DETECTION score from the detector — not a recognition similarity. */
  detectionScore: number | null;
  person: Person;
}

/** person:recognized — emitted only after the backend re-verified the claim. */
export interface PersonRecognizedPayload {
  eventId: string;
  cameraId: string;
  cameraName?: string;
  personId: string;
  personName: string;
  similarity: number | null;
  threshold: number;
  boundingBox: number[] | null;
  status: 'known';
  source: 'real' | 'demo';
  attendanceMarked: boolean;
  timestamp: string;
}

/** identity:unknown — an unmatched face, not proof of wrongdoing. */
export interface IdentityUnknownPayload {
  eventId: string;
  alertId: string;
  cameraId: string;
  cameraName?: string;
  status: 'unknown';
  reason?: string;
  similarity: number | null;
  threshold: number;
  boundingBox: number[] | null;
  snapshot: string | null;
  trackId?: string | null;
  sightings?: number;
  source: 'real' | 'demo';
  timestamp: string;
}

/** attendance:marked — emitted only when a record was actually created. */
export interface AttendanceMarkedPayload {
  id: string;
  personId: string;
  personName: string;
  cameraId: string | null;
  cameraName?: string;
  date: string;
  status: AttendanceStatus;
  source: AttendanceSource;
  firstSeen: string;
  lastSeen: string | null;
  similarity: number | null;
}

/** Display label for a person category. 'admin' reads as "Administrator". */
export const personCategoryLabel: Record<PersonCategory, string> = {
  student: 'Student',
  faculty: 'Faculty',
  staff: 'Staff',
  admin: 'Administrator',
};

