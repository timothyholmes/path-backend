import { ReasonPhrases, StatusCodes } from 'http-status-codes';
import { ServerError } from './serverError';

export class BadRequest extends ServerError {
  constructor(message: string) {
    super(message, StatusCodes.BAD_REQUEST, ReasonPhrases.BAD_REQUEST);
  }
}
