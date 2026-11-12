import { BadRequestException } from '@nestjs/common';

import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';

import { IntegrationSettingsEntity } from '../entities/integration-settings.entity';
import { assertOnlyIntegrationSettingsFields } from '../integration-settings.controller';
import { IntegrationSettingsService } from '../services/integration-settings.service';
import { GetIntegrationSettingsUseCase } from './get-integration-settings.use-case';
import { UpdateIntegrationSettingsUseCase } from './update-integration-settings.use-case';

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
    webhooksEnabled,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as IntegrationSettingsEntity;
}

describe('configuración de integración', () => {
  let service: jest.Mocked<
    Pick<
      IntegrationSettingsService,
      'findByOrganization' | 'setWebhooksEnabled'
    >
  >;

  beforeEach(() => {
    service = {
      findByOrganization: jest.fn().mockResolvedValue(null),
      setWebhooksEnabled: jest.fn(),
    };
  });

  describe('GetIntegrationSettingsUseCase', () => {
    const useCase = () =>
      new GetIntegrationSettingsUseCase(
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

    it('devuelve sólo las opciones configurables de la fila guardada', async () => {
      service.findByOrganization.mockResolvedValue(settings(true));

      await expect(useCase().execute(apiClient)).resolves.toEqual({
        success: true,
        data: { webhooksEnabled: true },
      });
    });
  });

  describe('UpdateIntegrationSettingsUseCase', () => {
    const useCase = () =>
      new UpdateIntegrationSettingsUseCase(
        service as unknown as IntegrationSettingsService,
      );

    it.each([true, false])(
      'fija webhooksEnabled = %s en la organización de la llave',
      async (value) => {
        service.setWebhooksEnabled.mockResolvedValue(settings(value));

        await expect(
          useCase().execute(apiClient, { webhooksEnabled: value }),
        ).resolves.toEqual({ success: true, data: { webhooksEnabled: value } });
        expect(service.setWebhooksEnabled).toHaveBeenCalledWith('org-1', value);
      },
    );
  });

  describe('assertOnlyIntegrationSettingsFields', () => {
    it('acepta un cuerpo con sólo webhooksEnabled', () => {
      expect(() =>
        assertOnlyIntegrationSettingsFields({ webhooksEnabled: true }),
      ).not.toThrow();
    });

    it('rechaza una URL o un secreto, nombrando cada campo', () => {
      let error: unknown;
      try {
        assertOnlyIntegrationSettingsFields({
          webhooksEnabled: true,
          url: 'https://cliente.example/webhooks',
          secret: 'whsec_x',
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        message: ['El campo url no se admite', 'El campo secret no se admite'],
      });
    });
  });
});
