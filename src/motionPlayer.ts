import type { BinaryMotionBlock } from './protocol';

export type PlayerState = 'idle' | 'buffering' | 'playing' | 'holding';

interface TimelineRequest {
  requestIndex: number;
  fps: number;
  frames: Array<Float32Array | null>;
  startedAt: number | null;
  lastFrame: Float32Array | null;
  isDone: boolean;
  state: 'waiting' | 'playing' | 'holding' | 'done';
  transitionStartedAt: number | null;
}

function interpolateFrames(leftFrame: Float32Array, rightFrame: Float32Array, ratio: number): Float32Array {
  const interpolatedFrame = new Float32Array(leftFrame.length);
  for (let valueIndex = 0; valueIndex < leftFrame.length; valueIndex += 1) {
    interpolatedFrame[valueIndex] = leftFrame[valueIndex] + (rightFrame[valueIndex] - leftFrame[valueIndex]) * ratio;
  }
  return interpolatedFrame;
}

export class MotionPlayer {
  private readonly onFrame: (frame: Float32Array) => void;
  private readonly requests: TimelineRequest[] = [];
  private readonly requestIndexLookup: Map<number, number> = new Map();
  private readonly frameDimension: number;
  private readonly onStateChange: ((state: PlayerState) => void) | null;
  private animationFrameHandle: number | null = null;
  private latestFrame: Float32Array | null = null;
  private playerState: PlayerState = 'idle';

  public constructor(onFrame: (frame: Float32Array) => void, frameDimension: number, onStateChange: ((state: PlayerState) => void) | null = null) {
    this.onFrame = onFrame;
    this.frameDimension = frameDimension;
    this.onStateChange = onStateChange;
  }

  public registerRequest(requestIndex: number): void {
    if (this.requestIndexLookup.has(requestIndex)) {
      return;
    }

    const timeline: TimelineRequest = {
      requestIndex,
      fps: 20,
      frames: [],
      startedAt: null,
      lastFrame: null,
      isDone: false,
      state: 'waiting',
      transitionStartedAt: null,
    };

    this.requests.push(timeline);
    this.requestIndexLookup.set(requestIndex, this.requests.length - 1);
    this.updateState();
  }

  public addBlock(block: BinaryMotionBlock): void {
    const timeline = this.ensureTimeline(block.requestIndex);
    for (let frameIndex = 0; frameIndex < block.frameCount; frameIndex += 1) {
      const absoluteFrameIndex = block.frameOffset + frameIndex;
      while (timeline.frames.length <= absoluteFrameIndex) {
        timeline.frames.push(null);
      }

      const sourceOffset = frameIndex * this.frameDimension;
      const frame = new Float32Array(this.frameDimension);
      for (let valueIndex = 0; valueIndex < this.frameDimension; valueIndex += 1) {
        frame[valueIndex] = block.frames[sourceOffset + valueIndex] ?? 0;
      }

      timeline.frames[absoluteFrameIndex] = frame;
      timeline.lastFrame = frame;
    }

    this.updateState();
    if (this.animationFrameHandle === null) {
      this.startLoop();
    }
  }

  public markRequestComplete(requestIndex: number): void {
    const timeline = this.getTimeline(requestIndex);
    if (timeline) {
      timeline.isDone = true;
      timeline.state = 'done';
    }
    this.updateState();
  }

  public clearAll(): void {
    this.requests.length = 0;
    this.requestIndexLookup.clear();
    this.latestFrame = null;
    this.playerState = 'idle';
    if (this.animationFrameHandle !== null) {
      cancelAnimationFrame(this.animationFrameHandle);
      this.animationFrameHandle = null;
    }
    this.emitState();
  }

  public getLatestFrame(): Float32Array | null {
    return this.latestFrame;
  }

  public getBufferedFrames(): number {
    return this.requests.reduce((total, request) => total + request.frames.filter((frame) => frame !== null).length, 0);
  }

  public getState(): PlayerState {
    return this.playerState;
  }

  private ensureTimeline(requestIndex: number): TimelineRequest {
    const existingIndex = this.requestIndexLookup.get(requestIndex);
    if (existingIndex !== undefined) {
      return this.requests[existingIndex];
    }

    const timeline: TimelineRequest = {
      requestIndex,
      fps: 20,
      frames: [],
      startedAt: null,
      lastFrame: null,
      isDone: false,
      state: 'waiting',
      transitionStartedAt: null,
    };

    this.requests.push(timeline);
    this.requestIndexLookup.set(requestIndex, this.requests.length - 1);
    return timeline;
  }

  private getTimeline(requestIndex: number): TimelineRequest | null {
    const timelineIndex = this.requestIndexLookup.get(requestIndex);
    if (timelineIndex === undefined) {
      return null;
    }
    return this.requests[timelineIndex] ?? null;
  }

  private getReceivedFrames(timeline: TimelineRequest): Float32Array[] {
    return timeline.frames.filter((frame): frame is Float32Array => frame !== null);
  }

  private getCurrentFrameForTimeline(timeline: TimelineRequest, now: number): Float32Array | null {
    const receivedFrames = this.getReceivedFrames(timeline);
    if (receivedFrames.length === 0) {
      return null;
    }

    if (timeline.startedAt === null) {
      if (receivedFrames.length >= 6 || timeline.isDone) {
        timeline.startedAt = now;
        timeline.state = 'playing';
      } else {
        return receivedFrames[0];
      }
    }

    if (timeline.startedAt === null) {
      return receivedFrames[0];
    }

    const elapsedMilliseconds = now - timeline.startedAt;
    const framePosition = (elapsedMilliseconds / 1000) * timeline.fps;
    const lastFrameIndex = receivedFrames.length - 1;
    if (framePosition >= lastFrameIndex) {
      if (!timeline.isDone) {
        timeline.state = 'holding';
        timeline.startedAt = now - (lastFrameIndex / timeline.fps) * 1000;
      } else {
        timeline.state = 'done';
      }
      return receivedFrames[lastFrameIndex];
    }

    timeline.state = 'playing';
    const lowerIndex = Math.floor(framePosition);
    const upperIndex = Math.min(lastFrameIndex, lowerIndex + 1);
    const lowerFrame = receivedFrames[lowerIndex] ?? receivedFrames[0];
    const upperFrame = receivedFrames[upperIndex] ?? receivedFrames[lastFrameIndex];
    if (!lowerFrame || !upperFrame) {
      return receivedFrames[0] ?? null;
    }

    const interpolationRatio = framePosition - lowerIndex;
    return interpolateFrames(lowerFrame, upperFrame, interpolationRatio);
  }

  private getActiveTimeline(): TimelineRequest | null {
    for (const timeline of this.requests) {
      if (this.getReceivedFrames(timeline).length > 0) {
        return timeline;
      }
    }
    return null;
  }

  private getCurrentFramePosition(timeline: TimelineRequest, now: number): number {
    const receivedFrames = this.getReceivedFrames(timeline);
    if (receivedFrames.length === 0 || timeline.startedAt === null) {
      return 0;
    }

    return (now - timeline.startedAt) / 1000 * timeline.fps;
  }

  private updateState(): void {
    const activeTimeline = this.getActiveTimeline();
    if (!activeTimeline) {
      this.playerState = 'idle';
      this.emitState();
      return;
    }

    const receivedFrames = this.getReceivedFrames(activeTimeline);
    if (receivedFrames.length < 6 && activeTimeline.startedAt === null && !activeTimeline.isDone) {
      this.playerState = 'buffering';
      this.emitState();
      return;
    }

    this.playerState = activeTimeline.state === 'holding' ? 'holding' : 'playing';
    this.emitState();
  }

  private emitState(): void {
    if (this.onStateChange) {
      this.onStateChange(this.playerState);
    }
  }

  private startLoop(): void {
    const animate = () => {
      const now = performance.now();

      if (this.requests.length === 0) {
        this.playerState = 'idle';
        this.emitState();
        this.animationFrameHandle = null;
        return;
      }

      const currentTimeline = this.getActiveTimeline();
      if (!currentTimeline) {
        this.playerState = 'idle';
        this.emitState();
        this.animationFrameHandle = null;
        return;
      }

      const currentFrames = this.getReceivedFrames(currentTimeline);
      if (currentFrames.length === 0) {
        this.requests.shift();
        this.requestIndexLookup.delete(currentTimeline.requestIndex);
        this.updateState();
        this.animationFrameHandle = requestAnimationFrame(animate);
        return;
      }

      const nextTimeline = this.requests[1] ?? undefined;
      if (currentTimeline.isDone) {
        const lastFrame = currentFrames[currentFrames.length - 1] ?? null;
        const currentFrame = this.getCurrentFrameForTimeline(currentTimeline, now) ?? lastFrame;
        if (currentFrame) {
          this.latestFrame = new Float32Array(currentFrame);
          this.onFrame(new Float32Array(currentFrame));
        }

        const completionPosition = this.getCurrentFramePosition(currentTimeline, now);
        if (completionPosition >= currentFrames.length - 1) {
          if (nextTimeline) {
            if (currentTimeline.transitionStartedAt === null) {
              currentTimeline.transitionStartedAt = now;
            }

            const transitionRatio = Math.min(1, (now - currentTimeline.transitionStartedAt) / 300);
            const nextFrame = this.getReceivedFrames(nextTimeline)[0] ?? lastFrame;
            if (lastFrame && nextFrame) {
              const blendedFrame = interpolateFrames(lastFrame, nextFrame, transitionRatio);
              this.latestFrame = new Float32Array(blendedFrame);
              this.onFrame(new Float32Array(blendedFrame));
            }

            if (transitionRatio >= 1) {
              this.requests.shift();
              this.requestIndexLookup.delete(currentTimeline.requestIndex);
              currentTimeline.transitionStartedAt = null;
            }
          } else {
            this.requests.shift();
            this.requestIndexLookup.delete(currentTimeline.requestIndex);
          }
        }
      } else {
        const activeFrame = this.getCurrentFrameForTimeline(currentTimeline, now);
        if (activeFrame) {
          this.latestFrame = new Float32Array(activeFrame);
          this.onFrame(new Float32Array(activeFrame));
        }
      }

      this.updateState();
      this.animationFrameHandle = requestAnimationFrame(animate);
    };

    this.animationFrameHandle = requestAnimationFrame(animate);
  }
}
