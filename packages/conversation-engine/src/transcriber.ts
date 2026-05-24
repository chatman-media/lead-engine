/**
 * Интерфейс для STT-транскрибации голосовых сообщений.
 * Pipeline инжектит реализацию через ProcessInboundDeps.transcriber.
 * Реализация живёт в apps/api (WhisperTranscriber).
 */
export interface ITranscriber {
  /**
   * Транскрибирует аудиофайл в текст.
   * @param audio  Raw bytes аудиофайла (OGG, MP3, WAV, …)
   * @param filename  Имя файла с расширением — провайдер определяет по нему формат
   * @returns Текст транскрипции, или null если транскрипция не удалась
   */
  transcribe(audio: Uint8Array, filename: string): Promise<string | null>;
}
