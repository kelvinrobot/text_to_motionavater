import { config, getHealthUrl, smplxMapping } from './config';
import { MotionClient } from './motionClient';
import { MotionPlayer } from './motionPlayer';
import { friendlyErrorText, type ErrorCode } from './protocol';
import { isSpeechRecognitionAvailable, SpeechToTextController } from './speech';
import { DebugAvatarDriver } from './avatarDriver';
import { VrmAvatarDriver, switchesToReadoutText } from './vrmAvatarDriver';

const baseCharacterLimit = 400;
const modelLoadingMessage = 'Model is loading, this can take a few minutes';
const connectionStates = {
  connecting: 'Connecting',
  loading: 'Model loading',
  ready: 'Ready',
  reconnecting: 'Reconnecting',
  failed: 'Disconnected',
} as const;

const bodyPairStartColumns = [3, 12, 18, 24] as const;
const firstHandBlockStartColumn = 30;
const secondHandBlockStartColumn = 75;

export interface ApplicationSettings {
  displayMode: 'mean' | 'live';
  swapBodySides: boolean;
  swapHands: boolean;
  negateFirstHand: boolean;
  negateSecondHand: boolean;
  negateFirstBodyJoint: boolean;
  negateSecondBodyJoint: boolean;
  fingerRotationScale: number;
  autoSendAfterSpeaking: boolean;
  pace: number;
}

export class ApplicationController {
  private readonly elements: {
    connectionBadge: HTMLElement;
    sessionId: HTMLElement;
    loadingText: HTMLElement;
    meanPoseButton: HTMLButtonElement;
    liveMotionButton: HTMLButtonElement;
    avatarContainer: HTMLElement;
    swapBodySides: HTMLInputElement;
    swapHands: HTMLInputElement;
    negateFirstHand: HTMLInputElement;
    negateSecondHand: HTMLInputElement;
    negateFirstBodyJoint: HTMLInputElement;
    negateSecondBodyJoint: HTMLInputElement;
    fingerScaleSlider: HTMLInputElement;
    fingerScaleValue: HTMLElement;
    settingsReadout: HTMLElement;
    microphoneButton: HTMLButtonElement;
    autoSendCheckbox: HTMLInputElement;
    transcriptBox: HTMLElement;
    textBox: HTMLTextAreaElement;
    paceSlider: HTMLInputElement;
    paceValue: HTMLElement;
    sendButton: HTMLButtonElement;
    cancelButton: HTMLButtonElement;
    characterCounter: HTMLElement;
    statusText: HTMLElement;
    requestLogList: HTMLUListElement;
    faceNote: HTMLElement;
    browserNote: HTMLElement;
  };

  private readonly settings: ApplicationSettings = {
    displayMode: 'mean',
    swapBodySides: false,
    swapHands: false,
    negateFirstHand: false,
    negateSecondHand: false,
    negateFirstBodyJoint: false,
    negateSecondBodyJoint: false,
    fingerRotationScale: 1,
    autoSendAfterSpeaking: true,
    pace: config.paceDefault,
  };

  private motionClient: MotionClient | null = null;
  private motionPlayer: MotionPlayer | null = null;
  private avatarDriver: VrmAvatarDriver | null = null;
  private speechController: SpeechToTextController | null = null;
  private debugAvatarDriver: DebugAvatarDriver | null = null;
  private latestLiveFrame: Float32Array | null = null;
  private latestSessionId = '';
  private maxTextCharacters = baseCharacterLimit;
  private healthTimer: number | null = null;
  private connectionState: 'connecting' | 'loading' | 'ready' | 'reconnecting' | 'failed' = 'connecting';
  private isDisposed = false;
  private isStarted = false;
  private logEntries: Array<{ id: string; text: string; sentAt: number; totalFrames: number; elapsedMs: number | null; statusText: string; failed: boolean; resendable: boolean; }> = [];
  private pendingRequestIds: Set<string> = new Set();

  public constructor() {
    const elements = this.getElements();
    this.elements = elements;
    this.bindControls();
    this.renderReadout();
    this.updateCharacterCounter();
    this.syncControlValues();
  }

  public start(): void {
    if (this.isStarted) {
      return;
    }

    this.isStarted = true;
    this.startAvatar();
    this.startSpeech();
    this.startMotionClient();
    this.updateStatusText('Connecting to server');
  }

  public dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    this.stopHealthPolling();
    this.motionClient?.close();
    this.motionClient = null;
    this.motionPlayer?.clearAll();
    this.motionPlayer = null;
    this.avatarDriver?.dispose();
    this.avatarDriver = null;
    this.debugAvatarDriver?.dispose();
    this.debugAvatarDriver = null;
    this.speechController?.stop();
    this.speechController = null;
    this.latestLiveFrame = null;
    this.pendingRequestIds.clear();
    this.logEntries = [];
    this.renderRequestLog();
  }

  private getElements() {
    const connectionBadge = document.getElementById('connection-badge');
    const sessionId = document.getElementById('session-id');
    const loadingText = document.getElementById('loading-text');
    const meanPoseButton = document.getElementById('mean-pose-button') as HTMLButtonElement | null;
    const liveMotionButton = document.getElementById('live-motion-button') as HTMLButtonElement | null;
    const avatarContainer = document.getElementById('avatar-container');
    const swapBodySides = document.getElementById('swap-body-sides') as HTMLInputElement | null;
    const swapHands = document.getElementById('swap-hands') as HTMLInputElement | null;
    const negateFirstHand = document.getElementById('negate-first-hand') as HTMLInputElement | null;
    const negateSecondHand = document.getElementById('negate-second-hand') as HTMLInputElement | null;
    const negateFirstBodyJoint = document.getElementById('negate-first-body-joint') as HTMLInputElement | null;
    const negateSecondBodyJoint = document.getElementById('negate-second-body-joint') as HTMLInputElement | null;
    const fingerScaleSlider = document.getElementById('finger-scale-slider') as HTMLInputElement | null;
    const fingerScaleValue = document.getElementById('finger-scale-value');
    const settingsReadout = document.getElementById('settings-readout');
    const microphoneButton = document.getElementById('microphone-button') as HTMLButtonElement | null;
    const autoSendCheckbox = document.getElementById('auto-send-checkbox') as HTMLInputElement | null;
    const transcriptBox = document.getElementById('transcript-box');
    const textBox = document.getElementById('text-box') as HTMLTextAreaElement | null;
    const paceSlider = document.getElementById('pace-slider') as HTMLInputElement | null;
    const paceValue = document.getElementById('pace-value');
    const sendButton = document.getElementById('send-button') as HTMLButtonElement | null;
    const cancelButton = document.getElementById('cancel-button') as HTMLButtonElement | null;
    const characterCounter = document.getElementById('character-counter');
    const statusText = document.getElementById('status-text');
    const requestLogList = document.getElementById('request-log-list') as HTMLUListElement | null;
    const faceNote = document.getElementById('face-note');
    const browserNote = document.getElementById('browser-note');

    if (
      !connectionBadge ||
      !sessionId ||
      !loadingText ||
      !meanPoseButton ||
      !liveMotionButton ||
      !avatarContainer ||
      !swapBodySides ||
      !swapHands ||
      !negateFirstHand ||
      !negateSecondHand ||
      !negateFirstBodyJoint ||
      !negateSecondBodyJoint ||
      !fingerScaleSlider ||
      !fingerScaleValue ||
      !settingsReadout ||
      !microphoneButton ||
      !autoSendCheckbox ||
      !transcriptBox ||
      !textBox ||
      !paceSlider ||
      !paceValue ||
      !sendButton ||
      !cancelButton ||
      !characterCounter ||
      !statusText ||
      !requestLogList ||
      !faceNote ||
      !browserNote
    ) {
      throw new Error('The page is missing one or more required elements.');
    }

    return {
      connectionBadge,
      sessionId,
      loadingText,
      meanPoseButton,
      liveMotionButton,
      avatarContainer,
      swapBodySides,
      swapHands,
      negateFirstHand,
      negateSecondHand,
      negateFirstBodyJoint,
      negateSecondBodyJoint,
      fingerScaleSlider,
      fingerScaleValue,
      settingsReadout,
      microphoneButton,
      autoSendCheckbox,
      transcriptBox,
      textBox,
      paceSlider,
      paceValue,
      sendButton,
      cancelButton,
      characterCounter,
      statusText,
      requestLogList,
      faceNote,
      browserNote,
    };
  }

  private bindControls(): void {
    this.elements.meanPoseButton.addEventListener('click', () => {
      this.setDisplayMode('mean');
    });

    this.elements.liveMotionButton.addEventListener('click', () => {
      this.setDisplayMode('live');
    });

    this.elements.swapBodySides.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement;
      this.settings.swapBodySides = target.checked;
      this.renderCurrentFrame();
      this.renderReadout();
    });

    this.elements.swapHands.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement;
      this.settings.swapHands = target.checked;
      this.renderCurrentFrame();
      this.renderReadout();
    });

    this.elements.negateFirstHand.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement;
      this.settings.negateFirstHand = target.checked;
      this.renderCurrentFrame();
      this.renderReadout();
    });

    this.elements.negateSecondHand.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement;
      this.settings.negateSecondHand = target.checked;
      this.renderCurrentFrame();
      this.renderReadout();
    });

    this.elements.negateFirstBodyJoint.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement;
      this.settings.negateFirstBodyJoint = target.checked;
      this.renderCurrentFrame();
      this.renderReadout();
    });

    this.elements.negateSecondBodyJoint.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement;
      this.settings.negateSecondBodyJoint = target.checked;
      this.renderCurrentFrame();
      this.renderReadout();
    });

    this.elements.fingerScaleSlider.addEventListener('input', (event) => {
      const value = Number((event.target as HTMLInputElement).value);
      this.settings.fingerRotationScale = value;
      this.updateFingerScaleValue();
      this.renderCurrentFrame();
      this.renderReadout();
    });

    this.elements.autoSendCheckbox.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement;
      this.settings.autoSendAfterSpeaking = target.checked;
    });

    this.elements.textBox.addEventListener('input', (event) => {
      const target = event.target as HTMLTextAreaElement;
      target.value = target.value.slice(0, this.maxTextCharacters);
      this.updateCharacterCounter();
    });

    this.elements.paceSlider.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      this.settings.pace = Number(target.value);
      this.updatePaceValue();
    });

    this.elements.sendButton.addEventListener('click', () => {
      this.sendCurrentText();
    });

    this.elements.cancelButton.addEventListener('click', () => {
      this.cancelRequests();
    });

    this.elements.microphoneButton.addEventListener('click', () => {
      if (!this.speechController) {
        return;
      }

      if (this.speechController.isListening()) {
        this.speechController.stop();
        return;
      }

      this.speechController.start();
    });
  }

  private syncControlValues(): void {
    this.elements.swapBodySides.checked = this.settings.swapBodySides;
    this.elements.swapHands.checked = this.settings.swapHands;
    this.elements.negateFirstHand.checked = this.settings.negateFirstHand;
    this.elements.negateSecondHand.checked = this.settings.negateSecondHand;
    this.elements.negateFirstBodyJoint.checked = this.settings.negateFirstBodyJoint;
    this.elements.negateSecondBodyJoint.checked = this.settings.negateSecondBodyJoint;
    this.elements.fingerScaleSlider.value = String(this.settings.fingerRotationScale);
    this.elements.autoSendCheckbox.checked = this.settings.autoSendAfterSpeaking;
    this.elements.paceSlider.value = String(this.settings.pace);
    this.updateFingerScaleValue();
    this.updatePaceValue();
    this.updateCharacterCounter();
    this.setConnectionBadge(this.connectionState);
  }

  private setDisplayMode(displayMode: 'mean' | 'live'): void {
    this.settings.displayMode = displayMode;
    this.elements.meanPoseButton.classList.toggle('active', displayMode === 'mean');
    this.elements.liveMotionButton.classList.toggle('active', displayMode === 'live');
    this.renderCurrentFrame();
  }

  private updateFingerScaleValue(): void {
    this.elements.fingerScaleValue.textContent = this.settings.fingerRotationScale.toFixed(2);
  }

  private updatePaceValue(): void {
    this.elements.paceValue.textContent = `${this.settings.pace.toFixed(1)}×`;
  }

  private updateCharacterCounter(): void {
    const currentTextLength = this.elements.textBox.value.length;
    this.elements.characterCounter.textContent = `${currentTextLength} / ${this.maxTextCharacters} characters`;
  }

  private updateStatusText(message: string): void {
    this.elements.statusText.textContent = message;
  }

  private renderReadout(): void {
    this.elements.settingsReadout.textContent = switchesToReadoutText({
      swapSidesBody: this.settings.swapBodySides,
      swapSidesHands: this.settings.swapHands,
      negateYzFirstHand: this.settings.negateFirstHand,
      negateYzSecondHand: this.settings.negateSecondHand,
      negateYzFirstJointOfBodyPair: this.settings.negateFirstBodyJoint,
      negateYzSecondJointOfBodyPair: this.settings.negateSecondBodyJoint,
      fingerRotationScale: this.settings.fingerRotationScale,
    });
  }

  private setConnectionBadge(state: 'connecting' | 'loading' | 'ready' | 'reconnecting' | 'failed'): void {
    this.connectionState = state;
    const label = connectionStates[state];
    this.elements.connectionBadge.textContent = label;
    this.elements.connectionBadge.dataset.state = state;

    const sessionText = this.latestSessionId ? `session_id=${this.latestSessionId}` : 'session_id=';
    this.elements.sessionId.textContent = sessionText;

    const isLoading = state === 'loading';
    setElementVisible(this.elements.loadingText, isLoading);
    this.elements.loadingText.textContent = modelLoadingMessage;

    this.elements.meanPoseButton.disabled = false;
    this.elements.liveMotionButton.disabled = false;
    this.elements.sendButton.disabled = state !== 'ready' || this.elements.textBox.value.trim().length === 0;
    this.elements.cancelButton.disabled = this.pendingRequestIds.size === 0;
  }

  private renderCurrentFrame(): void {
    if (!this.avatarDriver) {
      return;
    }

    let sourceFrame: Float32Array | null = null;
    if (this.settings.displayMode === 'mean') {
      sourceFrame = new Float32Array(smplxMapping.mean);
    } else if (this.latestLiveFrame) {
      sourceFrame = new Float32Array(this.latestLiveFrame);
    }

    if (!sourceFrame) {
      return;
    }

    const transformedFrame = transformFrame(sourceFrame, this.settings);
    this.avatarDriver.applyFrame(transformedFrame);
  }

  private startAvatar(): void {
    const driver = new VrmAvatarDriver();
    this.avatarDriver = driver;
    driver.mount(this.elements.avatarContainer);
    driver.onReady(() => {
      this.renderCurrentFrame();
      this.updateStatusText('Ready for input');
      this.setConnectionBadge('ready');
    });
    driver.onError((message) => {
      this.updateStatusText(message);
      this.setConnectionBadge('failed');
    });
  }

  private startSpeech(): void {
    if (!isSpeechRecognitionAvailable()) {
      this.elements.microphoneButton.hidden = true;
      this.elements.browserNote.textContent = 'Speech recognition is unavailable in this browser.';
      return;
    }

    const controller = new SpeechToTextController({
      onInterim: (text) => {
        this.elements.transcriptBox.textContent = `${this.elements.textBox.value} ${text}`.trim();
      },
      onFinal: (text) => {
        const trimmed = text.trim();
        if (trimmed.length === 0) {
          return;
        }

        this.elements.textBox.value = trimmed;
        this.updateCharacterCounter();
        if (this.settings.autoSendAfterSpeaking && this.connectionState === 'ready') {
          this.settings.displayMode = 'live';
          this.elements.meanPoseButton.classList.toggle('active', false);
          this.elements.liveMotionButton.classList.toggle('active', true);
          this.sendCurrentText();
        } else if (this.settings.autoSendAfterSpeaking) {
          this.updateStatusText('Connection is not ready yet. Text was kept in the box.');
        }
      },
      onStateChange: (isListening) => {
        this.elements.microphoneButton.textContent = isListening ? 'Listening' : 'Microphone';
      },
      onError: (message) => {
        this.updateStatusText(message);
      },
    });

    this.speechController = controller;
  }

  private startMotionClient(): void {
    const client = new MotionClient();
    this.motionClient = client;

    this.motionPlayer = new MotionPlayer((frame) => {
      this.latestLiveFrame = frame;
      if (this.settings.displayMode === 'live') {
        this.renderCurrentFrame();
      }
    }, config.frameDimension);

    const unsubscribeState = client.onStateChange((state) => {
      this.setConnectionBadge(state);
      if (state === 'loading') {
        this.updateStatusText(modelLoadingMessage);
      } else if (state === 'connecting') {
        this.updateStatusText('Connecting to server');
      } else if (state === 'reconnecting') {
        this.updateStatusText('Reconnecting to server');
      } else if (state === 'failed') {
        this.updateStatusText('Connection failed');
      } else if (state === 'ready') {
        this.updateStatusText('Ready for input');
      }
    });

    const unsubscribeHello = client.onHello((message) => {
      this.latestSessionId = message.session_id;
      this.maxTextCharacters = message.limits.maximum_text_characters;
      this.elements.textBox.maxLength = this.maxTextCharacters;
      this.setConnectionBadge(this.connectionState);
      this.updateCharacterCounter();
      this.updateStatusText('Ready for input');
      this.stopHealthPolling();
    });

    const unsubscribeError = client.onError((message) => {
      const friendlyMessage = friendlyErrorText[message as ErrorCode] ?? message;
      this.updateStatusText(friendlyMessage);
      this.setConnectionBadge('failed');
    });

    const unsubscribeFrame = client.onMotionFrame((frame) => {
      this.latestLiveFrame = new Float32Array(frame);
      this.motionPlayer?.addBlock({
        requestIndex: 0,
        frameOffset: 0,
        frameCount: Math.max(1, frame.length / config.frameDimension),
        frames: new Float32Array(frame),
      });
      if (this.settings.displayMode === 'live') {
        this.renderCurrentFrame();
      }
    });

    const unsubscribeRequestLog = client.onRequestLog((entry) => {
      this.logEntries.unshift({
        id: entry.id,
        text: entry.sentences.join(' ') || 'pending',
        sentAt: Date.now(),
        totalFrames: 0,
        elapsedMs: entry.totalTime,
        statusText: entry.cacheHit ? 'cache hit' : 'generated',
        failed: false,
        resendable: false,
      });
      this.renderRequestLog();
    });

    client.connect();
    client.onHello(() => {
      this.stopHealthPolling();
    });

    this.trackCleanup(unsubscribeState, unsubscribeHello, unsubscribeError, unsubscribeFrame, unsubscribeRequestLog);
    this.startHealthPolling();
  }

  private trackCleanup(...callbacks: Array<() => void>): void {
    if (this.isDisposed) {
      for (const callback of callbacks) {
        callback();
      }
      return;
    }
  }

  private sendCurrentText(): void {
    const text = this.elements.textBox.value.trim();
    if (!text) {
      return;
    }

    if (this.connectionState !== 'ready') {
      this.updateStatusText('Connection is not ready yet. Text was kept in the box.');
      return;
    }

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.pendingRequestIds.add(id);
    this.logEntries.unshift({
      id,
      text,
      sentAt: Date.now(),
      totalFrames: 0,
      elapsedMs: null,
      statusText: 'pending',
      failed: false,
      resendable: false,
    });
    this.renderRequestLog();
    this.motionClient?.sendGenerate(text, this.settings.pace);
    this.settings.displayMode = 'live';
    this.elements.meanPoseButton.classList.toggle('active', false);
    this.elements.liveMotionButton.classList.toggle('active', true);
    this.elements.textBox.value = '';
    this.updateCharacterCounter();
    this.updateStatusText('Request sent to backend');
  }

  private cancelRequests(): void {
    this.motionClient?.cancelActiveRequest();
    this.pendingRequestIds.clear();
    this.motionPlayer?.clearAll();
    this.latestLiveFrame = null;
    this.updateStatusText('Playback cancelled');
    this.renderRequestLog();
  }

  private startHealthPolling(): void {
    this.stopHealthPolling();
    this.healthTimer = window.setInterval(async () => {
      try {
        const response = await fetch(getHealthUrl());
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as { status?: string };
        if (payload.status === 'ready') {
          this.stopHealthPolling();
          this.updateStatusText('Model is ready');
        }
      } catch (error) {
        void error;
      }
    }, config.healthPollIntervalMilliseconds);
  }

  private stopHealthPolling(): void {
    if (this.healthTimer !== null) {
      window.clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private renderRequestLog(): void {
    this.elements.requestLogList.innerHTML = '';
    for (const entry of this.logEntries.slice(0, 10)) {
      const item = document.createElement('li');
      const title = document.createElement('div');
      title.textContent = entry.text;

      const meta = document.createElement('div');
      const details: string[] = [];
      if (entry.elapsedMs !== null) {
        details.push(`elapsed ${entry.elapsedMs} ms`);
      }
      details.push(entry.statusText);
      meta.textContent = details.join(' • ');

      item.appendChild(title);
      item.appendChild(meta);
      this.elements.requestLogList.appendChild(item);
    }
  }
}

function setElementVisible(element: HTMLElement, visible: boolean): void {
  element.hidden = !visible;
}

function transformFrame(sourceFrame: Float32Array, settings: ApplicationSettings): Float32Array {
  const frame = new Float32Array(sourceFrame);

  if (settings.swapBodySides) {
    for (const firstStartColumn of bodyPairStartColumns) {
      swapColumnRanges(frame, firstStartColumn, firstStartColumn + 3, 3);
    }
  }

  if (settings.swapHands) {
    swapColumnRanges(frame, firstHandBlockStartColumn, secondHandBlockStartColumn, 45);
  }

  if (settings.negateFirstHand) {
    negateYAndZ(frame, firstHandBlockStartColumn, 45);
  }

  if (settings.negateSecondHand) {
    negateYAndZ(frame, secondHandBlockStartColumn, 45);
  }

  if (settings.negateFirstBodyJoint) {
    for (const firstStartColumn of bodyPairStartColumns) {
      negateYAndZ(frame, firstStartColumn, 3);
    }
  }

  if (settings.negateSecondBodyJoint) {
    for (const firstStartColumn of bodyPairStartColumns) {
      negateYAndZ(frame, firstStartColumn + 3, 3);
    }
  }

  scaleColumns(frame, firstHandBlockStartColumn, 90, settings.fingerRotationScale);
  return frame;
}

function swapColumnRanges(frame: Float32Array, firstStartColumn: number, secondStartColumn: number, columnCount: number): void {
  for (let columnOffset = 0; columnOffset < columnCount; columnOffset += 1) {
    const firstValue = frame[firstStartColumn + columnOffset];
    frame[firstStartColumn + columnOffset] = frame[secondStartColumn + columnOffset];
    frame[secondStartColumn + columnOffset] = firstValue;
  }
}

function negateYAndZ(frame: Float32Array, startColumn: number, columnCount: number): void {
  for (let index = startColumn; index < startColumn + columnCount; index += 3) {
    frame[index + 1] *= -1;
    frame[index + 2] *= -1;
  }
}

function scaleColumns(frame: Float32Array, startColumn: number, columnCount: number, scale: number): void {
  for (let index = startColumn; index < startColumn + columnCount; index += 1) {
    frame[index] *= scale;
  }
}
