import { expect, test } from "bun:test";
import { mutationFailure, parseFailureBody } from "./errors";

test("delivery uncertainty is retained and network loss never declares a safe retry", () => {
  expect(
    mutationFailure({
      error: "timeout",
      retry_safe: false,
      disposition: "still_in_flight",
    }),
  ).toEqual({ message: "timeout", uncertain: true, blocked: true });
  expect(
    mutationFailure({
      error: "invalid recipient",
      retry_safe: true,
      disposition: "not_started",
    }),
  ).toEqual({ message: "invalid recipient", uncertain: false, blocked: false });
  expect(mutationFailure(new TypeError("network lost")).uncertain).toBe(true);
});

test("HTTP validation errors remain readable and preserve retry information", () => {
  expect(
    parseFailureBody({ success: false, error: { message: "invalid query" } })
      .error,
  ).toBe("invalid query");
  expect(
    parseFailureBody({
      error: "uncertain",
      retry_safe: false,
      disposition: "may_have_completed",
    }),
  ).toEqual({
    error: "uncertain",
    retry_safe: false,
    disposition: "may_have_completed",
  });
});
