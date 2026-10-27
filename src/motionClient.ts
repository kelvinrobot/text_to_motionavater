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
  private readonly transport: MotionTransport;
  private socketClosed: boolean;
  private pingTimer: number | null;
  private reconnectTimer: number | null;
  private reconnectDelayMs: number;
  private readonly stateListeners: Array<(state: ConnectionState) => void>;
  private readonly helloListeners: Array<(message: { session_id: string; limits: { maximum_text_characters: number; maximum_pending_requests: number; }; ready: boolean; }) => void>;
  private readonly errorListeners: Array<(message: string) => void>;
  private readonly motionListeners: Array<(block: BinaryMotionBlock) => void>;
  private readonly serverMessageListeners: Array<(message: ServerMessage) => void>;
  private readonly requestLogListeners: Array<(log: MotionRequestLogEntry) => void>;
  private readonly requestIndexById: Map<string, number>;
  private readonly requestIdByIndex: Map<number, string>;
  private readonly requestStateByIndex: Map<number, { id: string; startedAt: number; sentences: string[]; firstMotionAt: number | null; totalTime: number; cacheHit: boolean; }>; 
  private readonly transportUnsubscribers: Array<() => void>;
  private helloState: { session_id: string; ready: boolean; limits: { maximum_text_characters: number; maximum_pending_requests: number; }; } | null;
  private nextRequestNumber: number;

  public constructor(transport: MotionTransport = new WebSocketMotionTransport()) {
    this.transport = transport;
    this.socketClosed = false;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelayMs = config.reconnectBackoffMs;
    this.stateListeners = [];
    this.helloListeners = [];
    this.errorListeners = [];
    this.motionListeners = [];
    this.serverMessageListeners = [];
    this.requestLogListeners = [];
    this.requestIndexById = new Map();
    this.requestIdByIndex = new Map();
    this.requestStateByIndex = new Map();
    this.transportUnsubscribers = [];
    this.helloState = null;
    this.nextRequestNumber = 0;
  }

  public onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.push(listener);
    return () => {
      this.stateListeners.splice(this.stateListeners.indexOf(listener), 1);
    };
  }

  public onHello(listener: (message: { session_id: string; limits: { maximum_text_characters: number; maximum_pending_requests: number; }; ready: boolean; }) => void): () => void {
    this.helloListeners.push(listener);
    return () => {
      this.helloListeners.splice(this.helloListeners.indexOf(listener), 1);
    };
  }

  public onError(listener: (message: string) => void): () => void {
    this.errorListeners.push(listener);
    return () => {
      this.errorListeners.splice(this.errorListeners.indexOf(listener), 1);
    };
  }

  public onMotionBlock(listener: (block: BinaryMotionBlock) => void): () => void {
    this.motionListeners.push(listener);
    return () => {
      this.motionListeners.splice(this.motionListeners.indexOf(listener), 1);
    };
  }

  public onMotionFrame(listener: (frame: Float32Array) => void): () => void {
    return this.onMotionBlock((block) => {
      listener(new Float32Array(block.frames));
    });
  }

  public onServerMessage(listener: (message: ServerMessage) => void): () => void {
    this.serverMessageListeners.push(listener);
    return () => {
      this.serverMessageListeners.splice(this.serverMessageListeners.indexOf(listener), 1);
    };
  }

  public onRequestLog(listener: (log: MotionRequestLogEntry) => void): () => void {
    this.requestLogListeners.push(listener);
    return () => {
      this.requestLogListeners.splice(this.requestLogListeners.indexOf(listener), 1);
    };
  }

  public connect(): void {
    if (this.socketClosed) {
      return;
    }

    console.info('[sign] socket open attempted');
    this.setState('connecting');
    const unsubscribeOpen = this.transport.onOpen(() => {
      console.info('[sign] socket open');
      this.setState('loading');
      this.startPingLoop();
    });

    const unsubscribeClose = this.transport.onClose((event) => {
      console.info('[sign] socket close', event.code);
      this.stopPingLoop();
      if (!this.socketClosed) {
        this.setState('reconnecting');
        this.scheduleReconnect();
      }
    });

    const unsubscribeError = this.transport.onError((event) => {
      console.error('[sign] socket error', event);
      this.setState('failed');
      this.emitError('Connection failed');
    });

    const unsubscribeMessage = this.transport.onMessage((event) => {
      if (typeof event.data === 'string') {
        const message = parseProtocolMessage(event.data);
        if (!message) {
          console.warn('[sign] invalid text message', event.data);
          this.emitError('Received an invalid message from the server');
          return;
        }

        console.info('[sign] message', message.type);
        this.onTextMessage(message);
        return;
      }

      if (event.data instanceof ArrayBuffer) {
        const binaryBlock = parseBinaryMotionBlock(event.data);
        if (!binaryBlock) {
          console.warn('[sign] invalid binary block', event.data.byteLength);
          return;
        }

        console.info('[sign] binary motion block', binaryBlock.requestIndex, binaryBlock.frameCount);
        this.onBinaryBlock(binaryBlock);
      }
    });

    this.transportUnsubscribers.push(unsubscribeOpen, unsubscribeClose, unsubscribeError, unsubscribeMessage);
  }

  public close(): void {
    this.socketClosed = true;
    this.stopPingLoop();
    this.cancelReconnect();
    for (const unsubscribe of this.transportUnsubscribers) {
      unsubscribe();
    }
    this.transportUnsubscribers.length = 0;
    this.transport.close();
    this.stateListeners.length = 0;
    this.helloListeners.length = 0;
    this.errorListeners.length = 0;
    this.motionListeners.length = 0;
    this.serverMessageListeners.length = 0;
    this.requestLogListeners.length = 0;
  }

  public sendGenerate(text: string, pace: number): string {
    this.nextRequestNumber += 1;
    const requestId = `request-${this.nextRequestNumber}-${Math.random().toString(16).slice(2)}`;
    const payload = {
      type: 'generate',
      id: requestId,
      text,
      pace,
    };

    this.transport.send(JSON.stringify(payload));
    return requestId;
  }

  public cancelRequestById(requestId: string): void {
    if (!requestId) {
      return;
    }

    this.transport.send(JSON.stringify({ type: 'cancel', id: requestId }));
  }

  public cancelActiveRequest(): void {
    const requestId = this.requestIdByIndex.size > 0 ? Array.from(this.requestIdByIndex.values()).at(-1) ?? null : null;
    if (requestId) {
      this.cancelRequestById(requestId);
    }
  }

  public getHelloState(): { session_id: string; ready: boolean; limits: { maximum_text_characters: number; maximum_pending_requests: number; }; } | null {
    return this.helloState;
  }

  private onTextMessage(message: ServerMessage): void {
    this.serverMessageListeners.forEach((listener) => listener(message));

    if (message.type === 'hello') {
      this.helloState = {
        session_id: message.session_id,
        ready: message.ready,
        limits: {
          maximum_text_characters: message.limits.maximum_text_characters,
          maximum_pending_requests: message.limits.maximum_pending_requests,
        },
      };

      this.reconnectDelayMs = config.reconnectBackoffMs;
      this.setState(message.ready ? 'ready' : 'loading');
      this.helloListeners.forEach((listener) => listener(this.helloState));
      return;
    }

    if (message.type === 'accepted') {
      this.requestIdByIndex.set(message.request_index, message.id);
      this.requestIndexById.set(message.id, message.request_index);
      this.requestStateByIndex.set(message.request_index, {
        id: message.id,
        startedAt: Date.now(),
        sentences: [...message.sentences],
        firstMotionAt: null,
        totalTime: 0,
        cacheHit: false,
      });
      return;
    }

    if (message.type === 'sentence') {
      const requestState = this.requestStateByIndex.get(message.request_index);
      if (requestState) {
        requestState.sentences.push(message.text);
        if (message.cache_hit) {
          requestState.cacheHit = true;
        }
      }
      return;
    }

    if (message.type === 'done') {
      const requestState = this.requestStateByIndex.get(message.request_index);
      if (requestState) {
        requestState.totalTime = message.elapsed_ms;
        this.emitRequestLog({
          id: requestState.id,
          sentences: requestState.sentences,
          firstMotionDelay: requestState.firstMotionAt === null ? 0 : requestState.firstMotionAt - requestState.startedAt,
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

    if (message.type === 'cancelled') {
      return;
    }

    if (message.type === 'pong') {
      return;
    }
  }

  private onBinaryBlock(block: BinaryMotionBlock): void {
    const requestState = this.requestStateByIndex.get(block.requestIndex);
    if (requestState) {
      if (requestState.firstMotionAt === null) {
        requestState.firstMotionAt = Date.now();
      }
    }

    this.motionListeners.forEach((listener) => listener(block));
  }

  private setState(nextState: ConnectionState): void {
    for (const listener of this.stateListeners) {
      listener(nextState);
    }
  }

  private emitError(message: string): void {
    for (const listener of this.errorListeners) {
      listener(message);
    }
  }

  private emitRequestLog(log: MotionRequestLogEntry): void {
    for (const listener of this.requestLogListeners) {
      listener(log);
    }
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
