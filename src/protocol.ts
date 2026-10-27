export type MessageType =
  | 'hello'
  | 'accepted'
  | 'sentence'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'pong';

export type ConnectionState = 'connecting' | 'loading' | 'ready' | 'reconnecting' | 'failed';

export type ErrorCode =
  | 'invalid_json'
  | 'invalid_message'
  | 'unknown_type'
  | 'loading'
  | 'invalid_text'
  | 'text_too_long'
  | 'invalid_pace'
  | 'invalid_retrieval'
  | 'invalid_sample'
  | 'invalid_seed'
  | 'too_many_requests'
  | 'too_many_sentences'
  | 'busy'
  | 'generation_failed';

export const friendlyErrorText: Record<ErrorCode, string> = {
  invalid_json: 'The server sent invalid JSON.',
  invalid_message: 'The server sent an invalid message format.',
  unknown_type: 'The server sent an unknown message type.',
  loading: 'The model is still loading. Please try again in a moment.',
  invalid_text: 'The text to send is not valid.',
  text_too_long: 'The text is too long for the current model limit.',
  invalid_pace: 'The selected pace is invalid.',
  invalid_retrieval: 'The retrieval setting is invalid.',
  invalid_sample: 'The sample setting is invalid.',
  invalid_seed: 'The seed value is invalid.',
  too_many_requests: 'Too many requests are queued. Please try again in a moment.',
  too_many_sentences: 'Too many sentences were requested.',
  busy: 'The model is busy. Please try again in a moment.',
  generation_failed: 'The sign generation failed. Please try again.',
};

export interface ClientGenerateMessage {
  type: 'generate';
  id: string;
  text: string;
  pace: number;
}

export interface ClientCancelMessage {
  type: 'cancel';
  id: string;
}

export interface ClientPingMessage {
  type: 'ping';
  time: number;
}

export type ClientMessage = ClientGenerateMessage | ClientCancelMessage | ClientPingMessage;

export interface HelloMessage {
  type: 'hello';
  protocol_version: number;
  session_id: string;
  transport: string;
  ready: boolean;
  fps: number;
  frame_dimension: number;
  layout: Record<string, [number, number]>;
  limits: {
    maximum_text_characters: number;
    maximum_sentences_per_request: number;
    maximum_pending_requests: number;
    frames_per_message: number;
  };
}

export interface AcceptedMessage {
  type: 'accepted';
  id: string;
  request_index: number;
  sentences: string[];
  fps: number;
}

export interface SentenceMessage {
  type: 'sentence';
  id: string;
  request_index: number;
  sentence_index: number;
  sentence_count: number;
  text: string;
  frame_offset: number;
  frame_count: number;
  fps: number;
  seconds: number;
  generation_ms: number;
  cache_hit: boolean;
  keywords: string[];
}

export interface DoneMessage {
  type: 'done';
  id: string;
  request_index: number;
  total_frames: number;
  total_seconds: number;
  elapsed_ms: number;
}

export interface ErrorMessage {
  type: 'error';
  id: string;
  code: ErrorCode | string;
  message: string;
}

export interface CancelledMessage {
  type: 'cancelled';
  id: string;
  count: number;
}

export interface PongMessage {
  type: 'pong';
  time: number;
}

export type ServerMessage =
  | HelloMessage
  | AcceptedMessage
  | SentenceMessage
  | DoneMessage
  | ErrorMessage
  | CancelledMessage
  | PongMessage;

export interface BinaryMotionBlock {
  requestIndex: number;
  frameOffset: number;
  frameCount: number;
  frames: Float32Array;
}

export function isTextMessagePayload(payload: unknown): payload is ServerMessage {
  return !!payload && typeof payload === 'object' && 'type' in payload;
}

export function parseProtocolMessage(rawText: string): ServerMessage | null {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (!isTextMessagePayload(parsed)) {
      return null;
    }

    const message = parsed as ServerMessage;
    if (
      message.type === 'hello' ||
      message.type === 'accepted' ||
      message.type === 'sentence' ||
      message.type === 'done' ||
      message.type === 'error' ||
      message.type === 'cancelled' ||
      message.type === 'pong'
    ) {
      return message;
    }

    return null;
  } catch {
    return null;
  }
}

export function parseBinaryMotionBlock(buffer: ArrayBuffer): BinaryMotionBlock | null {
  if (buffer.byteLength < 12) {
    return null;
  }

  const view = new DataView(buffer);
  const requestIndex = view.getUint32(0, true);
  const frameOffset = view.getUint32(4, true);
  const frameCount = view.getUint32(8, true);

  const minimumLength = 12 + frameCount * 133 * 4;
  if (buffer.byteLength !== minimumLength) {
    return null;
  }

  const frameVector = new Float32Array(buffer.slice(12));
  const frames = new Float32Array(frameCount * 133);
  for (let index = 0; index < frames.length; index += 1) {
    frames[index] = frameVector[index];
  }

  return {
    requestIndex,
    frameOffset,
    frameCount,
    frames,
  };
}
