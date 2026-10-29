import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Play,
  Square,
  ShieldAlert,
  Video,
  Gauge,
  Users,
  Cctv,
  ScanFace,
  UserCheck,
  Volume2,
  VolumeX,
  Bell,
} from 'lucide-react';
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  Button,
  Badge,
  Select,
  StatusIndicator,
  LoadingState,
  ErrorState,
} from '@/components/ui';
import { cameraService } from '@/services/cameraService';
import { dashboardService } from '@/services/dashboardService';
import { recognitionService } from '@/services/recognitionService';
import { useSocketEvent } from '@/hooks/useSocketEvent';
import { SocketEvents } from '@/services/socket';
import { formatTime } from '@/utils/format';
import {
  isBuzzerMuted,
  playWeaponBuzzer,
  toggleBuzzerMuted,
  triggerWeaponAlarm,
} from '@/utils/audioAlert';
import type {
  AiStatus,
  Alert,
  Camera,
  DetectionEventPayload,
  DetectorStatus,
  IdentityUnknownPayload,
  PersonRecognizedPayload,
  StreamStats,
  ViewStatus,
} from '@/types';

/**
 * Live Monitoring — the Review 1 centerpiece, extended in Review 2 with
 * identity results.
 *
 * The annotated video (with real detection boxes drawn by the AI service) is
 * proxied through the backend and shown in an <img>. Live stats are polled
 * while monitoring; recent detections stream in over Socket.IO.
 *
 * OVERLAY POLICY (Review 2): bounding boxes and identity labels are drawn
 * SERVER-SIDE by the AI service, onto the MJPEG frames themselves, from the
 * coordinates its own models produced. This page deliberately draws no
 * client-side overlay on top of the <img>. The stream is rendered with
 * object-contain letterboxing, so a client-side box would have to re-derive the
 * rendered content box from the intrinsic frame aspect ratio versus the element
 * box and then rescale the AI service's pixel coordinates (which are in the
 * processed frame's space, AI_SERVICE_FRAME_WIDTH = 640). A box that is even
 * slightly misaligned would point at the wrong person, which is worse than no
 * box at all — so the accurate server-drawn overlay stays the single source of
 * truth. Identity results are reported textually in the panel instead, and when
 * no recognition result is available the service state is shown rather than
 * placeholder identity information.
 *
 * MEASUREMENT POLICY: object-detection confidence (Recent Detections) and
 * face-recognition similarity (Identity Results) are different measurements.
 * They live in different panels, carry different labels, and never share a
 * column or a formatting helper.
 */

/** One per-face outcome, from the backend's verified recognition events. */
interface IdentityFeedItem {
  key: string;
  status: 'known' | 'unknown';
  /** Populated ONLY for a confirmed match. */
  personName?: string;
  similarity: number | null;
  /**
   * The threshold the match was judged against. Absent for items seeded from
   * the persisted event history, which does not record it — in that case no
   * threshold is displayed rather than a guessed one.
   */
  threshold?: number;
  /**
   * Absent for history-seeded items: whether that recognition marked
   * attendance is not recorded on the event, so no claim is made either way.
   */
  attendanceMarked?: boolean;
  source: 'real' | 'demo';
  timestamp: string;
}

export function LiveMonitoringPage() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [status, setStatus] = useState<ViewStatus>('loading');
  const [selectedId, setSelectedId] = useState<string>('');

  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamSrc, setStreamSrc] = useState<string>('');

  const [stats, setStats] = useState<StreamStats | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [recent, setRecent] = useState<DetectionEventPayload[]>([]);
  const [identities, setIdentities] = useState<IdentityFeedItem[]>([]);

  const [buzzerMuted, setBuzzerMutedState] = useState(isBuzzerMuted());
  const [weaponAlertActive, setWeaponAlertActive] = useState(false);
  const weaponAlertTimeout = useRef<number | null>(null);

  const statsTimer = useRef<number | null>(null);

  const selected = cameras.find((c) => c._id === selectedId) || null;

  const notifyWeaponDetected = useCallback(() => {
    setWeaponAlertActive(true);
    triggerWeaponAlarm();
    if (weaponAlertTimeout.current) {
      window.clearTimeout(weaponAlertTimeout.current);
    }
    weaponAlertTimeout.current = window.setTimeout(() => {
      setWeaponAlertActive(false);
    }, 3000);
  }, []);

  const handleToggleBuzzer = useCallback(() => {
    const next = toggleBuzzerMuted();
    setBuzzerMutedState(next);
  }, []);

  const handleTestBuzzer = useCallback(() => {
    setWeaponAlertActive(true);
    playWeaponBuzzer(true);
    if (weaponAlertTimeout.current) {
      window.clearTimeout(weaponAlertTimeout.current);
    }
    weaponAlertTimeout.current = window.setTimeout(() => {
      setWeaponAlertActive(false);
    }, 2500);
  }, []);

  // Load cameras + AI status once.
  useEffect(() => {
    (async () => {
      try {
        const [cams, statsData] = await Promise.all([
          cameraService.list(),
          dashboardService.stats().catch(() => null),
        ]);
        setCameras(cams);
        if (statsData) setAi(statsData.ai);
        if (cams.length) setSelectedId(cams[0]._id);
        setStatus(cams.length ? 'success' : 'empty');
      } catch {
        setStatus('error');
      }
    })();
  }, []);

  const stopStatsPolling = useCallback(() => {
    if (statsTimer.current) {
      window.clearInterval(statsTimer.current);
      statsTimer.current = null;
    }
  }, []);

  // Poll live stats while monitoring.
  useEffect(() => {
    if (!running || !selected) return;
    const poll = async () => {
      try {
        const s = await cameraService.stats(selected._id);
        setStats(s);
        if (s && s.weapons > 0) {
          notifyWeaponDetected();
        }
      } catch {
        /* transient — keep last stats */
      }
    };
    poll();
    statsTimer.current = window.setInterval(poll, 1500);
    return stopStatsPolling;
  }, [running, selected, stopStatsPolling, notifyWeaponDetected]);

  // Live detection feed for the selected camera.
  useSocketEvent<DetectionEventPayload>(SocketEvents.DETECTION_NEW, (payload) => {
    if (!selected || payload.cameraId !== selected.cameraId) return;
    setRecent((prev) => [payload, ...prev].slice(0, 8));
    if (payload.type === 'weapon') {
      notifyWeaponDetected();
    }
  });

  // Weapon alert listener for the active camera
  useSocketEvent<Alert>(SocketEvents.ALERT_NEW, (alert) => {
    if (!selected || alert.cameraId !== selected.cameraId) return;
    if (alert.type === 'weapon' || alert.severity === 'critical') {
      notifyWeaponDetected();
    }
  });

  // ── Review 2 · identity results ────────────────────────────
  // Seeded from PERSISTED recognition events, so a client that just opened the
  // page (or was disconnected) still sees recent outcomes. The socket events
  // below SUPPLEMENT this; they do not replace database persistence.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    recognitionService
      .list({ cameraId: selected.cameraId, limit: 8 })
      .then((result) => {
        if (cancelled) return;
        setIdentities(
          result.items
            .filter((event) => event.status === 'known' || event.status === 'unknown')
            .map((event) => ({
              key: event.id,
              status: event.status === 'known' ? ('known' as const) : ('unknown' as const),
              // A name only ever travels with a verified 'known' event.
              personName: event.status === 'known' ? (event.personName ?? undefined) : undefined,
              similarity: event.similarity,
              source: event.source,
              timestamp: event.timestamp,
            }))
        );
      })
      .catch(() => {
        /* non-fatal — the live feed below still works */
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Both socket events are emitted by the backend only AFTER it re-verified the
  // result against its own person records and its own threshold, so nothing
  // here is a raw model guess.
  useSocketEvent<PersonRecognizedPayload>(SocketEvents.PERSON_RECOGNIZED, (payload) => {
    if (!selected || payload.cameraId !== selected.cameraId) return;
    setIdentities((prev) =>
      [
        {
          key: payload.eventId,
          status: 'known' as const,
          personName: payload.personName,
          similarity: payload.similarity,
          threshold: payload.threshold,
          attendanceMarked: payload.attendanceMarked,
          source: payload.source,
          timestamp: payload.timestamp,
        },
        ...prev,
      ].slice(0, 8)
    );
  });

  useSocketEvent<IdentityUnknownPayload>(SocketEvents.IDENTITY_UNKNOWN, (payload) => {
    if (!selected || payload.cameraId !== selected.cameraId) return;
    setIdentities((prev) =>
      [
        {
          key: payload.eventId,
          status: 'unknown' as const,
          // No name is carried, and none is invented: an unmatched face has no
          // identity to display.
          similarity: payload.similarity,
          threshold: payload.threshold,
          attendanceMarked: false,
          source: payload.source,
          timestamp: payload.timestamp,
        },
        ...prev,
      ].slice(0, 8)
    );
  });

  // Recognition availability can change at runtime (models loaded/unloaded).
  // When the backend announces a transition, re-read the real detector array
  // rather than inferring a new status locally.
  useSocketEvent<{ available: boolean }>(SocketEvents.RECOGNITION_STATUS, () => {
    dashboardService
      .stats()
      .then((data) => setAi(data.ai))
      .catch(() => {
        /* non-fatal — the panel keeps the last known status */
      });
  });

  async function handleStart() {
    if (!selected) return;
    setStarting(true);
    setStreamError(null);
    try {
      await cameraService.startMonitoring(selected._id);
      setStreamSrc(cameraService.streamUrl(selected._id));
      setRunning(true);
    } catch (err) {
      setStreamError((err as { message?: string }).message ?? 'AI detection is temporarily unavailable.');
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    if (!selected) return;
    await cameraService.stopMonitoring(selected._id).catch(() => {});
    setRunning(false);
    setStreamSrc('');
    setStats(null);
    stopStatsPolling();
  }

  // Stop stream when switching cameras.
  function handleSelect(id: string) {
    if (running) handleStop();
    setSelectedId(id);
    setRecent([]);
    setIdentities([]);
  }

  async function handleDemoWeapon() {
    if (!selected) return;
    notifyWeaponDetected();
    await cameraService.triggerDemoWeapon(selected._id).catch(() => {});
  }

  if (status === 'loading') return <LoadingState message="Loading cameras…" />;
  if (status === 'error') return <ErrorState message="Unable to load monitoring." />;
  if (status === 'empty') {
    return (
      <div>
        <PageHeader title="Live Monitoring" description="Real-time camera feeds with AI detection." />
        <Card>
          <CardBody>
            <div className="py-10 text-center text-sm text-content-muted">
              No cameras registered yet. Add one on the Cameras page to begin.
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }

  const detectorByKey = new Map<string, DetectorStatus>(
    (ai?.detectors ?? []).map((d) => [d.key, d])
  );
  const faceRecognitionDetector = detectorByKey.get('face_recognition');
  const recognitionOperational =
    faceRecognitionDetector?.status === 'active' || stats?.recognition_available === true;

  return (
    <div>
      <PageHeader
        title="Live Monitoring"
        description="Select a camera and start the AI-processed stream."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Main video area */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardBody className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="w-64">
                  <Select
                    value={selectedId}
                    onChange={(e) => handleSelect(e.target.value)}
                    options={cameras.map((c) => ({ value: c._id, label: `${c.name} (${c.cameraId})` }))}
                  />
                </div>
                <div className="flex items-center gap-2">
                  {selected?.mode === 'demo' && <Badge tone="info">DEMO MODE</Badge>}
                  {selected?.mode === 'webcam' && <Badge tone="safe">WEBCAM</Badge>}
                  {running ? (
                    <Button variant="danger" size="sm" leftIcon={<Square className="h-4 w-4" />} onClick={handleStop}>
                      Stop
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      leftIcon={<Play className="h-4 w-4" />}
                      loading={starting}
                      onClick={handleStart}
                    >
                      Start Stream
                    </Button>
                  )}
                </div>
              </div>

              {/* Video canvas */}
              <div
                className={`relative aspect-video overflow-hidden rounded-lg border bg-black transition-all duration-300 ${
                  weaponAlertActive
                    ? 'border-critical ring-4 ring-critical/70 shadow-[0_0_35px_rgba(239,68,68,0.5)]'
                    : 'border-border'
                }`}
              >
                {running && streamSrc && !streamError ? (
                  <>
                    <img
                      src={streamSrc}
                      alt="Live camera feed"
                      className="h-full w-full object-contain"
                      onError={() =>
                        setStreamError('Camera connection unavailable. Retry connection.')
                      }
                    />
                    <div className="absolute left-3 top-3 flex items-center gap-2">
                      <span className="flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-xs font-medium text-white">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-critical" /> LIVE
                      </span>
                      <span className="rounded-md bg-black/60 px-2 py-1 text-xs font-medium text-info">
                        AI ACTIVE
                      </span>
                      {!buzzerMuted && (
                        <span className="flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-xs font-medium text-safe">
                          <Volume2 className="h-3 w-3" /> BUZZER ARMED
                        </span>
                      )}
                    </div>

                    {weaponAlertActive && (
                      <div className="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-lg bg-critical px-3 py-1.5 text-xs font-bold text-white shadow-xl animate-pulse border border-red-300">
                        <ShieldAlert className="h-4 w-4 animate-bounce text-white" />
                        <span>CRITICAL: WEAPON DETECTED!</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-content-muted">
                    {streamError ? (
                      <ErrorState message={streamError} onRetry={handleStart} />
                    ) : (
                      <>
                        <Video className="h-8 w-8" />
                        <p className="text-sm">Stream stopped. Press “Start Stream” to begin AI monitoring.</p>
                      </>
                    )}
                  </div>
                )}
              </div>

              {running && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
                  <p className="text-xs text-content-faint">
                    Detection boxes and identity labels are drawn by the AI service from real model
                    coordinates.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant={buzzerMuted ? 'secondary' : 'danger'}
                      size="sm"
                      leftIcon={
                        buzzerMuted ? (
                          <VolumeX className="h-4 w-4" />
                        ) : (
                          <Volume2 className="h-4 w-4 animate-pulse" />
                        )
                      }
                      onClick={handleToggleBuzzer}
                      title={
                        buzzerMuted
                          ? 'Alarm buzzer is MUTED. Click to activate sound.'
                          : 'Alarm buzzer is ACTIVE. Click to mute sound.'
                      }
                    >
                      {buzzerMuted ? 'Buzzer Muted' : 'Buzzer Armed'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      leftIcon={<Bell className="h-4 w-4 text-warning" />}
                      onClick={handleTestBuzzer}
                      title="Test the security weapon buzzer sound"
                    >
                      Test Buzzer
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      leftIcon={<ShieldAlert className="h-4 w-4" />}
                      onClick={handleDemoWeapon}
                      title="Injects a clearly-labelled DEMO weapon detection to demonstrate the alert pipeline"
                    >
                      Trigger demo weapon
                    </Button>
                  </div>
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        {/* Side panel */}
        <div className="space-y-4">
          <Card>
            <CardHeader title="Camera" />
            <CardBody className="space-y-3 text-sm">
              <Row label="Name" value={selected?.name ?? '—'} />
              <Row label="Location" value={selected?.location || '—'} />
              <div className="flex items-center justify-between">
                <span className="text-content-muted">Status</span>
                <StatusIndicator status={running ? 'online' : 'offline'} label={running ? 'Online' : 'Offline'} pulse={running} />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="AI System" />
            <CardBody className="space-y-2.5 text-sm">
              {/*
                Each row renders the REAL status the AI service reported for that
                service. ACTIVE appears only when the backend says the service is
                genuinely operational; a missing entry (AI service unreachable)
                reads UNAVAILABLE rather than defaulting to active.
              */}
              <ServiceRow label="Human Detection" detector={detectorByKey.get('human')} />
              <ServiceRow label="Weapon Detection" detector={detectorByKey.get('weapon')} />
              <ServiceRow label="Face Detection" detector={detectorByKey.get('face')} />
              <ServiceRow label="Face Recognition" detector={faceRecognitionDetector} />
              <ServiceRow label="Attendance Service" detector={detectorByKey.get('attendance')} />
              <DetectorRow label="Video Processing" active={running} activeLabel="Active" idleLabel="Idle" />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Identity Results" description="Face recognition — most recent faces" />
            <CardBody className="space-y-3">
              {!recognitionOperational && (
                <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                  Face recognition is{' '}
                  {faceRecognitionDetector?.status === 'error' ? 'reporting an error' : 'unavailable'}
                  . Human and weapon detection continue to work; no identity results will appear
                  until recognition is operational.
                </p>
              )}

              {identities.length === 0 ? (
                <p className="py-3 text-center text-xs text-content-faint">
                  {running
                    ? 'No face has been evaluated yet on this camera.'
                    : 'Start the stream to see identity results.'}
                </p>
              ) : (
                <ul className="space-y-2.5">
                  {identities.map((item) => (
                    <li
                      key={item.key}
                      className="rounded-lg border border-border bg-surface px-3 py-2.5 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          <ScanFace
                            className={
                              item.status === 'known'
                                ? 'h-3.5 w-3.5 shrink-0 text-safe'
                                : 'h-3.5 w-3.5 shrink-0 text-warning'
                            }
                            aria-hidden="true"
                          />
                          {/* A name is rendered ONLY for a confirmed match. */}
                          <span className="truncate text-content">
                            {item.status === 'known' ? item.personName : 'Unknown identity'}
                          </span>
                          {item.source === 'demo' && <Badge tone="info">DEMO</Badge>}
                        </span>
                        <span className="shrink-0 text-content-faint">
                          {formatTime(item.timestamp)}
                        </span>
                      </div>

                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-content-muted">
                        {/*
                          Labelled "Face similarity" on purpose. This is a cosine
                          similarity between face embeddings — a different
                          measurement from the detection confidence shown in the
                          Recent Detections panel, and not a probability.
                        */}
                        <span>
                          Face similarity:{' '}
                          <span className="font-mono text-content">
                            {item.similarity !== null ? item.similarity.toFixed(3) : 'n/a'}
                          </span>
                        </span>
                        {typeof item.threshold === 'number' && (
                          <span className="text-content-faint">
                            threshold {item.threshold.toFixed(3)}
                          </span>
                        )}
                      </div>

                      {item.status === 'known' && item.attendanceMarked === true && (
                        <p className="mt-1.5 flex items-center gap-1.5 text-safe">
                          <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
                          Attendance marked for today
                        </p>
                      )}
                      {item.status === 'unknown' && (
                        <p className="mt-1.5 text-content-faint">
                          No registered identity met the threshold. Review the event on the Alerts
                          page.
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <p className="border-t border-border pt-2.5 text-xs text-content-faint">
                An unknown identity means the system could not confidently match the face to a
                registered person. It does not prove the person is unauthorized or dangerous.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Processing" />
            <CardBody className="grid grid-cols-2 gap-3 text-sm">
              <Metric icon={<Gauge className="h-4 w-4" />} label="FPS" value={running ? String(stats?.fps ?? '—') : '—'} />
              <Metric icon={<Gauge className="h-4 w-4" />} label="Inference" value={running && stats ? `${stats.inference_ms}ms` : '—'} />
              <Metric icon={<Users className="h-4 w-4" />} label="People" value={running ? String(stats?.people ?? 0) : '—'} />
              <Metric icon={<ShieldAlert className="h-4 w-4" />} label="Weapons" value={running ? String(stats?.weapons ?? 0) : '—'} />
              <Metric icon={<ScanFace className="h-4 w-4" />} label="Faces" value={running ? String(stats?.faces ?? 0) : '—'} />
              <Metric
                icon={<UserCheck className="h-4 w-4" />}
                label="Known faces"
                value={running ? String(stats?.known_faces ?? 0) : '—'}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Recent Detections"
              description="Object detection — people and weapons"
            />
            <CardBody>
              {recent.length === 0 ? (
                <p className="py-4 text-center text-xs text-content-faint">
                  {running ? 'Watching for detections…' : 'Start the stream to see detections.'}
                </p>
              ) : (
                <ul className="space-y-2">
                  {recent.map((d, i) => (
                    <li key={`${d.id}-${i}`} className="text-xs">
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2">
                          <Cctv className="h-3.5 w-3.5 text-content-faint" />
                          <span className="capitalize text-content">{d.class} detected</span>
                          {d.source === 'demo' && <Badge tone="info">DEMO</Badge>}
                        </span>
                        <span className="text-content-faint">{formatTime(d.timestamp)}</span>
                      </div>
                      {/*
                        Labelled "Detection confidence" on purpose: this is the
                        object detector's score, a different measurement from the
                        face similarity shown in Identity Results above.
                      */}
                      <p className="mt-0.5 pl-5 text-content-muted">
                        Detection confidence:{' '}
                        <span className="font-mono text-content">
                          {Math.round(d.confidence * 100)}%
                        </span>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-content-muted">{label}</span>
      <span className="text-content">{value}</span>
    </div>
  );
}

function DetectorRow({
  label,
  active,
  activeLabel = 'Active',
  idleLabel = 'Unavailable',
}: {
  label: string;
  active?: boolean;
  activeLabel?: string;
  idleLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-content-muted">{label}</span>
      <StatusIndicator status={active ? 'ai' : 'offline'} label={active ? activeLabel : idleLabel} />
    </div>
  );
}

/**
 * One AI-service row in the status panel, driven by the REAL detector status
 * array the backend relays from the AI service.
 *
 * ACTIVE is shown only when the service reported 'active'. A detector that is
 * absent from the array — which is what happens when the AI service is
 * unreachable — reads UNAVAILABLE. Nothing here ever optimistically reports a
 * service as operational.
 */
function ServiceRow({ label, detector }: { label: string; detector?: DetectorStatus }) {
  const presentation: Record<
    DetectorStatus['status'],
    { status: 'ai' | 'warning' | 'offline' | 'error'; label: string }
  > = {
    active: { status: 'ai', label: 'ACTIVE' },
    demo: { status: 'warning', label: 'DEMO' },
    inactive: { status: 'offline', label: 'INACTIVE' },
    unavailable: { status: 'offline', label: 'UNAVAILABLE' },
    error: { status: 'error', label: 'ERROR' },
  };
  const view = detector
    ? presentation[detector.status]
    : { status: 'offline' as const, label: 'UNAVAILABLE' };

  return (
    <div className="flex items-center justify-between">
      <span className="text-content-muted">{label}</span>
      <StatusIndicator status={view.status} label={view.label} />
    </div>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="flex items-center gap-1.5 text-xs text-content-muted">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold text-content">{value}</p>
    </div>
  );
}
