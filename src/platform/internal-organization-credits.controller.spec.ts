import { GUARDS_METADATA } from '@nestjs/common/constants';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { InternalPlatformApiKeyGuard } from 'src/auth/guards/internal-platform-api-key.guard';

import { MAX_CREDIT_GRANT_DOCUMENTS } from './constants/credit-grant.constants';
import { GrantOrganizationCreditsDto } from './dto/grant-organization-credits.dto';
import { ProvisioningIdempotencyKeyRequiredException } from './exceptions/platform.exceptions';
import { InternalOrganizationCreditsController } from './internal-organization-credits.controller';

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';

describe('InternalOrganizationCreditsController', () => {
  const dto = {
    documentsGranted: 500,
    externalReference: 'RECARGA-ACME-2026-001',
  } as GrantOrganizationCreditsDto;

  function response() {
    return { status: jest.fn(), setHeader: jest.fn() };
  }

  it('no se publica en Swagger', () => {
    expect(
      Reflect.getMetadata(
        DECORATORS.API_EXCLUDE_CONTROLLER,
        InternalOrganizationCreditsController,
      ),
    ).toEqual([true]);
  });

  it('sólo admite la llave interna de plataforma', () => {
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        InternalOrganizationCreditsController,
      ),
    ).toEqual([InternalPlatformApiKeyGuard]);
  });

  it('responde 201 en una recarga nueva y limpia la clave', async () => {
    const execute = jest.fn().mockResolvedValue({
      success: true,
      message: 'ok',
      data: { replayed: false },
    });
    const controller = new InternalOrganizationCreditsController({
      execute,
    } as never);
    const res = response();

    await controller.grant(
      ORGANIZATION_ID,
      dto,
      ' recarga-acme-001 ',
      res as never,
    );

    expect(execute).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      dto,
      idempotencyKey: 'recarga-acme-001',
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.setHeader).toHaveBeenCalledWith('Idempotent-Replayed', 'false');
  });

  it('responde 200 al repetir la misma clave', async () => {
    const controller = new InternalOrganizationCreditsController({
      execute: jest.fn().mockResolvedValue({
        success: true,
        message: 'ok',
        data: { replayed: true },
      }),
    } as never);
    const res = response();

    await controller.grant(
      ORGANIZATION_ID,
      dto,
      'recarga-acme-001',
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith('Idempotent-Replayed', 'true');
  });

  it('exige Idempotency-Key antes de llamar al caso de uso', async () => {
    const execute = jest.fn();
    const controller = new InternalOrganizationCreditsController({
      execute,
    } as never);

    await expect(
      controller.grant(ORGANIZATION_ID, dto, undefined, response() as never),
    ).rejects.toBeInstanceOf(ProvisioningIdempotencyKeyRequiredException);
    expect(execute).not.toHaveBeenCalled();
  });

  describe('GrantOrganizationCreditsDto', () => {
    async function invalidFields(body: Record<string, unknown>) {
      const errors = await validate(
        plainToInstance(GrantOrganizationCreditsDto, body),
      );
      return errors.map((error) => error.property);
    }

    it('acepta el contrato, con notas y sin ellas', async () => {
      expect(
        await invalidFields({ ...dto, notes: 'Autorizada por contrato' }),
      ).toEqual([]);
      expect(await invalidFields({ ...dto })).toEqual([]);
    });

    it.each([
      [0],
      [-1],
      [1.5],
      ['500'],
      [null],
      [undefined],
      [MAX_CREDIT_GRANT_DOCUMENTS + 1],
    ])('rechaza documentsGranted = %p', async (documentsGranted) => {
      expect(await invalidFields({ ...dto, documentsGranted })).toEqual([
        'documentsGranted',
      ]);
    });

    it('acepta el tope de documentos', async () => {
      expect(
        await invalidFields({
          ...dto,
          documentsGranted: MAX_CREDIT_GRANT_DOCUMENTS,
        }),
      ).toEqual([]);
    });

    it.each([[undefined], ['   '], ['x'.repeat(256)]])(
      'rechaza externalReference = %p',
      async (externalReference) => {
        expect(await invalidFields({ ...dto, externalReference })).toEqual([
          'externalReference',
        ]);
      },
    );
  });
});
