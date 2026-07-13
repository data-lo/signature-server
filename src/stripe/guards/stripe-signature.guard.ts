import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import Stripe = require('stripe');
import { StripeService } from '../stripe.service';

@Injectable()
export class StripeSignatureGuard implements CanActivate {
  constructor(
    private readonly stripeService: StripeService,
    private readonly configService: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<RawBodyRequest<Request>>();
    const signature = request.headers['stripe-signature'];

    if (!signature || !request.rawBody) {
      throw new UnauthorizedException('Firma de Stripe requerida');
    }

    const webhookSecret = this.configService.get<string>(
      'STRIPE_WEBHOOK_SECRET',
    );

    try {
      const event = this.stripeService.client.webhooks.constructEvent(
        request.rawBody,
        signature,
        webhookSecret,
      );
      (
        request as RawBodyRequest<Request> & { stripeEvent: Stripe.Event }
      ).stripeEvent = event;
      return true;
    } catch {
      throw new UnauthorizedException('Firma de Stripe inválida');
    }
  }
}
