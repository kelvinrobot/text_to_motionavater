export interface AvatarDriver {
  applyFrame: (frame: Float32Array) => void;
  reset: () => void;
}

export class DebugAvatarDriver implements AvatarDriver {
  private rootElement: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private width: number;
  private height: number;

  public constructor() {
    this.rootElement = document.createElement('div');
    this.rootElement.className = 'debug-avatar-container';

    this.canvas = document.createElement('canvas');
    this.canvas.width = 520;
    this.canvas.height = 260;
    this.canvas.className = 'debug-avatar-canvas';

    this.context = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    this.width = this.canvas.width;
    this.height = this.canvas.height;

    this.rootElement.appendChild(this.canvas);
  }

  public mount(target: HTMLElement): void {
    target.innerHTML = '';
    target.appendChild(this.rootElement);
    this.renderFrame(new Float32Array(133));
  }

  public attach(target: HTMLCanvasElement): void {
    target.width = 520;
    target.height = 260;
    this.canvas = target;
    this.context = target.getContext('2d') as CanvasRenderingContext2D;
    this.width = target.width;
    this.height = target.height;
    this.renderFrame(new Float32Array(133));
  }

  public detach(): void {
    this.context.clearRect(0, 0, this.width, this.height);
  }

  public applyFrame(frame: Float32Array): void {
    this.renderFrame(frame);
  }

  public reset(): void {
    this.renderFrame(new Float32Array(133));
  }

  public dispose(): void {
    this.context.clearRect(0, 0, this.width, this.height);
  }

  private renderFrame(frame: Float32Array): void {
    const context = this.context;
    const width = this.width;
    const height = this.height;

    context.clearRect(0, 0, width, height);
    context.fillStyle = '#0d1117';
    context.fillRect(0, 0, width, height);

    const groups = [
      { name: 'upper_body', start: 0, end: 30 },
      { name: 'left_hand', start: 30, end: 75 },
      { name: 'right_hand', start: 75, end: 120 },
      { name: 'jaw', start: 120, end: 123 },
      { name: 'expression', start: 123, end: 133 },
    ];

    const groupWidth = width / groups.length;

    groups.forEach((group, groupIndex) => {
      const x = groupIndex * groupWidth + 18;
      const barWidth = Math.max(28, groupWidth - 36);
      const sliceCount = Math.max(1, group.end - group.start);

      context.fillStyle = '#f5f5f5';
      context.font = '12px sans-serif';
      context.fillText(group.name, x, 18);

      for (let index = group.start; index < group.end; index += 1) {
        const value = frame[index] ?? 0;
        const percent = Math.min(1, Math.max(0, Math.abs(value) / 2.5));
        const barHeight = 180 * percent;
        const barX = x + ((index - group.start) / sliceCount) * (barWidth - 6);
        const barY = height - 20 - barHeight;

        context.fillStyle = value >= 0 ? '#60a5fa' : '#f59e0b';
        context.fillRect(barX, barY, 4, barHeight);
      }
    });
  }
}
