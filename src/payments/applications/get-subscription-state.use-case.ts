import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { AccountSubscriptionEntity } from '../entities/account-subscription.entity';
import { UserSubscriptionState } from '../interfaces/user-subscription-state.interface';

/**
 * Estado de la suscripción de la cuenta del usuario.
 *
 * No estaba en el alcance del rediseño del catálogo, pero su endpoint se movió de `/stripe` a
 * `/api/v1/payments`, así que su orquestación baja a un caso de uso como el resto: el controller
 * queda delgado y la regla de "qué cuenta factura" vive en un solo sitio.
 */
@Injectable()
export class GetSubscriptionStateUseCase {
  constructor(
    @InjectRepository(AccountSubscriptionEntity)
    private readonly subscriptionRepository: Repository<AccountSubscriptionEntity>,
    @InjectRepository(AccountEntity)
    private readonly accountRepository: Repository<AccountEntity>,
  ) {}

  async execute(userId: string): Promise<UserSubscriptionState> {
    const membership = await this.accountRepository.findOne({
      where: { userId, isActive: true },
    });

    if (!membership) {
      throw new NotFoundException(
        'El usuario no pertenece a ninguna cuenta activa',
      );
    }

    const subscription = await this.subscriptionRepository.findOne({
      where: { accountId: membership.id },
    });

    /**
     * Sin fila todavía no es un error: es una cuenta que nunca intentó pagar. Devolver el
     * estado "sin suscripción" evita que la pantalla tenga que distinguir entre 404 y
     * "no contratado".
     */
    if (!subscription) {
      return {
        hasActiveSubscription: false,
        planId: null,
        status: null,
        currentPeriodEnd: null,
      };
    }

    return {
      hasActiveSubscription: subscription.signingEnabled,
      planId: subscription.planId,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
    };
  }
}
