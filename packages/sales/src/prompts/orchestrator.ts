// Литеральные stall-реплики продавца в self-play: подмена ответа, когда reflect
// отклонил ungrounded-ответ. Потребитель: runSelfPlayMatch (src/self-play/orchestrator.ts).

export const SELF_PLAY_STALL_CTA_FALLBACK =
  "Давай созвонимся — так быстрее всё объясню. В какое время удобно? 😊";

export const SELF_PLAY_DEFAULT_STALL_REPLY =
  "Секунду, уточню детали и напишу — пара минут.";
