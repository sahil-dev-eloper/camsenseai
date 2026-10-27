import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Modal, Input, Select, Button } from '@/components/ui';
import type { Camera, CameraInput } from '@/types';

/**
 * Add/Edit camera form. Reused for both create and update — the presence of
 * `camera` switches it to edit mode. Emits a CameraInput to the parent, which
 * owns the API call.
 */
const EMPTY: CameraInput = {
  cameraId: '',
  name: '',
  location: '',
  streamUrl: '',
  mode: 'demo',
  aiEnabled: true,
};

export function CameraFormModal({
  open,
  camera,
  saving,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  camera?: Camera | null;
  saving: boolean;
  error?: string | null;
  onSubmit: (input: CameraInput) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<CameraInput>(EMPTY);

  useEffect(() => {
    if (camera) {
      setForm({
        cameraId: camera.cameraId,
        name: camera.name,
        location: camera.location,
        streamUrl: camera.streamUrl,
        mode: camera.mode,
        aiEnabled: camera.aiEnabled,
      });
    } else {
      setForm(EMPTY);
    }
  }, [camera, open]);

  const set = <K extends keyof CameraInput>(key: K, value: CameraInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSubmit(form);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={camera ? 'Edit Camera' : 'Add Camera'}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} loading={saving}>
            {camera ? 'Save changes' : 'Add camera'}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Camera ID"
            name="cameraId"
            placeholder="CAM-01"
            value={form.cameraId}
            onChange={(e) => set('cameraId', e.target.value)}
            disabled={!!camera}
            required
          />
          <Input
            label="Name"
            name="name"
            placeholder="Main Entrance"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            required
          />
        </div>

        <Input
          label="Location"
          name="location"
          placeholder="Building A · Front Door"
          value={form.location}
          onChange={(e) => set('location', e.target.value)}
        />

        <Select
          label="Mode"
          name="mode"
          value={form.mode}
          onChange={(e) => set('mode', e.target.value as CameraInput['mode'])}
          options={[
            { value: 'demo', label: 'Demo — bundled sample video' },
            { value: 'webcam', label: 'Webcam — Laptop / USB Camera' },
            { value: 'real', label: 'Real — RTSP / IP camera' },
          ]}
        />

        {form.mode === 'webcam' && (
          <div className="rounded-lg border border-border bg-raised/40 p-3 text-xs text-content-muted">
            <p className="font-medium text-content">💻 Laptop / Built-in Camera</p>
            <p className="mt-1">
              Connects directly to your device's webcam (index 0). No RTSP stream URL or IP configuration needed!
            </p>
          </div>
        )}

        {form.mode === 'real' && (
          <Input
            label="Stream URL"
            name="streamUrl"
            placeholder="rtsp://user:pass@host:554/stream"
            value={form.streamUrl}
            onChange={(e) => set('streamUrl', e.target.value)}
          />
        )}

        <label className="flex items-center gap-2 text-sm text-content-muted">
          <input
            type="checkbox"
            checked={form.aiEnabled}
            onChange={(e) => set('aiEnabled', e.target.checked)}
            className="h-4 w-4 rounded border-border bg-surface"
          />
          Enable AI monitoring for this camera
        </label>

        {error && (
          <p className="rounded-lg border border-critical/30 bg-critical/10 px-3 py-2 text-xs text-critical">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
