import { Module } from '@nestjs/common';
import { EfirmaService } from './efirma.service';

/**
 * Sin `EfirmaController`: `EfirmaService` se consume únicamente de forma interna (inyectado en
 * `DocumentModule`, ver historia "Integrar carga y validación de e.firma en el flujo de firma
 * avanzada") — no se expone como endpoint independiente. Antes existía `POST /efirma/sign` con
 * `@SkipJwtAuth()` (sin autenticación) desconectado del resto de la app; se eliminó por completo
 * en vez de solo deshabilitarlo.
 */
@Module({
  providers: [EfirmaService],
  exports: [EfirmaService],
})
export class EfirmaModule {}
