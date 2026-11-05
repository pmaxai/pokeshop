/** Error with an HTTP status and a stable code, rendered as JSON by the API layer. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;

  constructor(status: number, code: string, message?: string, fields?: Record<string, string>) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    if (fields) this.fields = fields;
  }

  toJSON() {
    return {
      error: this.code,
      ...(this.message !== this.code ? { message: this.message } : {}),
      ...(this.fields ? { fields: this.fields } : {}),
    };
  }
}

export const notFound = (what = 'product') => new ApiError(404, 'not_found', `${what} not found`);
