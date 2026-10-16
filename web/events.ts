/**
 * Live updates from GET /api/events. EventSource natively handles
 * reconnection and resumes via Last-Event-ID (the server maps it to the
 * watch cursor), so there is no custom retry logic here. Server-sent
 * `event: error` frames surface through the same "error" listener as
 * connection drops — both just mean "not live until reopened".
 */
import type { ApiMessage } from "../server/payloads";

export interface EventsHandle {
  close(): void;
}

export function connectEvents(handlers: {
  onMessage: (message: ApiMessage) => void;
  onStateChange: (live: boolean) => void;
  onReset?: () => void;
}): EventsHandle {
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => handlers.onStateChange(true));
  source.addEventListener("error", () => handlers.onStateChange(false));
  source.addEventListener("reset", () => handlers.onReset?.());
  source.addEventListener("watch.overflow", () => {
    handlers.onStateChange(false);
    handlers.onReset?.();
  });
  source.addEventListener("message", (event) => {
    // receiving data proves the stream is live even if `open` was missed
    handlers.onStateChange(true);
    try {
      handlers.onMessage(JSON.parse(event.data as string) as ApiMessage);
    } catch {
      // ignore malformed frames
    }
  });
  return { close: () => source.close() };
}
