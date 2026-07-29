import { ReasonPhrases, StatusCodes } from 'http-status-codes';

export class ServerError extends Error {
  code: number;
  type: string;
  originalError?: Error;

  constructor(
    message: string,
    code: number = StatusCodes.INTERNAL_SERVER_ERROR,
    type: string = ReasonPhrases.INTERNAL_SERVER_ERROR,
    originalError?: Error,
  ) {
    super(message);
    this.code = code;
    this.type = type;
    this.originalError = originalError;
  }
}
