// Backwards-compat shim. До PR refactor/llm-router-absorb эти типы и
// `OpenAIChatClient` жили здесь напрямую; сейчас они переехали в
// `@chatman-media/llm-router`. Этот файл re-export'ит их, чтобы
// существующий код `import ... from "@chatman-media/rag"` продолжал
// работать без изменений.
//
// Новый код должен импортировать напрямую из `@chatman-media/llm-router`.
// Этот shim будет удалён в следующем PR (kb-rename), когда все consumers
// мигрируют.

export {
  ChatApiError,
  type ChatClient,
  type ChatCompletionOpts,
  type ChatMessage,
  type ChatRole,
  type FetchLike,
  OpenAIChatClient,
  type OpenAIChatOptions,
} from "@chatman-media/llm-router";
