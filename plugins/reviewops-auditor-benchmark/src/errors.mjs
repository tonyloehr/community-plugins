// @ts-check

/**
 * A stable, sanitized failure that callers can safely expose to users.
 */
export class ReviewOpsError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{status?: "BLOCKED" | "ERROR" | "INSUFFICIENT_EVIDENCE", cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ReviewOpsError";
    this.code = code;
    this.status = options.status ?? "BLOCKED";
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {{status?: "BLOCKED" | "ERROR" | "INSUFFICIENT_EVIDENCE", cause?: unknown}} [options]
 * @returns {never}
 */
export function fail(code, message, options) {
  throw new ReviewOpsError(code, message, options);
}

/**
 * Converts an unexpected throwable into a stable error without reflecting its
 * message, stack, paths, or input values.
 *
 * @param {unknown} error
 * @returns {ReviewOpsError}
 */
export function asReviewOpsError(error) {
  if (error instanceof ReviewOpsError) {
    return error;
  }

  return new ReviewOpsError("RO_INTERNAL_ERROR", "Internal analysis failure.", {
    status: "ERROR",
    cause: error,
  });
}

/**
 * @param {unknown} error
 * @returns {{code: string, message: string, status: string}}
 */
export function publicError(error) {
  const safe = asReviewOpsError(error);
  return {
    code: safe.code,
    message: safe.message,
    status: safe.status,
  };
}
