import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlanEntity } from './catalog/plan.entity';
import { PlanPriceEntity } from './catalog/plan-price.entity';
import { DocumentPackOfferEntity } from './catalog/document-pack-offer.entity';
import { CatalogSyncService } from './catalog/catalog-sync.service';

/**
 * Dominio de catálogo comercial. Primer módulo que usa las entidades de `billing/` —hasta ahora
 * sólo existían como modelo de datos, sin ningún consumidor—, así que registra únicamente las
 * tablas que hacen falta para que `CatalogSyncService` sincronice `plans`/`document_pack_offers`
 * con Stripe. Las demás entidades del directorio (perfiles de facturación, checkout, créditos)
 * todavía no tienen ningún caso de uso y se quedan fuera hasta que la funcionalidad que las
 * necesite las registre.
 *
 * `PlanPriceEntity` va aquí aunque `CatalogSyncService` no la use directamente: con
 * `autoLoadEntities: true` (ver `app.module.ts`), TypeORM sólo carga el metadata de una entidad
 * si algún `forFeature()` la registra — nada de que exista el archivo `.entity.ts` basta. La
 * relación `PlanEntity.prices` (`@OneToMany` hacia `PlanPriceEntity`) revienta al construir el
 * grafo de metadata si `PlanPriceEntity` no está cargada en algún lado, aunque nadie la inyecte.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PlanEntity, PlanPriceEntity, DocumentPackOfferEntity]),
  ],
  providers: [CatalogSyncService],
  exports: [CatalogSyncService],
})
export class BillingModule {}
