import type { BinaryMotionBlock } from './protocol';

interface BufferedRequest {
  requestIndex: number;
  fps: number;
  frames: Float32Array[];
  startedAt: number;
  lastFrame: Float32Array | null;
}

export class MotionPlayer {
  private readonly onFrame: (frame: Float32Array) => void;
  private readonly requests: BufferedRequest[] = [];
  private animationFrameHandle: number | null = null;
  private latestFrame: Float32Array | null = null;
  private frameDimension: number;

  public constructor(onFrame: (frame: Float32Array) => void, frameDimension: number) {
    this.onFrame = onFrame;
    this.frameDimension = frameDimension;
  }

  public setFrameDimension(frameDimension: number): void {
    this.frameDimension = frameDimension;
  }

  public addBlock(block: BinaryMotionBlock): void {
    const request = this.requests.find((entry) => entry.requestIndex === block.requestIndex);
    const nextFrames: Float32Array[] = [];

    for (let frameIndex = 0; frameIndex < block.frameCount; frameIndex += 1) {
      const start = frameIndex * this.frameDimension;
      const end = start + this.frameDimension;
      nextFrames.push(new Float32Array(block.frames.slice(start, end)));
    }

    if (request) {
      request.frames.push(...nextFrames);
      request.lastFrame = nextFrames[nextFrames.length - 1] ?? request.lastFrame;
    } else {
      this.requests.push({
        requestIndex: block.requestIndex,
        fps: block.frameCount > 0 ? Math.max(1, Math.round(20)) : 20,
        frames: nextFrames,
        startedAt: performance.now(),
        lastFrame: nextFrames[nextFrames.length - 1] ?? null,
      });
    }

    this.start();
  }

  public clearAll(): void {
    this.requests.length = 0;
    this.latestFrame = null;
    if (this.animationFrameHandle !== null) {
      cancelAnimationFrame(this.animationFrameHandle);
      this.animationFrameHandle = null;
    }
  }

  public cancelRequest(requestIndex: number): void {
    const requestIndexToRemove = this.requests.findIndex((entry) => entry.requestIndex === requestIndex);
    if (requestIndexToRemove >= 0) {
      this.requests.splice(requestIndexToRemove, 1);
    }
  }

  public getLatestFrame(): Float32Array | null {
    return this.latestFrame;
  }

  private start(): void {
    if (this.animationFrameHandle !== null) {
      return;
    }

    const animate = () => {
      if (this.requests.length === 0) {
        this.animationFrameHandle = null;
        return;
      }

      const request = this.requests[0];
      const elapsedMilliseconds = performance.now() - request.startedAt;
      const frameStepMilliseconds = 1000 / request.fps;

      if (request.frames.length === 0) {
        this.requests.shift();
        this.animationFrameHandle = requestAnimationFrame(animate);
        return;
      }

      const frameIndex = Math.min(
        request.frames.length - 1,
        Math.max(0, Math.floor(elapsedMilliseconds / frameStepMilliseconds)),
      );

      const nextFrame = request.frames[frameIndex] ?? request.lastFrame;
      if (nextFrame) {
        this.latestFrame = new Float32Array(nextFrame);
        this.onFrame(this.latestFrame);
      }

      if (frameIndex >= request.frames.length - 1) {
        request.lastFrame = this.latestFrame;
        this.requests.shift();
      }

      this.animationFrameHandle = requestAnimationFrame(animate);
    };

    this.animationFrameHandle = requestAnimationFrame(animate);
  }
}
