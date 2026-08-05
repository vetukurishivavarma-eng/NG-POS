import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

import { ApiError } from '../lib/errors.js';
import { env } from '../env.js';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ detail: `No route for ${req.method} ${req.path}` });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ detail: err.message, code: err.code });
  }

  if (err instanceof ZodError) {
    const first = err.issues[0];
    const field = first?.path.join('.') ?? 'request';
    return res.status(422).json({
      detail: `${field}: ${first?.message ?? 'Invalid value.'}`,
      errors: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = (err.meta?.target as string[] | undefined)?.join(', ') ?? 'value';
      return res.status(409).json({ detail: `That ${target} is already in use.` });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ detail: 'Not found.' });
    }
    if (err.code === 'P2003') {
      return res.status(400).json({ detail: 'Referenced record does not exist.' });
    }
  }

  console.error('[unhandled]', err);
  return res.status(500).json({
    detail: 'Something went wrong on the server.',
    ...(env.NODE_ENV === 'development' && err instanceof Error ? { debug: err.message } : {}),
  });
}

/** Wraps an async handler so rejected promises reach the error middleware. */
export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => unknown>(
  fn: T
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}
