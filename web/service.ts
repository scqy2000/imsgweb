import { auth } from "./auth.svelte";
import { ApiError, parseFailureBody, type FailureBody } from "./errors";
export { ApiError, mutationFailure } from "./errors";
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (response.status === 401) auth.required = true;
  if (!response.ok) {
    let body: FailureBody = {};
    try {
      body = parseFailureBody(await response.json());
    } catch {
      /* use HTTP status */
    }
    throw new ApiError(body, response.status);
  }
  return response.json() as Promise<T>;
}
