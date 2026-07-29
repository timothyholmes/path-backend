import { ReasonPhrases, StatusCodes } from 'http-status-codes';
import { ServerError } from './serverError';

export class Conflict extends ServerError {
  constructor(message: string) {
    super(message, StatusCodes.CONFLICT, ReasonPhrases.CONFLICT);
  }
}
