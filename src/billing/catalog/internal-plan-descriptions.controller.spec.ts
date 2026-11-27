import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';

import { InternalPlatformApiKeyGuard } from 'src/auth/guards/internal-platform-api-key.guard';
import { IS_PUBLIC_KEY } from 'src/auth/decorators/public.decorator';

import { InternalPlanDescriptionsController } from './internal-plan-descriptions.controller';
import { UpdatePlanDescriptionsUseCase } from './update-plan-descriptions.use-case';

describe('InternalPlanDescriptionsController', () => {
  it('delega en el caso de uso y envuelve la respuesta', async () => {
    const data = {
      planType: 'premium',
      descriptions: ['Hasta 10 documentos'],
      updatedAt: new Date('2026-11-23T12:00:00.000Z'),
    };
    const useCase = { execute: jest.fn().mockResolvedValue(data) };
    const controller = new InternalPlanDescriptionsController(
      useCase as unknown as UpdatePlanDescriptionsUseCase,
    );

    const response = await controller.update('premium', {
      descriptions: ['Hasta 10 documentos'],
    });

    expect(useCase.execute).toHaveBeenCalledWith('premium', [
      'Hasta 10 documentos',
    ]);
    expect(response).toEqual({
      success: true,
      message: 'Descripciones del plan actualizadas correctamente',
      data,
    });
  });

  /**
   * Los planes son el catálogo de toda la plataforma: sólo la llave interna puede editarlos. Ni
   * `@Public()` (que aceptaría la `API_KEY` compartida de servicios) ni JWT de usuario.
   */
  it('sólo admite INTERNAL_PLATFORM_API_KEY', () => {
    const reflector = new Reflector();
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      InternalPlanDescriptionsController,
    );

    expect(guards).toContain(InternalPlatformApiKeyGuard);
    expect(
      reflector.get(IS_PUBLIC_KEY, InternalPlanDescriptionsController),
    ).toBeUndefined();
  });
});
