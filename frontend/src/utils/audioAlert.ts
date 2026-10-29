/**
 * Audio Alert & Buzzer Service for CamSense AI.
 *
 * Uses the Web Audio API to synthesize emergency security buzzers directly
 * in the browser with zero network latency and no external audio asset dependencies.
 */

let sharedAudioContext: AudioContext | null = null;
let isMutedState = false;
let lastAlarmTimestamp = 0;
const ALARM_COOLDOWN_MS = 3500; // Minimum gap between alarm buzzer bursts

// Load initial mute preference from localStorage
try {
  const saved = localStorage.getItem('camsense_buzzer_muted');
  if (saved !== null) {
    isMutedState = saved === 'true';
  }
} catch {
  // Ignore localStorage errors
}

/**
 * Returns or initializes the shared AudioContext.
 * Automatically handles browser autoplay suspension.
 */
function getAudioContext(): AudioContext | null {
  try {
    if (!sharedAudioContext) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      sharedAudioContext = new AudioCtx();
    }
    if (sharedAudioContext.state === 'suspended') {
      sharedAudioContext.resume().catch(() => {});
    }
    return sharedAudioContext;
  } catch (err) {
    console.warn('[audioAlert] Failed to initialize AudioContext:', err);
    return null;
  }
}

// Automatically unlock audio context on the first user click/touch anywhere on the page
if (typeof window !== 'undefined') {
  const unlockAudio = () => {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    window.removeEventListener('click', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
    window.removeEventListener('touchstart', unlockAudio);
  };
  window.addEventListener('click', unlockAudio, { passive: true });
  window.addEventListener('keydown', unlockAudio, { passive: true });
  window.addEventListener('touchstart', unlockAudio, { passive: true });
}

/**
 * Whether the alert buzzer is currently muted by user preference.
 */
export function isBuzzerMuted(): boolean {
  return isMutedState;
}

/**
 * Sets the buzzer mute state and persists to localStorage.
 */
export function setBuzzerMuted(muted: boolean): boolean {
  isMutedState = muted;
  try {
    localStorage.setItem('camsense_buzzer_muted', String(muted));
  } catch {
    // Ignore localStorage errors
  }
  return isMutedState;
}

/**
 * Toggles the buzzer mute state.
 */
export function toggleBuzzerMuted(): boolean {
  return setBuzzerMuted(!isMutedState);
}

/**
 * Plays a high-intensity, 3-burst security alarm buzzer sound.
 * Designed to sound like an authoritative security / weapon detection alarm.
 *
 * @param force If true, bypasses the mute check (e.g. for testing the sound).
 */
export function playWeaponBuzzer(force = false): boolean {
  if (isMutedState && !force) {
    return false;
  }

  const ctx = getAudioContext();
  if (!ctx) return false;

  const now = ctx.currentTime;
  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(0.85, now);
  masterGain.connect(ctx.destination);

  // 3 distinct, piercing siren-buzzer pulses
  const pulseOffsets = [0.0, 0.22, 0.44];

  pulseOffsets.forEach((offset) => {
    const startTime = now + offset;
    const pulseDuration = 0.16;

    // Primary harsh sawtooth oscillator (950Hz sliding down to 700Hz)
    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(950, startTime);
    osc1.frequency.exponentialRampToValueAtTime(700, startTime + pulseDuration);

    // Sub-harmonic square oscillator for a rich, punchy industrial buzzer feel (475Hz -> 350Hz)
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(475, startTime);
    osc2.frequency.exponentialRampToValueAtTime(350, startTime + pulseDuration);

    // Minor third dissonance oscillator (800Hz) to create immediate psychological alertness
    const osc3 = ctx.createOscillator();
    osc3.type = 'sawtooth';
    osc3.frequency.setValueAtTime(800, startTime);
    osc3.frequency.exponentialRampToValueAtTime(600, startTime + pulseDuration);

    // Pulse volume envelope
    const pulseGain = ctx.createGain();
    pulseGain.gain.setValueAtTime(0.001, startTime);
    pulseGain.gain.linearRampToValueAtTime(0.7, startTime + 0.015); // Fast attack
    pulseGain.gain.setValueAtTime(0.7, startTime + pulseDuration - 0.03);
    pulseGain.gain.exponentialRampToValueAtTime(0.001, startTime + pulseDuration); // Crisp release

    osc1.connect(pulseGain);
    osc2.connect(pulseGain);
    osc3.connect(pulseGain);
    pulseGain.connect(masterGain);

    osc1.start(startTime);
    osc2.start(startTime);
    osc3.start(startTime);
    osc1.stop(startTime + pulseDuration);
    osc2.stop(startTime + pulseDuration);
    osc3.stop(startTime + pulseDuration);
  });

  return true;
}

/**
 * Triggers a weapon alarm with automatic rate-limiting / cooldown.
 * Called whenever a weapon is detected on stream or via WebSocket.
 *
 * @returns true if an alarm was sounded, false if muted or in cooldown.
 */
export function triggerWeaponAlarm(): boolean {
  if (isMutedState) return false;

  const now = Date.now();
  if (now - lastAlarmTimestamp < ALARM_COOLDOWN_MS) {
    return false; // Still within cooldown window
  }

  lastAlarmTimestamp = now;
  return playWeaponBuzzer(false);
}
