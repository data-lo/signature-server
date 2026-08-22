/**
 * Rótulos legales por tipo de firma: el "Tipo de Firma" y el "Sustentada" que identifican en qué
 * se apoya jurídicamente cada firma.
 *
 * Viven aquí, y no dentro de cada servicio de hoja, porque desde la historia "Actualizar vista
 * pública de verificación de documentos según estado y tipo de firma" tienen DOS consumidores: la
 * hoja de evidencia que se anexa al PDF (`SummaryDocumentService` / `AdvancedSummaryDocumentService`)
 * y la vista pública de verificación (`DocumentService.getPublicDocumentView`). Es texto legal: que
 * la pantalla y el documento impreso digan exactamente lo mismo no es cosmético, y dos copias del
 * mismo párrafo terminan divergiendo en cuanto alguien corrige una.
 *
 * Los textos salen de las plantillas de referencia ("Firmalo Hoja de Firmas" y su equivalente de
 * firma avanzada) y se transcriben tal cual, acentuación incluida — `Firma Electronica Avanzada`
 * va sin acento en la plantilla y así se conserva.
 */

/** Firma simple: rótulo del mecanismo en la tabla de cada firmante. */
export const SIMPLE_SIGNATURE_TYPE_LABEL = 'Digital Simple';

/** Firma simple: fundamento legal (Arts. 89, 90 y 93 del Código de Comercio). */
export const SIMPLE_SIGNATURE_BACKING_LABEL =
  'Firma Electrónica Simple (Arts. 89, 90 y 93 del Código de Comercio)';

/** Firma avanzada (e.firma del SAT): rótulo del mecanismo en la tabla de cada firmante. */
export const ADVANCED_SIGNATURE_TYPE_LABEL = 'Firma Electronica Avanzada';

/** Firma avanzada: fundamento legal (Art. 97 del Código de Comercio). */
export const ADVANCED_SIGNATURE_BACKING_LABEL =
  'Certificado emitido por el Sistema de Administración Tributaria PSC (Art. 97 del Código de Comercio)';
