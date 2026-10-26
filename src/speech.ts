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
  private readonly recognition: SpeechRecognitionLike;
  private isRecording = false;
  private finalTranscript = '';
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
      this.recognition = null as unknown as SpeechRecognitionLike;
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
      let nextInterimText = '';
      let recognitionText = '';

      for (let index = 0; index < event.results.length; index += 1) {
        const currentResult = event.results[index];
        const transcript = currentResult[0]?.transcript ?? '';
        recognitionText = `${recognitionText}${transcript}`;

        if (index === event.results.length - 1) {
          nextInterimText = recognitionText;
        }
      }

      if (nextInterimText) {
        this.onInterim(nextInterimText.trim());
      }

      this.finalTranscript = recognitionText.trim();
    };

    this.recognition.onend = () => {
      if (this.finalTranscript) {
        this.onFinal(this.finalTranscript);
      }
      this.isRecording = false;
      this.onStateChange(false);
    };
  }

  public start(): void {
    if (!this.recognition) {
      this.onError('Speech recognition is unavailable in this browser.');
      return;
    }

    this.finalTranscript = '';
    this.isRecording = true;
    this.onStateChange(true);
    this.recognition.start();
  }

  public stop(): void {
    if (!this.recognition || !this.isRecording) {
      this.isRecording = false;
      this.onStateChange(false);
      return;
    }

    this.recognition.stop();
    this.isRecording = false;
    this.onStateChange(false);
  }

  public close(): void {
    if (!this.recognition) {
      return;
    }

    this.recognition.stop();
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
