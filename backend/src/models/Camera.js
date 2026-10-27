import mongoose from 'mongoose';

/**
 * Camera — a video source (RTSP/IP stream in REAL mode, sample video in DEMO mode).
 *
 * Future-ready schema. Camera management (CRUD + streaming) is a Review 1 feature;
 * the schema is defined now so the architecture is stable.
 */
const cameraSchema = new mongoose.Schema(
  {
    cameraId: { type: String, required: true, unique: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    location: { type: String, trim: true },
    streamUrl: { type: String, trim: true },
    mode: { type: String, enum: ['demo', 'real', 'webcam'], default: 'demo' },
    status: {
      type: String,
      enum: ['online', 'offline', 'error'],
      default: 'offline',
      index: true,
    },
    aiEnabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Camera = mongoose.model('Camera', cameraSchema);
