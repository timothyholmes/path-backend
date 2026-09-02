import { ReasonPhrases, StatusCodes } from 'http-status-codes';
import { ServerError } from './serverError';

export class PaymentRequired extends ServerError {
  constructor(message: string) {
    super(message, StatusCodes.PAYMENT_REQUIRED, ReasonPhrases.PAYMENT_REQUIRED);
  }
}
