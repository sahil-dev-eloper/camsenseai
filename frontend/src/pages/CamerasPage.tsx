import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Cctv, MapPin } from 'lucide-react';
import {
  PageHeader,
  Card,
  CardBody,
  Button,
  Badge,
  StatusIndicator,
  LoadingState,
  EmptyState,
  ErrorState,
  ConfirmDialog,
} from '@/components/ui';
import { CameraFormModal } from '@/components/CameraFormModal';
import { cameraService } from '@/services/cameraService';
import type { Camera, CameraInput, CameraStatus, ViewStatus } from '@/types';

const statusMap: Record<CameraStatus, 'online' | 'offline' | 'warning' | 'error'> = {
  online: 'online',
  offline: 'offline',
  connecting: 'warning',
  error: 'error',
};

export function CamerasPage() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [status, setStatus] = useState<ViewStatus>('loading');
  const [error, setError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Camera | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<Camera | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const data = await cameraService.list();
      setCameras(data);
      setStatus(data.length === 0 ? 'empty' : 'success');
    } catch (err) {
      setError((err as { message?: string }).message ?? 'Unable to load cameras.');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSubmit(input: CameraInput) {
    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        await cameraService.update(editing._id, input);
      } else {
        await cameraService.create(input);
      }
      setFormOpen(false);
      setEditing(null);
      await load();
    } catch (err) {
      setFormError((err as { message?: string }).message ?? 'Could not save camera.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await cameraService.remove(deleteTarget._id);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError((err as { message?: string }).message ?? 'Could not delete camera.');
    } finally {
      setDeleting(false);
    }
  }

  async function toggleAi(camera: Camera) {
    try {
      await cameraService.update(camera._id, { aiEnabled: !camera.aiEnabled });
      await load();
    } catch (err) {
      setError((err as { message?: string }).message ?? 'Could not update camera.');
    }
  }

  return (
    <div>
      <PageHeader
        title="Cameras"
        description="Register and manage camera sources."
        action={
          <Button
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => {
              setEditing(null);
              setFormError(null);
              setFormOpen(true);
            }}
          >
            Add Camera
          </Button>
        }
      />

      {status === 'loading' && <LoadingState message="Loading cameras…" />}
      {status === 'error' && <ErrorState message={error ?? undefined} onRetry={load} />}
      {status === 'empty' && (
        <Card>
          <CardBody>
            <EmptyState
              icon={<Cctv className="h-6 w-6" />}
              title="No cameras yet"
              description="Add your first camera to start monitoring. Use Demo mode to run without hardware."
              action={
                <Button size="sm" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setFormOpen(true)}>
                  Add Camera
                </Button>
              }
            />
          </CardBody>
        </Card>
      )}

      {status === 'success' && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {cameras.map((camera) => (
            <Card key={camera._id}>
              <CardBody className="space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-content-faint">{camera.cameraId}</span>
                      {camera.mode === 'demo' && <Badge tone="info">DEMO</Badge>}
                      {camera.mode === 'webcam' && <Badge tone="safe">WEBCAM</Badge>}
                    </div>
                    <h3 className="mt-1 text-sm font-semibold text-content">{camera.name}</h3>
                  </div>
                  <StatusIndicator status={statusMap[camera.status]} />
                </div>

                <p className="flex items-center gap-1.5 text-xs text-content-muted">
                  <MapPin className="h-3.5 w-3.5" />
                  {camera.location || 'No location set'}
                </p>

                <div className="flex items-center justify-between border-t border-border pt-3">
                  <button
                    onClick={() => toggleAi(camera)}
                    className="text-xs"
                    title="Toggle AI monitoring"
                  >
                    <Badge tone={camera.aiEnabled ? 'safe' : 'neutral'}>
                      AI Monitoring: {camera.aiEnabled ? 'ON' : 'OFF'}
                    </Badge>
                  </button>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditing(camera);
                        setFormError(null);
                        setFormOpen(true);
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(camera)}>
                      <Trash2 className="h-4 w-4 text-critical" />
                    </Button>
                  </div>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <CameraFormModal
        open={formOpen}
        camera={editing}
        saving={saving}
        error={formError}
        onSubmit={handleSubmit}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete camera"
        message={`Delete "${deleteTarget?.name}" (${deleteTarget?.cameraId})? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
