export interface FormattedOpenError {
  readonly message: string;
  readonly canRemoveRecent: boolean;
}

export interface FormatErrorContext {
  readonly fromRecent?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Formats a backend error into plain, non-apologetic sentence-case copy (SPEC §5).
 */
export function formatOpenError(
  err: unknown,
  context: FormatErrorContext = {},
): FormattedOpenError {
  const code =
    isRecord(err) && typeof err.code === "string" ? err.code : "internal";
  const fromRecent = Boolean(context.fromRecent);

  switch (code) {
    case "io":
      return {
        message: fromRecent
          ? "File not found — it may have been moved or deleted."
          : "Could not read that file. Check that it exists and is accessible.",
        canRemoveRecent: fromRecent,
      };
    case "password_protected":
      return {
        message:
          "This PDF is password-protected. Protected documents are not supported.",
        canRemoveRecent: false,
      };
    case "unsupported_format":
      return {
        message: "Unsupported file type. Select a PDF document.",
        canRemoveRecent: fromRecent,
      };
    case "invalid_document":
      return {
        message:
          "Could not open this PDF. The file appears damaged or incomplete.",
        canRemoveRecent: fromRecent,
      };
    default: {
      const rawMsg =
        err instanceof Error
          ? err.message
          : isRecord(err) && typeof err.message === "string"
            ? err.message
            : "";
      return {
        message:
          rawMsg.trim().length > 0 ? rawMsg : "Could not open this document.",
        canRemoveRecent: false,
      };
    }
  }
}

/**
 * Formats an external link validation or launch failure into plain sentence-case copy.
 */
export function formatLinkError(err: unknown): string {
  const code =
    isRecord(err) && typeof err.code === "string" ? err.code : "internal";
  if (code === "unsupported_uri") {
    return "Cannot open this link. Only http, https, and mailto links are supported.";
  }

  const rawMsg =
    err instanceof Error
      ? err.message
      : isRecord(err) && typeof err.message === "string"
        ? err.message
        : "";
  return rawMsg.trim().length > 0 ? rawMsg : "Could not open external link.";
}
