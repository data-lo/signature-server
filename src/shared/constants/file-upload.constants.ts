/**
 * Límites de tamaño de archivo, aplicados en dos capas:
 *
 * 1. `MAX_UPLOAD_SAFETY_NET_BYTES` en el `limits.fileSize` de cada interceptor de multer: un techo
 *    generoso que rechaza cualquier payload absurdo antes de que llegue a la aplicación.
 * 2. `MAX_IMAGE_FILE_SIZE_BYTES`/`MAX_PDF_FILE_SIZE_BYTES`: el límite real de negocio, verificado en
 *    el service correspondiente con un mensaje claro en español.
 *
 * Sin ellos, el 20MB/5MB que el usuario veía en el navegador era el único límite real y se saltaba
 * llamando la API directo.
 *
 * Son dos números y no uno porque una imagen de buena calidad —firma escaneada, foto de INE— pesa
 * mucho menos que un PDF escaneado de buena calidad, y un límite uniforme sería o muy laxo para
 * imágenes o muy estricto para PDFs.
 */
export const MAX_IMAGE_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
export const MAX_PDF_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB
export const MAX_UPLOAD_SAFETY_NET_BYTES = 25 * 1024 * 1024; // 25MB
/** .key/.cer de e.firma pesan típicamente unos pocos KB; 256KB es generoso sin abrir la puerta a abuso. */
export const MAX_EFIRMA_FILE_SIZE_BYTES = 256 * 1024; // 256KB
