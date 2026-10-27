import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { MotionClient } from './motionClient';
import { MotionPlayer, type PlayerState } from './motionPlayer';
import { createSpeechController, isSpeechRecognitionAvailable, type SpeechToTextController } from './speech';
import { type ConnectionState, type ServerMessage } from './protocol';
import { config, smplxMapping } from './config';
import { VrmAvatarDriver } from './vrmAvatarDriver';

type DisplayMode = 'mean' | 'live';

type RequestLogEntry = {
  id: string;
  sentences: string[];
  firstMotionDelay: number;
  totalTime: number;
  cacheHit: boolean;
};

type DiagnosticsState = {
  connectionState: ConnectionState;
  sessionId: string;
  helloReady: boolean;
  serverMessageCounts: Record<string, number>;
  binaryBlockCount: number;
  totalFramesReceived: number;
  lastServerMessageType: string;
  lastServerMessageAgeSeconds: number;
  bufferedFrames: number;
  playerState: PlayerState;
  displayMode: DisplayMode;
  avatarReady: boolean;
  lastApplyFrameAgeSeconds: number;
  latencyMs: number | null;
  lastError: string;
  connectionReason: string;
};

const modelLoadingMessage = 'Model is loading, this can take a few minutes';
const defaultTransformSettings = {
  swapBodySides: false,
  swapHands: false,
  negateFirstHand: false,
  negateSecondHand: false,
  negateFirstBodyJoint: false,
  negateSecondBodyJoint: false,
  fingerRotationScale: 1,
};

const firstBodyPairStartColumns = [3, 12, 18, 24] as const;
const firstHandBlockStartColumn = 30;
const secondHandBlockStartColumn = 75;

const defaultMessageCounts: Record<string, number> = {
  hello: 0,
  accepted: 0,
  sentence: 0,
  done: 0,
  error: 0,
  cancelled: 0,
  pong: 0,
};

function getConnectionReason(connectionState: ConnectionState): string {
  if (connectionState === 'connecting') {
    return 'connecting';
  }

  if (connectionState === 'loading') {
    return 'loading';
  }

  if (connectionState === 'reconnecting') {
    return 'reconnecting';
  }

  if (connectionState === 'failed') {
    return 'refused';
  }

  return 'ready';
}

function splitIntoPhrases(rawText: string, characterLimit: number): string[] {
  const normalizedText = rawText.replace(/\s+/g, ' ').trim();
  if (!normalizedText) {
    return [];
  }

  const sentenceSegments = normalizedText
    .split(/(?<=[.!?])\s+|\n+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (sentenceSegments.length === 0) {
    return [normalizedText];
  }

  const gatheredPhrases: string[] = [];
  for (const sentence of sentenceSegments) {
    if (sentence.length <= characterLimit) {
      gatheredPhrases.push(sentence);
      continue;
    }

    const sentenceWords = sentence.split(' ');
    let accumulator = '';
    for (const word of sentenceWords) {
      const nextValue = accumulator ? `${accumulator} ${word}` : word;
      if (nextValue.length <= characterLimit) {
        accumulator = nextValue;
        continue;
      }

      if (accumulator) {
        gatheredPhrases.push(accumulator);
      }

      accumulator = word;
    }

    if (accumulator) {
      gatheredPhrases.push(accumulator);
    }
  }

  return gatheredPhrases;
}

function transformFrame(sourceFrame: Float32Array, settings: typeof defaultTransformSettings): Float32Array {
  const frame = new Float32Array(sourceFrame);

  if (settings.swapBodySides) {
    for (const firstStartColumn of firstBodyPairStartColumns) {
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
    for (const firstStartColumn of firstBodyPairStartColumns) {
      negateYAndZ(frame, firstStartColumn, 3);
    }
  }

  if (settings.negateSecondBodyJoint) {
    for (const firstStartColumn of firstBodyPairStartColumns) {
      negateYAndZ(frame, firstStartColumn + 3, 3);
    }
  }

  scaleColumns(frame, firstHandBlockStartColumn, 90, settings.fingerRotationScale);
  return frame;
}

function swapColumnRanges(frame: Float32Array, firstStartColumn: number, secondStartColumn: number, columnCount: number): void {
  for (let offset = 0; offset < columnCount; offset += 1) {
    const firstValue = frame[firstStartColumn + offset];
    frame[firstStartColumn + offset] = frame[secondStartColumn + offset];
    frame[secondStartColumn + offset] = firstValue;
  }
}

function negateYAndZ(frame: Float32Array, startColumn: number, columnCount: number): void {
  for (let columnIndex = startColumn; columnIndex < startColumn + columnCount; columnIndex += 3) {
    frame[columnIndex + 1] *= -1;
    frame[columnIndex + 2] *= -1;
  }
}

function scaleColumns(frame: Float32Array, startColumn: number, columnCount: number, scale: number): void {
  for (let columnIndex = startColumn; columnIndex < startColumn + columnCount; columnIndex += 1) {
    frame[columnIndex] *= scale;
  }
}

function getFriendlyError(codeOrMessage: string): string {
  const friendlyMessages: Record<string, string> = {
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

  return friendlyMessages[codeOrMessage] ?? (codeOrMessage || 'Something went wrong.');
}

export default function App() {
  const avatarContainerReference = useRef<HTMLDivElement | null>(null);
  const avatarDriverReference = useRef<VrmAvatarDriver | null>(null);
  const motionClientReference = useRef<MotionClient | null>(null);
  const motionPlayerReference = useRef<MotionPlayer | null>(null);
  const speechControllerReference = useRef<SpeechToTextController | null>(null);
  const latestLiveFrameReference = useRef<Float32Array | null>(null);
  const displayModeReference = useRef<DisplayMode>('mean');
  const transformSettingsReference = useRef<typeof defaultTransformSettings>(defaultTransformSettings);
  const paceReference = useRef(config.paceDefault);
  const queuedPhrasesReference = useRef<string[]>([]);
  const pendingRequestIdsReference = useRef<Set<string>>(new Set());
  const requestIdToSentAtReference = useRef<Map<string, number>>(new Map());
  const requestIdToRequestIndexReference = useRef<Map<string, number>>(new Map());
  const requestIndexToRequestIdReference = useRef<Map<number, string>>(new Map());
  const meanPoseTimerReference = useRef<number | null>(null);
  const helloStateReference = useRef<{ session_id: string; ready: boolean; limits: { maximum_text_characters: number; maximum_pending_requests: number } } | null>(null);
  const messageCountsReference = useRef<Record<string, number>>({ ...defaultMessageCounts });
  const binaryBlockCountReference = useRef(0);
  const totalFramesReceivedReference = useRef(0);
  const lastErrorMessageReference = useRef('');
  const lastServerMessageTypeReference = useRef('none');
  const lastServerMessageTimestampReference = useRef(Date.now());
  const lastApplyFrameTimestampReference = useRef(Date.now());
  const latencyMillisecondsReference = useRef<number | null>(null);

  const [displayMode, setDisplayMode] = useState<DisplayMode>('mean');
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [sessionId, setSessionId] = useState('');
  const [helloReady, setHelloReady] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [transcriptText, setTranscriptText] = useState('');
  const [interimText, setInterimText] = useState('');
  const [inputText, setInputText] = useState('');
  const [pace, setPace] = useState(config.paceDefault);
  const [isListening, setIsListening] = useState(false);
  const [isConversationOn, setIsConversationOn] = useState(false);
  const [speechAvailable, setSpeechAvailable] = useState(true);
  const [maxTextCharacters, setMaxTextCharacters] = useState(400);
  const [maxPendingRequests, setMaxPendingRequests] = useState(1);
  const [playerState, setPlayerState] = useState<PlayerState>('idle');
  const [requestLogs, setRequestLogs] = useState<RequestLogEntry[]>([]);
  const [transformSettings, setTransformSettings] = useState(defaultTransformSettings);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsState>({
    connectionState: 'connecting',
    sessionId: '',
    helloReady: false,
    serverMessageCounts: { ...defaultMessageCounts },
    binaryBlockCount: 0,
    totalFramesReceived: 0,
    lastServerMessageType: 'none',
    lastServerMessageAgeSeconds: 0,
    bufferedFrames: 0,
    playerState: 'idle',
    displayMode: 'mean',
    avatarReady: false,
    lastApplyFrameAgeSeconds: 0,
    latencyMs: null,
    lastError: '',
    connectionReason: 'connecting',
  });

  const renderCurrentFrame = useCallback(() => {
    const avatarDriver = avatarDriverReference.current;
    if (!avatarDriver) {
      return;
    }

    const sourceFrame = displayModeReference.current === 'mean'
      ? new Float32Array(smplxMapping.mean)
      : latestLiveFrameReference.current ?? new Float32Array(smplxMapping.mean);

    const transformedFrame = transformFrame(sourceFrame, transformSettingsReference.current);
    avatarDriver.applyFrame(transformedFrame);
    lastApplyFrameTimestampReference.current = Date.now();
  }, []);

  const updateDisplayMode = useCallback((nextDisplayMode: DisplayMode) => {
    displayModeReference.current = nextDisplayMode;
    setDisplayMode(nextDisplayMode);
    renderCurrentFrame();
  }, [renderCurrentFrame]);

  const setMeanPoseAfterPlayback = useCallback(() => {
    if (meanPoseTimerReference.current !== null) {
      window.clearTimeout(meanPoseTimerReference.current);
      meanPoseTimerReference.current = null;
    }

    if (displayModeReference.current === 'live' && playerState === 'idle') {
      meanPoseTimerReference.current = window.setTimeout(() => {
        updateDisplayMode('mean');
      }, 1500);
    }
  }, [playerState, updateDisplayMode]);

  const flushQueuedPhrases = useCallback(() => {
    const motionClient = motionClientReference.current;
    const helloState = helloStateReference.current;
    if (!motionClient || !helloState || !helloState.ready) {
      return;
    }

    while (pendingRequestIdsReference.current.size < helloState.limits.maximum_pending_requests && queuedPhrasesReference.current.length > 0) {
      const nextPhrase = queuedPhrasesReference.current.shift();
      if (!nextPhrase) {
        break;
      }

      const requestId = motionClient.sendGenerate(nextPhrase, paceReference.current);
      pendingRequestIdsReference.current.add(requestId);
      requestIdToSentAtReference.current.set(requestId, Date.now());
      setStatusMessage(`Generating: ${nextPhrase}`);
      updateDisplayMode('live');
    }
  }, [updateDisplayMode]);

  const enqueuePhrase = useCallback((rawText: string) => {
    const nextText = rawText.trim();
    if (!nextText) {
      return;
    }

    const chunks = splitIntoPhrases(nextText, maxTextCharacters);
    for (const chunk of chunks) {
      if (queuedPhrasesReference.current.length >= 6) {
        queuedPhrasesReference.current.shift();
        lastErrorMessageReference.current = 'Too much speech, skipping ahead';
        setStatusMessage('Too much speech, skipping ahead');
      }

      queuedPhrasesReference.current.push(chunk);
    }

    setTranscriptText(nextText);
    setInterimText('');
    setInputText('');
    setDisplayMode('live');
    displayModeReference.current = 'live';
    renderCurrentFrame();
    flushQueuedPhrases();
  }, [flushQueuedPhrases, maxTextCharacters, renderCurrentFrame]);

  useEffect(() => {
    displayModeReference.current = displayMode;
    renderCurrentFrame();
  }, [displayMode, renderCurrentFrame]);

  useEffect(() => {
    transformSettingsReference.current = transformSettings;
    renderCurrentFrame();
  }, [renderCurrentFrame, transformSettings]);

  useEffect(() => {
    paceReference.current = pace;
  }, [pace]);

  useEffect(() => {
    const avatarDriver = new VrmAvatarDriver();
    avatarDriverReference.current = avatarDriver;

    if (avatarContainerReference.current) {
      avatarDriver.mount(avatarContainerReference.current);
    }

    avatarDriver.onReady(() => {
      renderCurrentFrame();
      setStatusMessage('Ready for input');
    });

    avatarDriver.onError((message) => {
      lastErrorMessageReference.current = message;
      setStatusMessage(message);
    });

    return () => {
      avatarDriver.dispose();
      avatarDriverReference.current = null;
    };
  }, [renderCurrentFrame]);

  useEffect(() => {
    const motionClient = new MotionClient();
    motionClientReference.current = motionClient;

    const unsubscribeState = motionClient.onStateChange((nextState) => {
      setConnectionState(nextState);
      if (nextState === 'loading') {
        setStatusMessage(modelLoadingMessage);
      }
      if (nextState === 'connecting') {
        setStatusMessage('Connecting to server');
      }
      if (nextState === 'reconnecting') {
        setStatusMessage('Reconnecting to server');
      }
      if (nextState === 'failed') {
        setStatusMessage('Connection failed');
      }
      if (nextState === 'ready') {
        setStatusMessage('Ready for input');
      }
    });

    const unsubscribeHello = motionClient.onHello((helloMessage) => {
      helloStateReference.current = {
        session_id: helloMessage.session_id,
        ready: helloMessage.ready,
        limits: {
          maximum_text_characters: helloMessage.limits.maximum_text_characters,
          maximum_pending_requests: helloMessage.limits.maximum_pending_requests,
        },
      };
      setSessionId(helloMessage.session_id);
      setHelloReady(helloMessage.ready);
      setMaxTextCharacters(helloMessage.limits.maximum_text_characters);
      setMaxPendingRequests(helloMessage.limits.maximum_pending_requests);
    });

    const unsubscribeError = motionClient.onError((payload) => {
      const friendlyError = getFriendlyError(payload);
      lastErrorMessageReference.current = friendlyError;
      setStatusMessage(friendlyError);
      messageCountsReference.current.error = (messageCountsReference.current.error ?? 0) + 1;
    });

    const unsubscribeServerMessage = motionClient.onServerMessage((message: ServerMessage) => {
      lastServerMessageTimestampReference.current = Date.now();
      lastServerMessageTypeReference.current = message.type;
      messageCountsReference.current[message.type] = (messageCountsReference.current[message.type] ?? 0) + 1;
      if (message.type === 'hello') {
        setHelloReady(message.ready);
      }

      if (message.type === 'accepted') {
        const requestId = message.id;
        if (requestIdToSentAtReference.current.has(requestId)) {
          requestIdToRequestIndexReference.current.set(requestId, message.request_index);
          requestIndexToRequestIdReference.current.set(message.request_index, requestId);
        }
        motionPlayerReference.current?.registerRequest(message.request_index);
      }

      if (message.type === 'done' || message.type === 'error' || message.type === 'cancelled') {
        const requestIndex = 'request_index' in message ? message.request_index : -1;
        if (requestIndex >= 0) {
          motionPlayerReference.current?.markRequestComplete(requestIndex);
        }
        const requestId = requestIndexToRequestIdReference.current.get(requestIndex);
        if (requestId) {
          pendingRequestIdsReference.current.delete(requestId);
          requestIdToSentAtReference.current.delete(requestId);
          requestIdToRequestIndexReference.current.delete(requestId);
          requestIndexToRequestIdReference.current.delete(requestIndex);
          flushQueuedPhrases();
        }
      }
    });

    const unsubscribeMotion = motionClient.onMotionBlock((block) => {
      binaryBlockCountReference.current += 1;
      totalFramesReceivedReference.current += block.frameCount;
      const requestId = requestIndexToRequestIdReference.current.get(block.requestIndex);
      if (requestId) {
        const sentAt = requestIdToSentAtReference.current.get(requestId);
        if (sentAt !== undefined && latencyMillisecondsReference.current === null) {
          latencyMillisecondsReference.current = Date.now() - sentAt;
        }
      }
      motionPlayerReference.current?.addBlock(block);
      updateDisplayMode('live');
      setPlayerState(motionPlayerReference.current?.getState() ?? 'playing');
    });

    const unsubscribeRequestLog = motionClient.onRequestLog((requestLog) => {
      setRequestLogs((previousLogs) => [{
        id: requestLog.id,
        sentences: requestLog.sentences,
        firstMotionDelay: requestLog.firstMotionDelay,
        totalTime: requestLog.totalTime,
        cacheHit: requestLog.cacheHit,
      }, ...previousLogs].slice(0, 10));
    });

    motionClient.connect();

    return () => {
      unsubscribeState();
      unsubscribeHello();
      unsubscribeError();
      unsubscribeServerMessage();
      unsubscribeMotion();
      unsubscribeRequestLog();
      motionClient.close();
      motionClientReference.current = null;
    };
  }, [flushQueuedPhrases, updateDisplayMode]);

  useEffect(() => {
    const motionPlayer = new MotionPlayer((frame) => {
      latestLiveFrameReference.current = new Float32Array(frame);
      renderCurrentFrame();
    }, smplxMapping.frame_dimension, (nextState) => {
      setPlayerState(nextState);
    });
    motionPlayerReference.current = motionPlayer;

    return () => {
      motionPlayer.clearAll();
      motionPlayerReference.current = null;
    };
  }, [renderCurrentFrame]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setDiagnostics({
        connectionState,
        sessionId,
        helloReady,
        serverMessageCounts: { ...messageCountsReference.current },
        binaryBlockCount: binaryBlockCountReference.current,
        totalFramesReceived: totalFramesReceivedReference.current,
        lastServerMessageType: lastServerMessageTypeReference.current,
        lastServerMessageAgeSeconds: (Date.now() - lastServerMessageTimestampReference.current) / 1000,
        bufferedFrames: motionPlayerReference.current?.getBufferedFrames() ?? 0,
        playerState: motionPlayerReference.current?.getState() ?? 'idle',
        displayMode: displayModeReference.current,
        avatarReady: avatarDriverReference.current !== null,
        lastApplyFrameAgeSeconds: (Date.now() - lastApplyFrameTimestampReference.current) / 1000,
        latencyMs: latencyMillisecondsReference.current,
        lastError: lastErrorMessageReference.current,
        connectionReason: getConnectionReason(connectionState),
      });
    }, 250);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [connectionState, displayMode, helloReady, sessionId, playerState]);

  useEffect(() => {
    if (playerState === 'idle' && displayModeReference.current === 'live') {
      setMeanPoseAfterPlayback();
    } else if (meanPoseTimerReference.current !== null) {
      window.clearTimeout(meanPoseTimerReference.current);
      meanPoseTimerReference.current = null;
    }
  }, [playerState, setMeanPoseAfterPlayback]);

  useEffect(() => {
    const speechController = createSpeechController({
      onInterim: (nextText) => {
        setInterimText(nextText);
      },
      onFinal: (nextText) => {
        const trimmedText = nextText.trim();
        if (!trimmedText) {
          return;
        }

        setTranscriptText(trimmedText);
        setInterimText('');
        enqueuePhrase(trimmedText);
      },
      onStateChange: (nextListening) => {
        setIsListening(nextListening);
        setIsConversationOn(nextListening);
      },
      onError: (errorMessage) => {
        lastErrorMessageReference.current = errorMessage;
        setStatusMessage(errorMessage);
        setIsConversationOn(false);
        setIsListening(false);
      },
    });

    speechControllerReference.current = speechController;
    setSpeechAvailable(isSpeechRecognitionAvailable());

    return () => {
      speechController.close();
      speechControllerReference.current = null;
    };
  }, [enqueuePhrase]);

  const handleTextSubmit = useCallback((nextText: string) => {
    const trimmedText = nextText.trim();
    if (!trimmedText) {
      return;
    }

    setInputText('');
    setTranscriptText(trimmedText);
    setInterimText('');
    setDisplayMode('live');
    displayModeReference.current = 'live';
    enqueuePhrase(trimmedText);
  }, [enqueuePhrase]);

  const handleStop = useCallback(() => {
    const requestIds = Array.from(pendingRequestIdsReference.current);
    for (const requestId of requestIds) {
      motionClientReference.current?.cancelRequestById(requestId);
    }

    pendingRequestIdsReference.current.clear();
    requestIdToSentAtReference.current.clear();
    requestIdToRequestIndexReference.current.clear();
    requestIndexToRequestIdReference.current.clear();
    queuedPhrasesReference.current = [];
    motionPlayerReference.current?.clearAll();
    latestLiveFrameReference.current = null;
    if (meanPoseTimerReference.current !== null) {
      window.clearTimeout(meanPoseTimerReference.current);
      meanPoseTimerReference.current = null;
    }
    updateDisplayMode('mean');
    setTranscriptText('');
    setInterimText('');
    setStatusMessage('Stopped');
  }, [updateDisplayMode]);

  const handleMicToggle = useCallback(() => {
    const speechController = speechControllerReference.current;
    if (!speechController) {
      return;
    }

    if (isConversationOn) {
      speechController.stop();
      setIsConversationOn(false);
      setIsListening(false);
      return;
    }

    speechController.start();
  }, [isConversationOn]);

  const handleFieldChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(event.target.value.slice(0, maxTextCharacters));
  }, [maxTextCharacters]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleTextSubmit(inputText);
    }
  }, [handleTextSubmit, inputText]);

  const controlSummary = useMemo(() => {
    return [
      `swapBodySides=${transformSettings.swapBodySides}`,
      `swapHands=${transformSettings.swapHands}`,
      `negateFirstHand=${transformSettings.negateFirstHand}`,
      `negateSecondHand=${transformSettings.negateSecondHand}`,
      `negateFirstBodyJoint=${transformSettings.negateFirstBodyJoint}`,
      `negateSecondBodyJoint=${transformSettings.negateSecondBodyJoint}`,
      `fingerRotationScale=${transformSettings.fingerRotationScale.toFixed(2)}`,
    ].join(', ');
  }, [transformSettings]);

  return (
    <main className="application-shell">
      <section className="avatar-stage">
        <div className="top-bar">
          <div className="status-group">
            <span className={`connection-badge state-${connectionState}`}>{connectionState}</span>
            {sessionId ? <span className="session-id">session_id={sessionId}</span> : null}
            {connectionState === 'loading' ? <span className="loading-indicator">{modelLoadingMessage}</span> : null}
          </div>
          <div className="header-actions">
            <button type="button" onClick={() => updateDisplayMode('mean')}>Show mean pose</button>
            <button type="button" onClick={() => updateDisplayMode('live')}>Show live motion</button>
          </div>
        </div>

        <div className="avatar-panel">
          <div className="avatar-scene" ref={avatarContainerReference}></div>
        </div>
      </section>

      <aside className="side-panel">
        <section className="input-panel">
          <div className="speech-row">
            {speechAvailable ? (
              <button type="button" className={isListening || isConversationOn ? 'microphone active' : 'microphone'} onClick={handleMicToggle}>
                {isListening || isConversationOn ? 'Stop conversation' : 'Start conversation'}
              </button>
            ) : null}
          </div>

          <div className="transcript-box">
            <strong>Live speech</strong>
            <div>{interimText || 'Listening for speech…'}</div>
          </div>

          <div className="transcript-box">
            <strong>Transcript</strong>
            <div>{transcriptText || 'No transcript yet'}</div>
          </div>

          <div className="text-entry-row">
            <textarea value={inputText} onChange={handleFieldChange} onKeyDown={handleKeyDown} placeholder="Type text to sign" rows={4} maxLength={maxTextCharacters} />
            <div className="send-controls">
              <label>
                <span>Pace</span>
                <input type="range" min={config.paceMin} max={config.paceMax} step="0.1" value={pace} onChange={(event) => setPace(Number(event.target.value))} />
              </label>
              <span>{pace.toFixed(1)}</span>
              <button type="button" className="secondary" onClick={handleStop}>Stop</button>
            </div>
          </div>

          <div className="character-counter">{inputText.length} / {maxTextCharacters} characters</div>
          <div className="status-text">{statusMessage || 'Ready for input'}</div>
        </section>

        <section className="control-panel">
          <label className="checkbox-row">
            <input type="checkbox" checked={transformSettings.swapBodySides} onChange={(event) => setTransformSettings((previousValue) => ({ ...previousValue, swapBodySides: event.target.checked }))} />
            <span>Swap sides for body joints</span>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={transformSettings.swapHands} onChange={(event) => setTransformSettings((previousValue) => ({ ...previousValue, swapHands: event.target.checked }))} />
            <span>Swap sides for hands</span>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={transformSettings.negateFirstHand} onChange={(event) => setTransformSettings((previousValue) => ({ ...previousValue, negateFirstHand: event.target.checked }))} />
            <span>Negate y and z for the first hand block</span>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={transformSettings.negateSecondHand} onChange={(event) => setTransformSettings((previousValue) => ({ ...previousValue, negateSecondHand: event.target.checked }))} />
            <span>Negate y and z for the second hand block</span>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={transformSettings.negateFirstBodyJoint} onChange={(event) => setTransformSettings((previousValue) => ({ ...previousValue, negateFirstBodyJoint: event.target.checked }))} />
            <span>Negate first body joint axes</span>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={transformSettings.negateSecondBodyJoint} onChange={(event) => setTransformSettings((previousValue) => ({ ...previousValue, negateSecondBodyJoint: event.target.checked }))} />
            <span>Negate second body joint axes</span>
          </label>
          <label className="slider-row">
            <span>Finger rotation scale</span>
            <input type="range" min="0" max="1.5" step="0.01" value={transformSettings.fingerRotationScale} onChange={(event) => setTransformSettings((previousValue) => ({ ...previousValue, fingerRotationScale: Number(event.target.value) }))} />
            <strong>{transformSettings.fingerRotationScale.toFixed(2)}</strong>
          </label>
          <div className="summary-box">{controlSummary}</div>
        </section>

        <section className="diagnostics-panel">
          <div className="diagnostic-grid">
            <div>connection: {diagnostics.connectionReason}</div>
            <div>session_id: {diagnostics.sessionId || 'none'}</div>
            <div>hello.ready: {String(diagnostics.helloReady)}</div>
            <div>server messages: {JSON.stringify(diagnostics.serverMessageCounts)}</div>
            <div>binary blocks: {diagnostics.binaryBlockCount}</div>
            <div>total frames: {diagnostics.totalFramesReceived}</div>
            <div>last message: {diagnostics.lastServerMessageType}</div>
            <div>last message age: {diagnostics.lastServerMessageAgeSeconds.toFixed(1)}s</div>
            <div>buffered frames: {diagnostics.bufferedFrames}</div>
            <div>player: {diagnostics.playerState}</div>
            <div>displayMode: {diagnostics.displayMode}</div>
            <div>avatar ready: {String(diagnostics.avatarReady)}</div>
            <div>last applyFrame: {diagnostics.lastApplyFrameAgeSeconds.toFixed(1)}s</div>
            <div>latency: {diagnostics.latencyMs === null ? 'n/a' : `${diagnostics.latencyMs} ms`}</div>
            <div>error: {diagnostics.lastError || 'none'}</div>
            <div>pending queue: {queuedPhrasesReference.current.length}</div>
            <div>unfinished requests: {pendingRequestIdsReference.current.size}</div>
            <div>max pending: {maxPendingRequests}</div>
          </div>
        </section>

        <section className="log-panel">
          <h2>Request log</h2>
          {requestLogs.length === 0 ? <p>No requests yet.</p> : (
            <ul>
              {requestLogs.map((entry) => (
                <li key={entry.id}>
                  <strong>{entry.sentences.join(' ') || 'pending'}</strong>
                  <span>{entry.totalTime} ms</span>
                  <span>{entry.firstMotionDelay} ms to first motion</span>
                  <span>{entry.cacheHit ? 'cache hit' : 'generated'}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </main>
  );
}


