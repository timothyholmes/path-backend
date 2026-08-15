import { describe, it, expect } from 'vitest';
import { StatusCodes, ReasonPhrases } from 'http-status-codes';
import { ServerError } from '../../src/errors/serverError';
import { BadRequest } from '../../src/errors/badRequest';
import { Conflict } from '../../src/errors/conflict';
import { NotFound } from '../../src/errors/notFound';
import { Unauthorized } from '../../src/errors/unauthorized';

describe('error classes', () => {
  it('ServerError defaults to 500 and wraps an original error', () => {
    const original = new Error('root cause');
    const err = new ServerError('boom', undefined, undefined, original);
    expect(err.code).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    expect(err.type).toBe(ReasonPhrases.INTERNAL_SERVER_ERROR);
    expect(err.originalError).toBe(original);
    expect(err.message).toBe('boom');
  });

  it.each([
    [BadRequest, StatusCodes.BAD_REQUEST, ReasonPhrases.BAD_REQUEST],
    [Unauthorized, StatusCodes.UNAUTHORIZED, ReasonPhrases.UNAUTHORIZED],
    [NotFound, StatusCodes.NOT_FOUND, ReasonPhrases.NOT_FOUND],
    [Conflict, StatusCodes.CONFLICT, ReasonPhrases.CONFLICT],
  ])('%s pins its status code and reason phrase', (Ctor, code, type) => {
    const err = new (Ctor as new (m: string) => ServerError)('nope');
    expect(err).toBeInstanceOf(ServerError);
    expect(err.code).toBe(code);
    expect(err.type).toBe(type);
    expect(err.message).toBe('nope');
  });
});
