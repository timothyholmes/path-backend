import { ReasonPhrases, StatusCodes } from 'http-status-codes';
import { ServerError } from './serverError';

export class Unauthorized extends ServerError {
  constructor(message: string) {
    super(message, StatusCodes.UNAUTHORIZED, ReasonPhrases.UNAUTHORIZED);
  }
}
