/**
 * Límites de tamaño de archivo. Antes no existía ninguno del lado del backend — el 20MB/5MB
 * que el usuario veía en el navegador (FilePond, Zod) era el único límite real y se podía
 * saltar llamando la API directo. Estos valores se aplican en dos capas:
 *
 * 1. `MAX_UPLOAD_SAFETY_NET_BYTES` en el `limits.fileSize` de cada interceptor de multer — un
 *    techo generoso (por encima de ambos límites de negocio) que rechaza cualquier payload
 *    absurdo antes de que llegue a la aplicación.
 * 2. `MAX_IMAGE_FILE_SIZE_BYTES`/`MAX_PDF_FILE_SIZE_BYTES` — el límite real de negocio,
 *    verificado explícitamente en el service correspondiente con un mensaje claro en español.
 *
 * Dos números en vez de uno porque una imagen JPG/PNG de buena calidad (firma escaneada, foto
 * de INE) pesa mucho menos que un PDF escaneado de buena calidad (documento a firmar, INE en
 * PDF) — un solo límite uniforme sería o muy laxo para imágenes o muy estricto para PDFs.
 */
export const MAX_IMAGE_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
export const MAX_PDF_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB
export const MAX_UPLOAD_SAFETY_NET_BYTES = 25 * 1024 * 1024; // 25MB
