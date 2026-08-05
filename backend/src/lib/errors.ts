/**
 * `detail` is the error field the mobile client already reads, so every failure
 * response uses it.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (m: string, code?: string) => new ApiError(400, m, code);
export const unauthorized = (m = 'Not authenticated.') => new ApiError(401, m);
export const forbidden = (m = 'You do not have access to this.') => new ApiError(403, m);
export const notFound = (m = 'Not found.') => new ApiError(404, m);
export const conflict = (m: string, code?: string) => new ApiError(409, m, code);
export const tooManyRequests = (m = 'Too many attempts.') => new ApiError(429, m, 'RATE_LIMITED');
