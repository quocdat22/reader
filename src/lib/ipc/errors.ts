import type { ErrorCode } from "./types";

const KNOWN_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "io",
  "unsupported_format",
  "password_protected",
  "invalid_document",
  "page_out_of_range",
  "document_not_found",
  "cancelled",
  "unsupported_uri",
  "internal",
]);

function toErrorCode(value: string): ErrorCode {
  return KNOWN_ERROR_CODES.has(value as ErrorCode)
    ? (value as ErrorCode)
    : "internal";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Structured error thrown by all {@link ReaderApi} methods.
 */
export class ReaderApiError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ReaderApiError";
    this.code = code;
  }
}

/**
 * Normalizes an arbitrary Tauri IPC rejection into a typed {@link ReaderApiError}.
 */
export function normalizeApiError(err: unknown): ReaderApiError {
  if (err instanceof ReaderApiError) {
    return err;
  }
  if (isRecord(err) && typeof err.code === "string") {
    const code = toErrorCode(err.code);
    const message =
      typeof err.message === "string" && err.message.length > 0
        ? err.message
        : err.code;
    return new ReaderApiError(code, message);
  }
  if (typeof err === "string") {
    return new ReaderApiError(
      "internal",
      err.length > 0 ? err : "Unexpected application error.",
    );
  }
  if (err instanceof Error) {
    return new ReaderApiError(
      "internal",
      err.message.length > 0 ? err.message : "Unexpected application error.",
    );
  }
  return new ReaderApiError("internal", "Unexpected application error.");
}

/**
 * Returns `true` when `err` represents a superseded/cancelled render request.
 */
export function isCancelledError(err: unknown): boolean {
  if (err instanceof ReaderApiError) {
    return err.code === "cancelled";
  }
  return isRecord(err) && err.code === "cancelled";
}
