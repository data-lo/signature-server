import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    /**
     * La raíz dejó de devolver el "Hello World!" de la plantilla de Nest: ahora es la sonda de
     * estado de la API (`AppService.getHello`), con su versión y su mensaje.
     */
    it('devuelve el estado de la API', () => {
      expect(appController.getHello()).toEqual({
        status: 'online',
        message: 'API de la plataforma de Signature',
        version: '1.0.0',
      });
    });
  });
});
