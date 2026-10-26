import { config, getWebSocketUrl } from './config';
import { parseBinaryMotionBlock, parseProtocolMessage, type BinaryMotionBlock, type ConnectionState, type ServerMessage } from './protocol';

export interface MotionRequestLogEntry {
  id: string;
  sentences: string[];
  firstMotionDelay: number;
  totalTime: number;
  cacheHit: boolean;
}

export interface MotionTransport {
  send: (message: string) => void;
  close: () => void;
  onMessage: (handler: (event: MessageEvent) => void) => () => void;
  onOpen: (handler: () => void) => () => void;
  onClose: (handler: (event: CloseEvent) => void) => () => void;
  onError: (handler: (event: Event) => void) => () => void;
}

export class WebSocketMotionTransport implements MotionTransport {
  private socket: WebSocket | null;

  public constructor() {
    this.socket = null;
  }

  public send(message: string): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(message);
    }
  }

  public close(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  public onMessage(handler: (event: MessageEvent) => void): () => void {
    const socket = this.connect();
    socket.addEventListener('message', handler);
    return () => {
      socket.removeEventListener('message', handler);
    };
  }

  public onOpen(handler: () => void): () => void {
    const socket = this.connect();
    const handleOpen = () => handler();
    socket.addEventListener('open', handleOpen);
    return () => {
      socket.removeEventListener('open', handleOpen);
    };
  }

  public onClose(handler: (event: CloseEvent) => void): () => void {
    const socket = this.connect();
    const handleClose = (event: CloseEvent) => handler(event);
    socket.addEventListener('close', handleClose);
    return () => {
      socket.removeEventListener('close', handleClose);
    };
  }

  public onError(handler: (event: Event) => void): () => void {
    const socket = this.connect();
    const handleError = (event: Event) => handler(event);
    socket.addEventListener('error', handleError);
    return () => {
      socket.removeEventListener('error', handleError);
    };
  }

  private connect(): WebSocket {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      return this.socket;
    }

    const socket = new WebSocket(getWebSocketUrl());
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    return socket;
  }
}

export class MotionClient {
  private transport: MotionTransport;
  private socketClosed: boolean;
  private pingTimer: number | null;
  private reconnectTimer: number | null;
  private reconnectDelayMs: number;
  private stateListeners: Array<(state: ConnectionState) => void>;
  private helloListeners: Array<(message: { session_id: string; limits: { maximum_text_characters: number } }) => void>;
  private errorListeners: Array<(message: string) => void>;
  private motionFrameListeners: Array<(frame: Float32Array) => void>;
  private requestLogListeners: Array<(log: MotionRequestLogEntry) => void>;
  private requestIndexCounter: number;
  private activeRequestId: string | null;
  private requestMap: Map<number, { id: string; startedAt: number; sentences: string[]; firstMotionAt: number | null; totalTime: number; cacheHit: boolean; }>;
  private transportUnsubscribers: Array<() => void>;

  public constructor(transport: MotionTransport = new WebSocketMotionTransport()) {
    this.transport = transport;
    this.socketClosed = false;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelayMs = config.reconnectBackoffMs;
    this.stateListeners = [];
    this.helloListeners = [];
    this.errorListeners = [];
    this.motionFrameListeners = [];
    this.requestLogListeners = [];
    this.requestIndexCounter = 0;
    this.activeRequestId = null;
    this.requestMap = new Map();
    this.transportUnsubscribers = [];
  }

  public onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.push(listener);
    return () => {
      this.stateListeners = this.stateListeners.filter((currentListener) => currentListener !== listener);
    };
  }

  public onHello(listener: (message: { session_id: string; limits: { maximum_text_characters: number } }) => void): () => void {
    this.helloListeners.push(listener);
    return () => {
      this.helloListeners = this.helloListeners.filter((currentListener) => currentListener !== listener);
    };
  }

  public onError(listener: (message: string) => void): () => void {
    this.errorListeners.push(listener);
    return () => {
      this.errorListeners = this.errorListeners.filter((currentListener) => currentListener !== listener);
    };
  }

  public onMotionFrame(listener: (frame: Float32Array) => void): () => void {
    this.motionFrameListeners.push(listener);
    return () => {
      this.motionFrameListeners = this.motionFrameListeners.filter((currentListener) => currentListener !== listener);
    };
  }

  public onRequestLog(listener: (log: MotionRequestLogEntry) => void): () => void {
    this.requestLogListeners.push(listener);
    return () => {
      this.requestLogListeners = this.requestLogListeners.filter((currentListener) => currentListener !== listener);
    };
  }

  public connect(): void {
    if (this.socketClosed) {
      return;
    }

    this.setState('connecting');
    const unsubscribeOpen = this.transport.onOpen(() => {
      this.setState('loading');
      this.startPingLoop();
    });

    const unsubscribeClose = this.transport.onClose(() => {
      this.stopPingLoop();
      if (!this.socketClosed) {
        this.setState('reconnecting');
        this.scheduleReconnect();
      }
    });

    const unsubscribeError = this.transport.onError(() => {
      this.setState('failed');
      this.emitError('Connection failed');
    });

    const unsubscribeMessage = this.transport.onMessage((event) => {
      this.handleIncomingMessage(event);
    });

    this.transportUnsubscribers = [unsubscribeOpen, unsubscribeClose, unsubscribeError, unsubscribeMessage];
  }

  public close(): void {
    this.socketClosed = true;
    this.stopPingLoop();
    this.cancelReconnect();
    this.transportUnsubscribers.forEach((unsubscribe) => unsubscribe());
    this.transportUnsubscribers = [];
    this.transport.close();
    this.stateListeners = [];
    this.helloListeners = [];
    this.errorListeners = [];
    this.motionFrameListeners = [];
    this.requestLogListeners = [];
  }

  public sendGenerate(text: string, pace: number): void {
    const payload = {
      type: 'generate',
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text,
      pace,
    };

    this.activeRequestId = payload.id;
    this.transport.send(JSON.stringify(payload));
  }

  public cancelActiveRequest(): void {
    if (!this.activeRequestId) {
      return;
    }

    this.transport.send(JSON.stringify({ type: 'cancel', id: this.activeRequestId }));
    this.activeRequestId = null;
  }

  private handleIncomingMessage(event: MessageEvent): void {
    if (typeof event.data === 'string') {
      const message = parseProtocolMessage(event.data);
      if (!message) {
        this.emitError('Received an invalid message from the server');
        return;
      }

      this.handleTextMessage(message);
      return;
    }

    if (event.data instanceof ArrayBuffer) {
      const binaryBlock = parseBinaryMotionBlock(event.data as ArrayBuffer);
      if (!binaryBlock) {
        return;
      }

      if (this.activeRequestId && binaryBlock.requestIndex === this.requestIndexCounter) {
        this.handleMotionBlock(binaryBlock);
      }
    }
  }

  private handleTextMessage(message: ServerMessage): void {
    if (message.type === 'hello') {
      this.reconnectDelayMs = config.reconnectBackoffMs;
      this.setState(message.ready ? 'ready' : 'loading');
      this.helloListeners.forEach((listener) => listener({
        session_id: message.session_id,
        limits: {
          maximum_text_characters: message.limits.maximum_text_characters,
        },
      }));
      return;
    }

    if (message.type === 'accepted') {
      this.requestIndexCounter = message.request_index;
      this.requestMap.set(message.request_index, {
        id: message.id,
        startedAt: Date.now(),
        sentences: message.sentences,
        firstMotionAt: null,
        totalTime: 0,
        cacheHit: false,
      });
      return;
    }

    if (message.type === 'sentence') {
      const requestState = this.requestMap.get(message.request_index);
      if (requestState) {
        requestState.sentences.push(message.text);
        if (message.cache_hit) {
          requestState.cacheHit = true;
        }
      }
      return;
    }

    if (message.type === 'done') {
      const requestState = this.requestMap.get(message.request_index);
      if (requestState) {
        requestState.totalTime = message.elapsed_ms;
        this.emitRequestLog({
          id: requestState.id,
          sentences: requestState.sentences,
          firstMotionDelay: requestState.firstMotionAt ? Math.max(0, requestState.firstMotionAt - requestState.startedAt) : 0,
          totalTime: requestState.totalTime,
          cacheHit: requestState.cacheHit,
        });
      }
      return;
    }

    if (message.type === 'error') {
      this.emitError(message.message || message.code);
      return;
    }

    if (message.type === 'pong') {
      return;
    }
  }

  private handleMotionBlock(binaryBlock: BinaryMotionBlock): void {
    const requestState = this.requestMap.get(binaryBlock.requestIndex);
    if (!requestState) {
      return;
    }

    if (requestState.firstMotionAt === null) {
      requestState.firstMotionAt = Date.now();
    }

    const frameBuffer = new Float32Array(binaryBlock.frames.length);
    frameBuffer.set(binaryBlock.frames);
    this.motionFrameListeners.forEach((listener) => listener(frameBuffer));
  }

  private setState(nextState: ConnectionState): void {
    this.stateListeners.forEach((listener) => listener(nextState));
  }

  private emitError(message: string): void {
    this.errorListeners.forEach((listener) => listener(message));
  }

  private emitRequestLog(log: MotionRequestLogEntry): void {
    this.requestLogListeners.forEach((listener) => listener(log));
  }

  private startPingLoop(): void {
    if (this.pingTimer !== null) {
      return;
    }

    this.pingTimer = window.setInterval(() => {
      this.transport.send(JSON.stringify({ type: 'ping', time: Date.now() }));
    }, config.pingIntervalMs);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.cancelReconnect();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.socketClosed) {
        this.connect();
      }
    }, this.reconnectDelayMs);

    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, config.maxReconnectBackoffMs);
  }
}
