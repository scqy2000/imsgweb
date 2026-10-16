export interface FailureBody {
  error?: string;
  retry_safe?: boolean;
  disposition?: string;
  code?: number;
}
export function parseFailureBody(value: unknown): FailureBody {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const error = raw["error"];
  const detail =
    typeof error === "string"
      ? error
      : error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : undefined;
  return {
    ...(detail !== undefined ? { error: detail } : {}),
    ...(typeof raw["retry_safe"] === "boolean"
      ? { retry_safe: raw["retry_safe"] }
      : {}),
    ...(typeof raw["disposition"] === "string"
      ? { disposition: raw["disposition"] }
      : {}),
    ...(typeof raw["code"] === "number" ? { code: raw["code"] } : {}),
  };
}
export class ApiError extends Error {
  readonly body: FailureBody;
  readonly status: number;
  constructor(body: FailureBody, status: number) {
    super(body.error ?? `HTTP ${status}`);
    this.body = body;
    this.status = status;
  }
}
export function mutationFailure(error: unknown) {
  const body: FailureBody =
    error instanceof ApiError
      ? error.body
      : error !== null && typeof error === "object" && !(error instanceof Error)
        ? error
        : {};
  return {
    message:
      body.error ?? (error instanceof Error ? error.message : "操作失败"),
    uncertain:
      body.retry_safe === false ||
      body.disposition === "may_have_completed" ||
      body.disposition === "still_in_flight" ||
      (!(error instanceof ApiError) && error instanceof Error),
    blocked: body.disposition === "still_in_flight" || body.code === -32004,
  };
}
