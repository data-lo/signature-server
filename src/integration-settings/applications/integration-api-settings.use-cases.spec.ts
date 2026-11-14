import { BadRequestException } from '@nestjs/common';

import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';

import { IntegrationSettingsEntity } from '../entities/integration-settings.entity';
import { INTEGRATION_STATUS_ENUM } from '../enums/integration-status.enum';
import { assertOnlyIntegrationApiSettingsFields } from '../integration-api-settings.controller';
import { IntegrationSettingsService } from '../services/integration-settings.service';
import { GetIntegrationApiSettingsUseCase } from './get-integration-api-settings.use-case';
import { UpdateIntegrationApiSettingsUseCase } from './update-integration-api-settings.use-case';

const apiClient = {
  apiKeyId: 'key-1',
  apiKeyName: 'Integración ERP',
  organizationId: 'org-1',
  actorAccountId: null,
  actorUserId: null,
  permissions: [],
} as IntegrationApiClient;

function settings(webhooksEnabled: boolean): IntegrationSettingsEntity {
  return {
    id: 'settings-1',
    organizationId: 'org-1',
    status: INTEGRATION_STATUS_ENUM.ACTIVE,
    webhooksEnabled,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as IntegrationSettingsEntity;
}

describe('configuración de integración desde la API de integración', () => {
  let service: jest.Mocked<
    Pick<
      IntegrationSettingsService,
      'findByOrganization' | 'setWebhooksEnabled' | 'setStatus'
    >
  >;

  beforeEach(() => {
    service = {
      findByOrganization: jest.fn().mockResolvedValue(null),
      setWebhooksEnabled: jest.fn(),
      setStatus: jest.fn(),
    };
  });

  describe('GetIntegrationApiSettingsUseCase', () => {
    const useCase = () =>
      new GetIntegrationApiSettingsUseCase(
        service as unknown as IntegrationSettingsService,
      );

    it('sin fila devuelve webhooksEnabled: false y no escribe', async () => {
      await expect(useCase().execute(apiClient)).resolves.toEqual({
        success: true,
        data: { webhooksEnabled: false },
      });
      expect(service.findByOrganization).toHaveBeenCalledWith('org-1');
      expect(service.setWebhooksEnabled).not.toHaveBeenCalled();
    });

    it('devuelve sólo las opciones configurables, sin el status administrativo', async () => {
      service.findByOrganization.mockResolvedValue(settings(true));

      await expect(useCase().execute(apiClient)).resolves.toEqual({
        success: true,
        data: { webhooksEnabled: true },
      });
    });
  });

  describe('UpdateIntegrationApiSettingsUseCase', () => {
    const useCase = () =>
      new UpdateIntegrationApiSettingsUseCase(
        service as unknown as IntegrationSettingsService,
      );

    it.each([true, false])(
      'fija webhooksEnabled = %s en la organización de la llave sin tocar el status',
      async (value) => {
        service.setWebhooksEnabled.mockResolvedValue(settings(value));

        await expect(
          useCase().execute(apiClient, { webhooksEnabled: value }),
        ).resolves.toEqual({ success: true, data: { webhooksEnabled: value } });
        expect(service.setWebhooksEnabled).toHaveBeenCalledWith('org-1', value);
        expect(service.setStatus).not.toHaveBeenCalled();
      },
    );
  });

  describe('assertOnlyIntegrationApiSettingsFields', () => {
    it('acepta un cuerpo con sólo webhooksEnabled', () => {
      expect(() =>
        assertOnlyIntegrationApiSettingsFields({ webhooksEnabled: true }),
      ).not.toThrow();
    });

    it('rechaza una URL, un secreto o un status, nombrando cada campo', () => {
      let error: unknown;
      try {
        assertOnlyIntegrationApiSettingsFields({
          webhooksEnabled: true,
          url: 'https://cliente.example/webhooks',
          secret: 'whsec_x',
          status: 'ACTIVE',
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        message: [
          'El campo url no se admite',
          'El campo secret no se admite',
          'El campo status no se admite',
        ],
      });
    });
  });
});
