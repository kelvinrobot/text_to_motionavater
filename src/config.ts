import smplx133Mapping from './data/smplx133_mapping.json';

export const smplxMapping = smplx133Mapping;

export const config = {
  apiBaseUrl:
    (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
    'https://remostartdev-text-to-signmotion.hf.space',
  apiToken: (import.meta.env.VITE_API_TOKEN as string | undefined) ?? '',
  motionFps: smplx133Mapping.fps,
  frameDimension: smplx133Mapping.frame_dimension,
  paceMin: 0.5,
  paceMax: 2.0,
  paceDefault: 1.0,
  healthPollIntervalMilliseconds: 3000,
  pingIntervalMs: 15000,
  reconnectBackoffMs: 1000,
  maxReconnectBackoffMs: 15000,
  avatarModelPath: '/avatar.vrm',
  voiceTranscriptionNotice: 'Chrome sends microphone audio to Google for transcription.',
};

export function getWebSocketUrl(): string {
  const baseUrl = config.apiBaseUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  return `${baseUrl.replace(/\/$/, '')}/ws?token=${encodeURIComponent(config.apiToken)}`;
}

export function getMotionWebSocketUrl(): string {
  return getWebSocketUrl();
}

export function getHealthUrl(): string {
  const baseUrl = config.apiBaseUrl.replace(/\/$/, '');
  return `${baseUrl}/health`;
}
