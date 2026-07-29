import { StatusCodes, ReasonPhrases } from 'http-status-codes';
import { ServerError } from './serverError';

export class NotFound extends ServerError {
  constructor(message: string) {
    super(message, StatusCodes.NOT_FOUND, ReasonPhrases.NOT_FOUND);
  }
}
