export interface SpeechToTextControllerOptions {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onStateChange: (isListening: boolean) => void;
  onError: (message: string) => void;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export function isSpeechRecognitionAvailable(): boolean {
  const recognitionAPI =
    (window as typeof window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    }).SpeechRecognition ??
    (window as typeof window & {
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    }).webkitSpeechRecognition;

  return Boolean(recognitionAPI);
}

export class SpeechToTextController {
  private readonly recognition: SpeechRecognitionLike | null;
  private isRecording = false;
  private finalTranscript = '';
  private restartRequested = false;
  private restartDelayMilliseconds = 300;
  private retryCount = 0;
  private readonly maximumRetries = 3;
  private readonly onInterim: (text: string) => void;
  private readonly onFinal: (text: string) => void;
  private readonly onStateChange: (isListening: boolean) => void;
  private readonly onError: (message: string) => void;

  public constructor(options: SpeechToTextControllerOptions) {
    const recognitionAPI =
      (window as typeof window & {
        SpeechRecognition?: SpeechRecognitionConstructor;
        webkitSpeechRecognition?: SpeechRecognitionConstructor;
      }).SpeechRecognition ??
      (window as typeof window & {
        webkitSpeechRecognition?: SpeechRecognitionConstructor;
      }).webkitSpeechRecognition;

    if (!recognitionAPI) {
      this.recognition = null;
      this.onInterim = options.onInterim;
      this.onFinal = options.onFinal;
      this.onStateChange = options.onStateChange;
      this.onError = options.onError;
      options.onError('Speech recognition is unavailable in this browser.');
      return;
    }

    this.recognition = new recognitionAPI();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';
    this.onInterim = options.onInterim;
    this.onFinal = options.onFinal;
    this.onStateChange = options.onStateChange;
    this.onError = options.onError;

    this.recognition.onresult = (event: SpeechRecognitionEventLike) => {
      let interimTextValue = '';
      let combinedText = '';

      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript ?? '';
        combinedText = `${combinedText}${transcript}`;

        if (index === event.results.length - 1) {
          interimTextValue = combinedText;
        }
      }

      if (interimTextValue.trim()) {
        this.onInterim(interimTextValue.trim());
      }

      this.finalTranscript = combinedText.trim();
    };

    this.recognition.onend = () => {
      if (this.isRecording) {
        this.isRecording = false;
        this.onStateChange(false);
      }

      if (this.finalTranscript.trim()) {
        this.onFinal(this.finalTranscript.trim());
      }

      this.finalTranscript = '';

      if (this.restartRequested) {
        window.setTimeout(() => {
          this.start();
        }, this.restartDelayMilliseconds);
      }
    };
  }

  public start(): void {
    if (!this.recognition) {
      this.onError('Speech recognition is unavailable in this browser.');
      return;
    }

    this.restartRequested = true;
    this.finalTranscript = '';
    this.isRecording = true;
    this.onStateChange(true);

    try {
      this.recognition.start();
      this.retryCount = 0;
    } catch {
      this.retryCount += 1;
      if (this.retryCount > this.maximumRetries) {
        this.stop();
        this.onError('Speech recognition failed multiple times.');
        return;
      }
      window.setTimeout(() => {
        this.start();
      }, this.restartDelayMilliseconds);
    }
  }

  public stop(): void {
    this.restartRequested = false;
    this.finalTranscript = '';
    if (!this.recognition) {
      this.isRecording = false;
      this.onStateChange(false);
      return;
    }

    try {
      this.recognition.stop();
    } catch {
      // ignore stop errors
    }

    this.isRecording = false;
    this.onStateChange(false);
  }

  public close(): void {
    this.restartRequested = false;
    this.finalTranscript = '';
    if (!this.recognition) {
      this.isRecording = false;
      this.onStateChange(false);
      return;
    }

    try {
      this.recognition.stop();
    } catch {
      // ignore close errors
    }

    this.isRecording = false;
    this.onStateChange(false);
  }

  public isListening(): boolean {
    return this.isRecording;
  }
}

export function createSpeechController(options: SpeechToTextControllerOptions): SpeechToTextController {
  return new SpeechToTextController(options);
}
