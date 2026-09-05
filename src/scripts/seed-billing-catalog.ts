import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import { join } from 'path';
import Stripe = require('stripe');
import { DataSource } from 'typeorm';
import { CATALOG_ITEM_TYPE_ENUM } from '../billing/enums/catalog-item-type.enum';
import { CATALOG_SOURCE_ENUM } from '../billing/enums/catalog-source.enum';
import { PLAN_CREATION_SOURCE_ENUM } from '../billing/enums/plan-creation-source.enum';
import { CatalogItemEntity } from '../billing/catalog/catalog-item.entity';
import { PlanEntity } from '../billing/catalog/plan.entity';

const FREE_PLAN_TYPE = 'free';
const FREE_PLAN_DOCUMENTS_INCLUDED = 3;
const FREE_DOCUMENT_PRODUCT_NAME = 'Documento adicional para plan Free';
const FREE_DOCUMENT_PRICE_LOOKUP_KEY = 'document_credit_free_1_mxn';
const FREE_DOCUMENT_PRICE_AMOUNT = 3900;

/**
 * Crea los componentes mínimos del catálogo inicial:
 *
 * - El plan Free es local: no tiene producto ni precio de Stripe porque no se cobra.
 * - El documento adicional sí se crea en Stripe y se identifica como una compra única,
 *   exclusiva para el plan Free. El webhook `product.*`/`price.*` lo sincroniza al catálogo
 *   local como DOCUMENT_CREDIT + document_credit_pack + catalog_price.
 *
 * El lookup key del precio vuelve segura la segunda ejecución: nunca genera otro Price/Product.
 * No actualizamos recursos existentes de Stripe para no pisar cambios hechos en su dashboard.
 */
async function seedFreePlan(dataSource: DataSource): Promise<void> {
  const planRepository = dataSource.getRepository(PlanEntity);
  const catalogItemRepository = dataSource.getRepository(CatalogItemEntity);

  let plan = await planRepository.findOne({
    where: { planType: FREE_PLAN_TYPE },
  });

  if (plan) {
    console.log(`Plan local '${FREE_PLAN_TYPE}' ya existe.`);
    return;
  }

  const catalogItem = await catalogItemRepository.save(
    catalogItemRepository.create({
      itemType: CATALOG_ITEM_TYPE_ENUM.PLAN,
      source: CATALOG_SOURCE_ENUM.MANUAL,
      name: 'Free',
      isActive: true,
      stripeProductId: null,
    }),
  );

  plan = planRepository.create({
    planType: FREE_PLAN_TYPE,
    catalogItemId: catalogItem.id,
    name: 'Free',
    isActive: true,
    creationSource: PLAN_CREATION_SOURCE_ENUM.MANUAL,
    stripeProductId: null,
    documentsIncluded: FREE_PLAN_DOCUMENTS_INCLUDED,
  });
  await planRepository.save(plan);
  console.log(
    `Plan local '${FREE_PLAN_TYPE}' creado con ${FREE_PLAN_DOCUMENTS_INCLUDED} documentos incluidos.`,
  );
}

async function seedFreeDocumentProduct(stripe: Stripe): Promise<void> {
  const existingPrices = await stripe.prices.list({
    lookup_keys: [FREE_DOCUMENT_PRICE_LOOKUP_KEY],
    limit: 1,
  });

  if (existingPrices.data[0]) {
    console.log(
      `Precio Stripe ${existingPrices.data[0].id} ya existe (lookup_key=${FREE_DOCUMENT_PRICE_LOOKUP_KEY}).`,
    );
    return;
  }

  const product = await stripe.products.create({
    name: FREE_DOCUMENT_PRODUCT_NAME,
    active: true,
    metadata: {
      catalogType: 'document_pack',
      documentsGranted: '1',
      eligiblePlanType: FREE_PLAN_TYPE,
      visibility: 'true',
    },
  });

  const price = await stripe.prices.create({
    product: product.id,
    currency: 'mxn',
    unit_amount: FREE_DOCUMENT_PRICE_AMOUNT,
    lookup_key: FREE_DOCUMENT_PRICE_LOOKUP_KEY,
    metadata: {
      documentsGranted: '1',
      eligiblePlanType: FREE_PLAN_TYPE,
    },
  });

  console.log(
    `Producto Stripe ${product.id} y precio único ${price.id} creados: 1 documento por $39.00 MXN para '${FREE_PLAN_TYPE}'.`,
  );
  console.log(
    'Espera los webhooks product.created y price.created para que se sincronicen las tablas locales del catálogo.',
  );
}

async function main() {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    throw new Error('Falta STRIPE_SECRET_KEY para crear el producto en Stripe.');
  }
  if (!process.env.POSTGRES_DB_URL) {
    throw new Error('Falta POSTGRES_DB_URL para crear el plan Free local.');
  }

  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.POSTGRES_DB_URL,
    entities: [join(process.cwd(), 'dist', '**', '*.entity.js')],
    synchronize: false,
    logging: false,
  });

  await dataSource.initialize();
  try {
    await seedFreePlan(dataSource);
    await seedFreeDocumentProduct(new Stripe(stripeSecretKey));
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error('Error sembrando el catálogo Free:', error);
  process.exit(1);
});
