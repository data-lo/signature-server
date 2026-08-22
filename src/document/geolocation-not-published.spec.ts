import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guardia de la historia "Ocultar geolocalización en hojas de firma y vistas públicas": la
 * ubicación del firmante se registra pero NO se publica.
 *
 * Por qué una prueba que lee el código fuente y no una que ejercita comportamiento. Las de
 * comportamiento ya existen y son las que valen —`summary-document.service.spec.ts` y
 * `advanced-summary-document.service.spec.ts` comprueban que la hoja no imprime el renglón, y
 * `signature-qr.service.spec.ts` decodifica el PNG con un escáner real—, pero solo cubren las
 * superficies que existen HOY en esta rama. El riesgo real es otro: cada feature vive en su propia
 * rama y todas se integran a `development`, así que una superficie de presentación escrita en
 * paralelo llega ya terminada, con el campo dentro, y ninguna prueba de esta rama la toca. Esta
 * guardia sí: al integrarse esa rama, el archivo nuevo entra a la lista y la prueba falla en el
 * merge, que es cuando alguien puede hacer algo al respecto.
 *
 * Caso concreto pendiente al escribir esto: `feat/signature-67` (vista pública de verificación)
 * agrega `geoLocation` a `PublicSignerData` en `interfaces/responses/` — este archivo lo detecta
 * en cuanto se integre. Ver la sección de pendientes del README.
 *
 * Deliberadamente NO cubre dónde el dato sí debe seguir vivo: la columna
 * `CollaboratorEntity.geoLoc`, el `GeolocationDto` que lo exige al firmar, la escritura en
 * `DocumentService.sign` y la cadena de auditoría.
 */

const DOCUMENT_DIR = join(__dirname);
const RESPONSES_DIR = join(DOCUMENT_DIR, 'interfaces', 'responses');

/**
 * Superficies que producen algo que un tercero ve: las dos hojas de evidencia que se anexan al
 * PDF, el QR que se estampa por cada firma avanzada, y TODOS los contratos de respuesta del módulo
 * — estos últimos se leen del directorio en vez de enumerarse para que un contrato nuevo quede
 * cubierto sin que nadie tenga que acordarse de agregarlo aquí.
 */
function presentationSources(): string[] {
  return [
    join(DOCUMENT_DIR, 'summary-document', 'summary-document.service.ts'),
    join(
      DOCUMENT_DIR,
      'summary-document',
      'advanced-summary-document.service.ts',
    ),
    join(DOCUMENT_DIR, 'services', 'signature-qr.service.ts'),
    ...readdirSync(RESPONSES_DIR)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => join(RESPONSES_DIR, file)),
  ];
}

/**
 * Quita comentarios antes de buscar: los docblocks de estos mismos archivos explican por qué la
 * geolocalización dejó de publicarse y mencionan `CollaboratorEntity.geoLoc`, que es exactamente
 * lo que se quiere poder seguir escribiendo. Lo que no debe aparecer es en el código ejecutable.
 *
 * El `[^:]` del segundo reemplazo evita comerse la parte de `https://` de una URL en una cadena.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('la geolocalización no se publica', () => {
  it.each(presentationSources())('%s no la expone', (file) => {
    const code = stripComments(readFileSync(file, 'utf-8'));

    // Una sola expresión cubre las tres formas en que el dato se colaba: el campo `geoLocation`
    // de un contrato, la etiqueta `Geo Loc` de las hojas y el renglón `Geolocalización:` del QR.
    //
    // El resultado se arma como texto legible —"línea 42: ..."— en vez de un booleano: cuando esto
    // falle será durante un merge, y el diff de jest tiene que decir en qué renglón quedó el dato
    // sin obligar a nadie a ir a buscarlo.
    const renglonesQuePublican = code
      .split('\n')
      .map((line, index) => `línea ${index + 1}: ${line.trim()}`)
      .filter((line) => /geo\s*loc/i.test(line));

    expect(renglonesQuePublican).toEqual([]);
  });
});
