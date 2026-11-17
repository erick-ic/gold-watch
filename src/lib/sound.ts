let audioContext: AudioContext | null = null;

type AudioContextConstructor = typeof AudioContext;

function getConstructor(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  const ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  return ctor ?? null;
}

function ensureContext(): AudioContext | null {
  if (audioContext) return audioContext;
  const Ctor = getConstructor();
  if (!Ctor) return null;
  audioContext = new Ctor();
  return audioContext;
}

export function primeAudio(): void {
  const context = ensureContext();
  if (!context) return;
  if (context.state === 'suspended') {
    void context.resume().catch(() => undefined);
  }
}

export function playChime(): void {
  const context = ensureContext();
  if (!context) return;
  if (context.state === 'running') {
    scheduleChime(context);
    return;
  }
  void context
    .resume()
    .then(() => scheduleChime(context))
    .catch(() => undefined);
}

function scheduleChime(context: AudioContext): void {
  const start = context.currentTime + 0.02;
  const notes = [
    { frequency: 880, offset: 0, duration: 0.6, gain: 0.16 },
    { frequency: 1318.51, offset: 0.16, duration: 0.8, gain: 0.12 },
  ];

  for (const note of notes) {
    for (const [frequency, level] of [
      [note.frequency, note.gain],
      [note.frequency * 2, note.gain * 0.25],
    ] as const) {
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      const attackAt = start + note.offset;
      const releaseAt = attackAt + note.duration;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, attackAt);
      envelope.gain.setValueAtTime(0.0001, attackAt);
      envelope.gain.exponentialRampToValueAtTime(level, attackAt + 0.02);
      envelope.gain.exponentialRampToValueAtTime(0.0001, releaseAt);
      oscillator.connect(envelope);
      envelope.connect(context.destination);
      oscillator.start(attackAt);
      oscillator.stop(releaseAt + 0.05);
    }
  }
}
