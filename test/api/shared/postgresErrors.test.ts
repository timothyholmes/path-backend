import { describe, expect, it } from 'vitest';
import {
  isCheckViolation,
  isForeignKeyViolation,
  isPostgresError,
  isUniqueViolation,
  parsePlanLimitError,
  PostgresError,
} from '../../../src/api/shared/postgresErrors';

function pgError(code: string, extra: Partial<PostgresError> = {}): PostgresError {
  const err = new Error('boom') as PostgresError;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

describe('isPostgresError', () => {
  it('is true for an Error with a string code', () => {
    expect(isPostgresError(pgError('23505'))).toBe(true);
  });

  it('is false for a plain Error', () => {
    expect(isPostgresError(new Error('boom'))).toBe(false);
  });

  it('is false for a non-Error value', () => {
    expect(isPostgresError('boom')).toBe(false);
    expect(isPostgresError(null)).toBe(false);
  });
});

describe('isUniqueViolation', () => {
  it('matches code 23505 regardless of constraint when none is given', () => {
    expect(isUniqueViolation(pgError('23505'))).toBe(true);
  });

  it('matches only the named constraint when one is given', () => {
    const err = pgError('23505', { constraint: 'routines_pkey' });
    expect(isUniqueViolation(err, 'routines_pkey')).toBe(true);
    expect(isUniqueViolation(err, 'other_constraint')).toBe(false);
  });

  it('is false for a different error code', () => {
    expect(isUniqueViolation(pgError('23503'))).toBe(false);
  });
});

describe('isForeignKeyViolation', () => {
  it('matches code 23503, optionally scoped to a constraint', () => {
    const err = pgError('23503', { constraint: 'routine_virtues_virtue_id_user_id_fkey' });
    expect(isForeignKeyViolation(err)).toBe(true);
    expect(isForeignKeyViolation(err, 'routine_virtues_virtue_id_user_id_fkey')).toBe(true);
    expect(isForeignKeyViolation(err, 'some_other_fkey')).toBe(false);
  });
});

describe('isCheckViolation', () => {
  it('matches code 23514, optionally scoped to a constraint', () => {
    const err = pgError('23514', { constraint: 'routines_scheduled_day_valid' });
    expect(isCheckViolation(err)).toBe(true);
    expect(isCheckViolation(err, 'routines_scheduled_day_valid')).toBe(true);
    expect(isCheckViolation(err, 'other_check')).toBe(false);
  });
});

describe('parsePlanLimitError', () => {
  it('parses the plan_limit_exceeded detail raised by enforce_plan_limit()', () => {
    const err = pgError('P0001', { detail: 'plan_limit_exceeded:routines:10' });
    expect(parsePlanLimitError(err)).toEqual({ table: 'routines', limit: 10 });
  });

  it('returns null for a P0001 raise with an unrelated detail', () => {
    const err = pgError('P0001', { detail: 'something_else' });
    expect(parsePlanLimitError(err)).toBeNull();
  });

  it('returns null for a P0001 raise with no detail', () => {
    expect(parsePlanLimitError(pgError('P0001'))).toBeNull();
  });

  it('returns null for a non-P0001 error', () => {
    const err = pgError('23505', { detail: 'plan_limit_exceeded:routines:10' });
    expect(parsePlanLimitError(err)).toBeNull();
  });

  it('returns null for a non-Postgres error', () => {
    expect(parsePlanLimitError(new Error('boom'))).toBeNull();
  });
});
