import { DECORATORS } from '@nestjs/swagger/dist/constants';

import {
  ProvisioningIdempotencyKeyRequiredException,
  ProvisioningReservedFieldsException,
} from './exceptions/platform-provisioning.exceptions';
import {
  assertNoReservedFields,
  InternalOrganizationProvisioningController,
  readProvisioningIdempotencyKey,
} from './internal-organization-provisioning.controller';

describe('InternalOrganizationProvisioningController', () => {
  const body = {
    organization: { name: 'Acme', organizationName: 'Acme S.A.' },
    owner: { firstName: 'Ana', lastName: 'López', email: 'ana@acme.test' },
    billing: {
      periodStart: '2026-11-01T00:00:00.000Z',
      periodEnd: '2027-11-01T00:00:00.000Z',
      externalReference: 'PROVISION-ACME-TEST-001',
    },
    apiKeyName: 'Integración',
  };

  function response() {
    return { status: jest.fn(), setHeader: jest.fn() };
  }

  it('no se publica en Swagger', () => {
    expect(
      Reflect.getMetadata(
        DECORATORS.API_EXCLUDE_CONTROLLER,
        InternalOrganizationProvisioningController,
      ),
    ).toEqual([true]);
  });

  it('responde 201 con la llave y marca que no es repetición', async () => {
    const execute = jest.fn().mockResolvedValue({
      success: true,
      message: 'ok',
      data: { replayed: false, apiKey: 'fma_live_x' },
    });
    const controller = new InternalOrganizationProvisioningController({
      execute,
    } as never);
    const res = response();

    await controller.provision(
      body as never,
      ' prov-acme-001 ',
      { body } as never,
      res as never,
    );

    expect(execute).toHaveBeenCalledWith({
      dto: body,
      idempotencyKey: 'prov-acme-001',
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.setHeader).toHaveBeenCalledWith('Idempotent-Replayed', 'false');
  });

  it('responde 200 al repetir la misma clave', async () => {
    const controller = new InternalOrganizationProvisioningController({
      execute: jest.fn().mockResolvedValue({
        success: true,
        message: 'ok',
        data: { replayed: true, apiKey: null },
      }),
    } as never);
    const res = response();

    await controller.provision(
      body as never,
      'prov-acme-001',
      { body } as never,
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith('Idempotent-Replayed', 'true');
  });

  describe('assertNoReservedFields', () => {
    it('acepta el body del contrato', () => {
      expect(() => assertNoReservedFields(body)).not.toThrow();
    });

    /** `whitelist` los descartaría en silencio y el operador creería haber elegido plan o permisos. */
    it('rechaza con 400 el plan, los permisos y el importe aunque vengan anidados', () => {
      let error: ProvisioningReservedFieldsException | undefined;
      try {
        assertNoReservedFields({
          ...body,
          planType: 'plus',
          permissionIds: ['perm-1'],
          owner: { ...body.owner, password: 'x' },
          billing: { ...body.billing, amount: 100, currency: 'usd' },
        });
      } catch (thrown) {
        error = thrown as ProvisioningReservedFieldsException;
      }

      expect(error).toBeInstanceOf(ProvisioningReservedFieldsException);
      expect((error!.getResponse() as { message: string }).message).toContain(
        'planType, permissionIds, owner.password, billing.amount, billing.currency',
      );
    });
  });

  describe('readProvisioningIdempotencyKey', () => {
    it.each([[undefined], [''], ['con espacios'], ['x'.repeat(256)]])(
      'rechaza %p con 400',
      (value) => {
        expect(() => readProvisioningIdempotencyKey(value)).toThrow(
          ProvisioningIdempotencyKeyRequiredException,
        );
      },
    );
  });
});
