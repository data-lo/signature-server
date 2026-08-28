import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { RedisService } from 'src/shared/redis/redis.service';
import {
  UpdateSigningCredentialStatusUseCase,
  canTransitionSigningCredentialStatus,
} from './update-signing-credential-status.use-case';

const USER_ID = 'user-1';
const CURP = 'CURP0000000000AB';
const S = SIGNING_CREDENTIAL_STATUS_ENUM;

describe('UpdateSigningCredentialStatusUseCase', () => {
  let useCase: UpdateSigningCredentialStatusUseCase;
  let userRepository: { findOne: jest.Mock; update: jest.Mock };
  let redisService: { del: jest.Mock };

  function givenUserAt(status: SIGNING_CREDENTIAL_STATUS_ENUM): void {
    userRepository.findOne.mockResolvedValue({
      id: USER_ID,
      nationalId: CURP,
      signingCredentialStatus: status,
    });
  }

  beforeEach(async () => {
    userRepository = { findOne: jest.fn(), update: jest.fn() };
    redisService = { del: jest.fn().mockResolvedValue(1) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UpdateSigningCredentialStatusUseCase,
        { provide: getRepositoryToken(UserEntity), useValue: userRepository },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    useCase = module.get(UpdateSigningCredentialStatusUseCase);
  });

  describe('transiciones permitidas', () => {
    it.each([
      [
        'inicia la verificación',
        S.IDENTITY_VERIFICATION_REQUIRED,
        S.IDENTITY_VERIFICATION_PENDING,
      ],
      [
        'Didit inicia el flujo',
        S.IDENTITY_VERIFICATION_PENDING,
        S.IDENTITY_VERIFICATION_IN_PROGRESS,
      ],
      [
        'Didit pide revisión',
        S.IDENTITY_VERIFICATION_IN_PROGRESS,
        S.IDENTITY_VERIFICATION_IN_REVIEW,
      ],
      [
        'Didit aprueba',
        S.IDENTITY_VERIFICATION_IN_PROGRESS,
        S.SIGNATURE_PENDING,
      ],
      [
        'aprueba desde revisión',
        S.IDENTITY_VERIFICATION_IN_REVIEW,
        S.SIGNATURE_PENDING,
      ],
      [
        'Didit rechaza',
        S.IDENTITY_VERIFICATION_IN_PROGRESS,
        S.IDENTITY_VERIFICATION_RETRY_REQUIRED,
      ],
      [
        'reintenta tras el rechazo',
        S.IDENTITY_VERIFICATION_RETRY_REQUIRED,
        S.IDENTITY_VERIFICATION_PENDING,
      ],
      ['sube la firma PNG', S.SIGNATURE_PENDING, S.CONFIGURED],
      ['elimina la firma PNG', S.CONFIGURED, S.SIGNATURE_PENDING],
      [
        'agota los intentos',
        S.IDENTITY_VERIFICATION_RETRY_REQUIRED,
        S.IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED,
      ],
      /**
       * Didit aprueba DESPUÉS de haber reportado la sesión como expirada o abandonada, que es lo
       * que deja al usuario en RETRY_REQUIRED. Sin estas dos salidas el intento quedaba aprobado
       * y el estatus del usuario no se movía.
       */
      /**
       * Los dos pasos con los que una aprobación alcanza CONFIGURED en quien ya tenía su rúbrica
       * (ver `applyApproval`). Se recorren por separado justamente porque el salto directo no es
       * —ni debe ser— una arista válida: ver "transiciones bloqueadas".
       */
      [
        'aprueba la identidad de quien ya tenía rúbrica (paso 1)',
        S.IDENTITY_VERIFICATION_IN_PROGRESS,
        S.SIGNATURE_PENDING,
      ],
      ['y completa la credencial (paso 2)', S.SIGNATURE_PENDING, S.CONFIGURED],
      ['bloqueo administrativo', S.CONFIGURED, S.IDENTITY_VERIFICATION_FAILED],
    ])('%s: %s → %s', async (_caso, from, to) => {
      givenUserAt(from);

      await expect(useCase.execute(USER_ID, to)).resolves.toBe(to);

      expect(userRepository.update).toHaveBeenCalledWith(USER_ID, {
        signingCredentialStatus: to,
      });
    });
  });

  describe('transiciones bloqueadas', () => {
    it.each([
      [
        'no se salta la verificación',
        S.IDENTITY_VERIFICATION_REQUIRED,
        S.CONFIGURED,
      ],
      [
        'no se firma sin identidad aprobada',
        S.IDENTITY_VERIFICATION_REQUIRED,
        S.SIGNATURE_PENDING,
      ],
      [
        'no se retrocede de aprobado a en curso',
        S.SIGNATURE_PENDING,
        S.IDENTITY_VERIFICATION_IN_PROGRESS,
      ],
      [
        'no se retrocede de en curso a pendiente',
        S.IDENTITY_VERIFICATION_IN_PROGRESS,
        S.IDENTITY_VERIFICATION_PENDING,
      ],
      /**
       * Ninguna de estas puede abrirse para que una aprobación llegue a CONFIGURED de un salto:
       * `UpdateSignatureUseCase` pide CONFIGURED al reponer la rúbrica SIN comprobar la
       * identidad, así que la arista le daría credencial completa a quien no la tiene aprobada.
       * La aprobación llega a CONFIGURED recorriendo SIGNATURE_PENDING (ver `applyApproval`).
       */
      [
        'no se configura sin identidad aprobada, desde revisión',
        S.IDENTITY_VERIFICATION_IN_REVIEW,
        S.CONFIGURED,
      ],
      [
        'no se configura sin identidad aprobada, en curso',
        S.IDENTITY_VERIFICATION_IN_PROGRESS,
        S.CONFIGURED,
      ],
      [
        'no se configura sin identidad aprobada, tras un rechazo',
        S.IDENTITY_VERIFICATION_RETRY_REQUIRED,
        S.CONFIGURED,
      ],
      [
        'el bloqueo definitivo no se levanta solo',
        S.IDENTITY_VERIFICATION_FAILED,
        S.IDENTITY_VERIFICATION_PENDING,
      ],
      [
        'agotar intentos no se revierte solo',
        S.IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED,
        S.IDENTITY_VERIFICATION_PENDING,
      ],
    ])('%s: %s ✗ %s', async (_caso, from, to) => {
      givenUserAt(from);

      await expect(useCase.execute(USER_ID, to)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(userRepository.update).not.toHaveBeenCalled();
    });
  });

  it('quedarse en el mismo estado es un no-op, no un error', async () => {
    givenUserAt(S.SIGNATURE_PENDING);

    await expect(useCase.execute(USER_ID, S.SIGNATURE_PENDING)).resolves.toBe(
      S.SIGNATURE_PENDING,
    );

    expect(userRepository.update).not.toHaveBeenCalled();
    expect(redisService.del).not.toHaveBeenCalled();
  });

  it('lanza 404 si el usuario no existe', async () => {
    userRepository.findOne.mockResolvedValue(null);

    await expect(
      useCase.execute(USER_ID, S.IDENTITY_VERIFICATION_PENDING),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('applyIfAllowed', () => {
    it('aplica la transición posible', async () => {
      givenUserAt(S.SIGNATURE_PENDING);

      await expect(useCase.applyIfAllowed(USER_ID, S.CONFIGURED)).resolves.toBe(
        true,
      );

      expect(userRepository.update).toHaveBeenCalledWith(USER_ID, {
        signingCredentialStatus: S.CONFIGURED,
      });
    });

    it('ignora la imposible sin fallar: un webhook fuera de orden no puede tumbar la entrega', async () => {
      givenUserAt(S.CONFIGURED);

      await expect(
        useCase.applyIfAllowed(USER_ID, S.IDENTITY_VERIFICATION_IN_PROGRESS),
      ).resolves.toBe(false);

      expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('no falla si el usuario no existe', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(useCase.applyIfAllowed(USER_ID, S.CONFIGURED)).resolves.toBe(
        false,
      );
    });
  });

  describe('cache de perfil', () => {
    it('invalida el snapshot para que /users/me no quede obsoleto', async () => {
      givenUserAt(S.SIGNATURE_PENDING);

      await useCase.execute(USER_ID, S.CONFIGURED);

      expect(redisService.del).toHaveBeenCalledWith(CURP);
    });

    it('no tumba la operación si Redis falla', async () => {
      givenUserAt(S.SIGNATURE_PENDING);
      redisService.del.mockRejectedValue(new Error('Redis caído'));

      await expect(useCase.execute(USER_ID, S.CONFIGURED)).resolves.toBe(
        S.CONFIGURED,
      );
      expect(userRepository.update).toHaveBeenCalled();
    });
  });

  /**
   * La tabla es lo que hace verificable el flujo completo: si alguien agrega un estado y olvida
   * conectarlo, acá se ve como un estado inalcanzable.
   */
  it('todo estado distinto del inicial es alcanzable desde algún otro', () => {
    const alcanzables = Object.values(SIGNING_CREDENTIAL_STATUS_ENUM).filter(
      (destino) =>
        destino !== S.IDENTITY_VERIFICATION_REQUIRED &&
        Object.values(SIGNING_CREDENTIAL_STATUS_ENUM).some(
          (origen) =>
            origen !== destino &&
            canTransitionSigningCredentialStatus(origen, destino),
        ),
    );

    expect(alcanzables).toHaveLength(
      Object.values(SIGNING_CREDENTIAL_STATUS_ENUM).length - 1,
    );
  });
});
