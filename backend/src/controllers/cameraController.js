import mongoose from 'mongoose';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { Camera } from '../models/Camera.js';
import { aiClient } from '../services/aiClient.js';
import { emit, SocketEvents } from '../sockets/index.js';

export const cameraSchema = z.object({
  cameraId: z.string().min(1, 'Camera ID is required').max(40),
  name: z.string().min(1, 'Name is required').max(80),
  location: z.string().max(120).optional().default(''),
  streamUrl: z.string().max(300).optional().default(''),
  mode: z.enum(['demo', 'real', 'webcam']).default('demo'),
  aiEnabled: z.boolean().default(true),
});

// All fields optional for PUT (partial update).
export const cameraUpdateSchema = cameraSchema.partial();

/** Finds a camera by Mongo _id or by its human cameraId (e.g. "CAM-01"). */
async function findCameraOrThrow(idOrCameraId) {
  const query = mongoose.isValidObjectId(idOrCameraId)
    ? { _id: idOrCameraId }
    : { cameraId: idOrCameraId };
  const camera = await Camera.findOne(query);
  if (!camera) throw ApiError.notFound('Camera not found');
  return camera;
}

export const listCameras = asyncHandler(async (_req, res) => {
  const cameras = await Camera.find().sort({ createdAt: 1 });
  res.json({ success: true, data: cameras });
});

export const getCamera = asyncHandler(async (req, res) => {
  const camera = await findCameraOrThrow(req.params.id);
  res.json({ success: true, data: camera });
});

export const createCamera = asyncHandler(async (req, res) => {
  const exists = await Camera.findOne({ cameraId: req.body.cameraId });
  if (exists) throw ApiError.conflict('A camera with that ID already exists');
  const camera = await Camera.create(req.body);
  res.status(201).json({ success: true, data: camera });
});

export const updateCamera = asyncHandler(async (req, res) => {
  const camera = await findCameraOrThrow(req.params.id);
  // Guard cameraId uniqueness if it's being changed.
  if (req.body.cameraId && req.body.cameraId !== camera.cameraId) {
    const clash = await Camera.findOne({ cameraId: req.body.cameraId });
    if (clash) throw ApiError.conflict('A camera with that ID already exists');
  }
  Object.assign(camera, req.body);
  await camera.save();
  res.json({ success: true, data: camera });
});

export const deleteCamera = asyncHandler(async (req, res) => {
  const camera = await findCameraOrThrow(req.params.id);
  // Best-effort: stop any live monitoring before removing the record.
  await aiClient.stopStream(camera.cameraId).catch(() => {});
  await camera.deleteOne();
  res.json({ success: true, data: { id: camera._id.toString() } });
});

/** Start or stop AI monitoring for a camera (proxies to the AI service). */
export const setMonitoring = asyncHandler(async (req, res) => {
  const action = req.body?.action;
  if (!['start', 'stop'].includes(action)) {
    throw ApiError.badRequest("action must be 'start' or 'stop'");
  }
  const camera = await findCameraOrThrow(req.params.id);

  if (action === 'start') {
    if (!camera.aiEnabled) throw ApiError.badRequest('AI monitoring is disabled for this camera');
    await aiClient.startStream({
      cameraId: camera.cameraId,
      source: camera.mode === 'webcam' ? (camera.streamUrl || '0') : (camera.mode === 'real' ? camera.streamUrl : null),
      mode: camera.mode,
    });
    camera.status = 'online';
  } else {
    await aiClient.stopStream(camera.cameraId).catch(() => {});
    camera.status = 'offline';
  }
  await camera.save();
  emit(SocketEvents.CAMERA_STATUS, { cameraId: camera.cameraId, status: camera.status });
  res.json({ success: true, data: { cameraId: camera.cameraId, status: camera.status, action } });
});

/** Live processing stats for a monitored camera (fps, inference, counts). */
export const getMonitoringStats = asyncHandler(async (req, res) => {
  const camera = await findCameraOrThrow(req.params.id);
  const stats = await aiClient.getStats(camera.cameraId);
  res.json({ success: true, data: stats });
});

/** Injects a clearly-labelled DEMO weapon event (for demonstrating alerts). */
export const triggerDemoWeapon = asyncHandler(async (req, res) => {
  const camera = await findCameraOrThrow(req.params.id);
  const result = await aiClient.triggerDemoWeapon(camera.cameraId);
  res.json({ success: true, data: result });
});

/** Proxies the annotated MJPEG stream from the AI service. */
export const streamCamera = asyncHandler(async (req, res) => {
  const camera = await findCameraOrThrow(req.params.id);
  await aiClient.proxyStream(camera.cameraId, res);
});
