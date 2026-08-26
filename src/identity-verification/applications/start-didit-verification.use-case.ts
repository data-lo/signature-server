import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { frontendBaseUrl } from 'src/shared/utils/frontend-url.util';
import { DiditApiService } from '../didit/didit-api.service';
import { IdentityVerificationEntity } from '../entities/identity-verification.entity';
import { IDENTITY_VERIFICATION_PROVIDER_ENUM } from '../enums/identity-verification-provider.enum';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from '../enums/identity-verification-status.enum';
import { CreateDiditSessionDto } from '../dto/create-didit-session.dto';
import {
  IdentityAlreadyVerifiedException,
  IdentityVerificationBlockedException,
} from '../exceptions/identity-verification.exceptions';
import { StartedVerification } from '../interfaces/started-verification.interface';
import { UpdateSigningCredentialStatusUseCase } from './update-signing-credential-status.use-case';
import { ValidateVerificationAttemptsUseCase } from './validate-verification-attempts.use-case';

const DEFAULT_RETURN_PATH = '/dashboard';

/** Estados en los que una sesión ya creada todavía sirve para continuar. */
const REUSABLE_STATUSES = [
  IDENTITY_VERIFICATION_STATUS_ENUM.PENDING,
  IDENTITY_VERIFICATION_STATUS_ENUM.IN_PROGRESS,
];

/**
 * Estados de la credencial en los que el usuario no puede abrir una sesión por su cuenta: se
 * agotaron sus intentos o hay un bloqueo definitivo. Se comprueba antes de gastar una llamada
 * a Didit.
 */
const BLOCKED_CREDENTIAL_STATUSES = [
  SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_FAILED,
  SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED,
];

/**
 * Arranca una verificación de identidad con Didit y devuelve la URL hospedada.
 *
 * Al frontend le llega únicamente esa URL, y su único uso allá es ser el contenido del código QR
 * con el que el usuario continúa en su celular: la pantalla ya no la muestra, no la enlaza y no
 * la copia. La API key y el `session_token` no salen del servidor.
 */
@Injectable()
export class StartDiditVerificationUseCase {
  private readonly logger = new Logger(StartDiditVerificationUseCase.name);

  constructor(
    @InjectRepository(IdentityVerificationEntity)
    private readonly identityVerificationRepository: Repository<IdentityVerificationEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly diditApiService: DiditApiService,
    private readonly validateVerificationAttempts: ValidateVerificationAttemptsUseCase,
    private readonly updateSigningCredentialStatus: UpdateSigningCredentialStatusUseCase,
  ) {}

  async execute(
    userId: string,
    dto: CreateDiditSessionDto,
  ): Promise<StartedVerification> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException(`Usuario con id ${userId} no encontrado`);
    }

    if (BLOCKED_CREDENTIAL_STATUSES.includes(user.signingCredentialStatus)) {
      throw new IdentityVerificationBlockedException();
    }

    const latest = await this.findLatest(userId);

    if (latest?.status === IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED) {
      throw new IdentityAlreadyVerifiedException();
    }

    const reusable = this.findReusableSession(latest);
    if (reusable) {
      /**
       * Cada sesión de Didit cuesta y consume cuota. Si el usuario recarga la pantalla, cambia
       * de la PC al celular o vuelve más tarde a un flujo que dejó a medias, se le devuelve la
       * misma URL en vez de abrir una sesión nueva por cada clic.
       */
      this.logger.log(
        `Reutilizando la sesión de Didit ${reusable.providerSessionId} del usuario ${userId}.`,
      );

      // Sólo por si el estado global quedó atrás respecto de la sesión abierta; si el usuario ya
      // está IN_PROGRESS, `applyIfAllowed` no lo hace retroceder.
      await this.updateSigningCredentialStatus.applyIfAllowed(
        userId,
        SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_PENDING,
      );

      return this.toStartedVerification(reusable, true);
    }

    // Antes de gastar una sesión nueva: si ya agotó el tope, esto lo deja en
    // MAX_ATTEMPTS_EXCEEDED y corta acá.
    await this.validateVerificationAttempts.execute(userId);

    // El intento se persiste ANTES de llamar a Didit: si el proveedor responde y el proceso se
    // cae justo después, el webhook igual tiene contra qué reconciliar el resultado.
    const attempt = await this.identityVerificationRepository.save(
      this.identityVerificationRepository.create({
        userId,
        provider: IDENTITY_VERIFICATION_PROVIDER_ENUM.DIDIT,
        status: IDENTITY_VERIFICATION_STATUS_ENUM.PENDING,
      }),
    );

    try {
      const session = await this.diditApiService.createSession(
        userId,
        this.buildCallbackUrl(dto.returnPath),
      );

      await this.identityVerificationRepository.update(attempt.id, {
        providerSessionId: session.sessionId,
        providerWorkflowId: session.workflowId,
        providerMetadata: { ...session.raw, hostedUrl: session.url },
        expiresAt: session.expiresAt,
        startedAt: new Date(),
      });

      /**
       * El estado global se mueve recién con la sesión ya creada: si Didit falla, el usuario se
       * queda donde estaba y puede reintentar, en vez de aparecer con una verificación
       * "pendiente" que nunca existió.
       *
       * `applyIfAllowed` y no `execute`: la sesión ya está abierta y cobrada, así que un estado
       * de origen inesperado se registra pero no tumba la respuesta.
       */
      await this.updateSigningCredentialStatus.applyIfAllowed(
        userId,
        SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_PENDING,
      );

      return this.toStartedVerification(
        await this.identityVerificationRepository.findOneBy({ id: attempt.id }),
        false,
      );
    } catch (error) {
      /**
       * El intento no se borra: queda en FAILED con el motivo. Un usuario que reporta "no me
       * deja verificar" deja rastro consultable, en vez de una tabla vacía que no explica nada.
       */
      await this.identityVerificationRepository.update(attempt.id, {
        status: IDENTITY_VERIFICATION_STATUS_ENUM.FAILED,
        failureReason:
          error instanceof Error ? error.message : 'Error desconocido',
        completedAt: new Date(),
      });

      throw error;
    }
  }

  private findLatest(
    userId: string,
  ): Promise<IdentityVerificationEntity | null> {
    return this.identityVerificationRepository.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Una sesión sólo se reutiliza si sigue abierta *y* vigente. Devolver una URL ya expirada
   * dejaría al usuario en una pantalla muerta de Didit sin forma de reintentar.
   */
  private findReusableSession(
    latest: IdentityVerificationEntity | null,
  ): IdentityVerificationEntity | null {
    if (!latest || !latest.providerSessionId) {
      return null;
    }

    if (!REUSABLE_STATUSES.includes(latest.status)) {
      return null;
    }

    const hostedUrl = latest.providerMetadata?.hostedUrl;
    if (typeof hostedUrl !== 'string' || !hostedUrl) {
      return null;
    }

    if (latest.expiresAt && latest.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    return latest;
  }

  /**
   * El callback es sólo navegación de regreso a la aplicación: NO determina que la identidad
   * fue aprobada. Quien decide es el webhook firmado por Didit. Un usuario que manipule esta
   * URL de retorno no consigue nada más que volver a otra pantalla.
   */
  private buildCallbackUrl(returnPath?: string): string {
    return `${frontendBaseUrl()}${returnPath ?? DEFAULT_RETURN_PATH}`;
  }

  private toStartedVerification(
    attempt: IdentityVerificationEntity,
    reused: boolean,
  ): StartedVerification {
    return {
      verificationId: attempt.id,
      provider: attempt.provider,
      status: attempt.status,
      sessionId: attempt.providerSessionId,
      url: attempt.providerMetadata?.hostedUrl as string,
      expiresAt: attempt.expiresAt,
      reused,
    };
  }
}
