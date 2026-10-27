import smplx133Mapping from './data/smplx133_mapping.json';

export const smplxMapping = smplx133Mapping;

export const config = {
  apiBaseUrl:
    (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
    'https://remostartdev-text-to-signmotion.hf.space',
  motionFps: smplx133Mapping.fps,
  frameDimension: smplx133Mapping.frame_dimension,
  paceMin: 0.5,
  paceMax: 2.0,
  paceDefault: 0.9,
  healthPollIntervalMilliseconds: 3000,
  pingIntervalMs: 15000,
  reconnectBackoffMs: 1000,
  maxReconnectBackoffMs: 15000,
  avatarModelPath:
    (import.meta.env.VITE_AVATAR_MODEL_PATH as string | undefined) ?? '/avatar.vrm',
};

export function getWebSocketUrl(): string {
  const sanitizedBaseUrl = config.apiBaseUrl.replace(/\/$/, '');
  const upgradedBaseUrl = sanitizedBaseUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');

  const tokenValue = (import.meta.env.VITE_API_TOKEN as string | undefined)?.trim();
  if (tokenValue) {
    return `${upgradedBaseUrl}/ws?token=${encodeURIComponent(tokenValue)}`;
  }

  return `${upgradedBaseUrl}/ws`;
}

export function getMotionWebSocketUrl(): string {
  return getWebSocketUrl();
}

export function getHealthUrl(): string {
  const sanitizedBaseUrl = config.apiBaseUrl.replace(/\/$/, '');
  return `${sanitizedBaseUrl}/health`;
}
