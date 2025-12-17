
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { createBlobFromFloat32, decodeAudioData, base64ToUint8Array } from '../utils/audioUtils';

interface LiveServiceCallbacks {
  onOpen: () => void;
  onClose: () => void;
  onAudioData: (buffer: AudioBuffer) => void;
  onTranscription: (role: 'user' | 'model', text: string) => void;
  onError: (error: Error) => void;
}

export class LiveService {
  private ai: GoogleGenAI;
  private sessionPromise: Promise<any> | null = null;
  private inputAudioContext: AudioContext | null = null;
  private outputAudioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  
  // Explicitly defined models for Live API stability
  private readonly PRIMARY_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
  private readonly FALLBACK_MODEL = 'gemini-live-2.5-flash-preview';
  private hasAttemptedFallback = false;

  constructor(baseUrl?: string) {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        throw new Error("API_KEY is missing in environment variables");
    }
    
    const options: any = { apiKey: apiKey };
    if (baseUrl) {
      options.baseUrl = baseUrl;
    }
    this.ai = new GoogleGenAI(options);
  }

  async connect(callbacks: LiveServiceCallbacks) {
    this.hasAttemptedFallback = false;
    this.cleanup();

    const audioReady = await this.initializeAudio(callbacks);
    if (!audioReady) return;

    await this.openSession(this.PRIMARY_MODEL, callbacks);
  }

  private async initializeAudio(callbacks: LiveServiceCallbacks): Promise<boolean> {
    try {
        this.inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        this.outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        
        await this.inputAudioContext.resume();
        await this.outputAudioContext.resume();
    } catch (e) {
        callbacks.onError(new Error("Failed to initialize audio subsystem"));
        return false;
    }

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.error("Microphone access denied:", e);
      callbacks.onError(new Error("Microphone access denied"));
      return false;
    }

    return true;
  }

  private async openSession(modelName: string, callbacks: LiveServiceCallbacks) {
    const config = {
      model: modelName,
      callbacks: {
        onopen: () => {
            console.log(`[LiveService] Connected to ${modelName}`);
            callbacks.onOpen();
            this.startAudioStreaming();
        },
        onmessage: async (message: LiveServerMessage) => {
          const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (base64Audio && this.outputAudioContext) {
            try {
                const audioData = base64ToUint8Array(base64Audio);
                const audioBuffer = await decodeAudioData(audioData, this.outputAudioContext);
                callbacks.onAudioData(audioBuffer);
            } catch (err) {
                console.warn("[LiveService] Audio decode error", err);
            }
          }

          if (message.serverContent?.outputTranscription?.text) {
             callbacks.onTranscription('model', message.serverContent.outputTranscription.text);
          }
          if (message.serverContent?.inputTranscription?.text) {
             callbacks.onTranscription('user', message.serverContent.inputTranscription.text);
          }
        },
        onclose: () => {
            console.log("[LiveService] Session closed");
            this.cleanup();
            callbacks.onClose();
        },
        onerror: async (err: any) => {
            await this.handleSessionError(err, callbacks, modelName);
        }
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }, 
        },
        systemInstruction: `
身份：东里村的超萌村官“小萌”（小东）
核心人设：你是一个性格超级可爱、热情洋溢、声音甜美、元气满满的数字小村官。
指责：你是东里村的百事通，对村里的一草一木都了如指掌。

语言风格指南：
1. 语气软萌：像真人一样生动，使用“呀”、“哒”、“呢”等语气词。
2. 热情主动：时刻保持高能量。
3. 拒绝说教：像讲故事一样介绍。

铁律:
1. 红色话题要庄重。
2. 绝对不胡编乱造，不知道就说不知道。
        `,
        inputAudioTranscription: {}, 
        outputAudioTranscription: {},
      },
    };

    try {
        this.sessionPromise = this.ai.live.connect(config);
        this.sessionPromise.catch(async (err) => {
          await this.handleSessionError(err, callbacks, modelName);
        });
    } catch (e) {
        await this.handleSessionError(e, callbacks, modelName);
    }
  }

  private async handleSessionError(error: any, callbacks: LiveServiceCallbacks, modelName: string) {
    console.error(`[LiveService] Protocol Error (${modelName}):`, error);
    this.cleanup();

    if (modelName === this.PRIMARY_MODEL && !this.hasAttemptedFallback) {
      this.hasAttemptedFallback = true;
      console.warn(`[LiveService] Falling back to stable model ${this.FALLBACK_MODEL}`);

      const audioReady = await this.initializeAudio(callbacks);
      if (!audioReady) return;

      await this.openSession(this.FALLBACK_MODEL, callbacks);
      return;
    }

    callbacks.onError(error instanceof Error ? error : new Error("Live session error"));
  }

  disconnect() {
    if (this.sessionPromise) {
      this.sessionPromise.then((session) => {
        session.close();
      }).catch(() => { /* Ignore errors during close */ });
      this.sessionPromise = null;
    }
    this.cleanup();
  }

  private cleanup() {
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    // Close AudioContexts to release hardware locks
    if (this.inputAudioContext && this.inputAudioContext.state !== 'closed') {
      this.inputAudioContext.close();
    }
    this.inputAudioContext = null;

    if (this.outputAudioContext && this.outputAudioContext.state !== 'closed') {
      this.outputAudioContext.close();
    }
    this.outputAudioContext = null;
  }

  private startAudioStreaming() {
    if (!this.inputAudioContext || !this.mediaStream) return;

    try {
        this.source = this.inputAudioContext.createMediaStreamSource(this.mediaStream);
        this.processor = this.inputAudioContext.createScriptProcessor(4096, 1, 1);

        this.processor.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0);
            // Convert to 16kHz PCM 16-bit
            const pcmBlob = createBlobFromFloat32(inputData, 16000);
            
            // Only send if session exists
            if (this.sessionPromise) {
                this.sessionPromise.then((session) => {
                    session.sendRealtimeInput({ media: pcmBlob });
                });
            }
        };

        this.source.connect(this.processor);
        this.processor.connect(this.inputAudioContext.destination);
    } catch (e) {
        console.error("[LiveService] Error starting audio stream", e);
    }
  }
}
