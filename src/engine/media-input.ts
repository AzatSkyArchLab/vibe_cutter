import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, type InputAudioTrack, type InputVideoTrack, VideoSampleSink } from 'mediabunny';

/**
 * Открытый исходник: один Input на файл и ленивые декодеры.
 * Один экземпляр живёт на всё время рендера или превью.
 */
export class MediaInput {
  readonly input: Input;
  private videoTrack?: Promise<InputVideoTrack | null>;
  private audioTrack?: Promise<InputAudioTrack | null>;
  private videoSink?: Promise<VideoSampleSink | null>;
  private audioSink?: Promise<AudioSampleSink | null>;

  constructor(readonly file: Blob) {
    this.input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  }

  video(): Promise<InputVideoTrack | null> {
    return (this.videoTrack ??= this.input.getPrimaryVideoTrack());
  }

  audio(): Promise<InputAudioTrack | null> {
    return (this.audioTrack ??= this.input.getPrimaryAudioTrack());
  }

  videoSamples(): Promise<VideoSampleSink | null> {
    return (this.videoSink ??= this.video().then((t) => (t ? new VideoSampleSink(t) : null)));
  }

  audioSamples(): Promise<AudioSampleSink | null> {
    return (this.audioSink ??= this.audio().then((t) => (t ? new AudioSampleSink(t) : null)));
  }

  dispose(): void {
    this.input.dispose();
  }
}

/** Набор открытых исходников по ключу; закрывается одним вызовом. */
export class MediaInputs<K> {
  private readonly open = new Map<K, MediaInput>();

  constructor(private readonly resolve: (key: K) => Blob) {}

  get(key: K): MediaInput {
    let m = this.open.get(key);
    if (!m) {
      m = new MediaInput(this.resolve(key));
      this.open.set(key, m);
    }
    return m;
  }

  dispose(): void {
    for (const m of this.open.values()) m.dispose();
    this.open.clear();
  }
}
