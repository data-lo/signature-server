# Documentación de la API de integración

Sitio de [Mintlify](https://www.mintlify.com/docs) con las guías de la API de integración y su referencia técnica. Vive en `signature-server/docs` para que un cambio de contrato y su documentación entren en el mismo PR. Mintlify no publica este archivo.

```text
docs/
  docs.json              Configuración y navegación
  openapi.yaml           Contrato generado; no se edita a mano
  introduction.mdx
  authentication.mdx
  guides/
    getting-started.mdx
    errors.mdx
  logo/ y favicon.png    Marca, copiada de signature-site/public/brand
```

## Agregar una página

1. Crea el `.mdx` con `title` y `description` en el frontmatter.
2. Agrega su ruta, sin extensión, al grupo que corresponda en `navigation.groups` de `docs.json`.
3. Revísala en local.

En `.mdx`, escribe entre comillas invertidas todo lo que lleve `<` o `{`, como `fma_live_<publicId>_<secret>`: fuera de código se interpreta como JSX.

## Agregar o cambiar un endpoint

La referencia sale de `openapi.yaml`, y éste de los decoradores de Swagger del código (`src/document/integration/docs/`).

1. Cambia el controlador, el DTO o sus decoradores.
2. Ejecuta el generador. No necesita base de datos ni servicios:

   ```bash
   INTEGRATION_API_PUBLIC_URL=https://<host-de-la-api> npm run docs:openapi
   ```

3. Incluye `docs/openapi.yaml` en el PR.

Sin `INTEGRATION_API_PUBLIC_URL`, el archivo usa `https://api.firmalo.example` y el playground no podrá llamar a la API.

## Vista local

```bash
cd docs
npx mint dev        # http://localhost:3000; detén antes el backend, o usa --port
npx mint validate   # valida docs.json y el OpenAPI
```

## Conexión con Mintlify

Estos pasos se hacen una sola vez en el [panel de Mintlify](https://app.mintlify.com) y requieren permisos de administración en la organización `data-lo` de GitHub.

1. Crea el proyecto en Mintlify. El dominio temporal que asigna (`npx mint status` muestra la URL exacta) es el ambiente de pruebas.
2. Instala la GitHub App de Mintlify con acceso a `data-lo/signature-server`.
3. En **Git Settings**, elige el repositorio y la rama de despliegue.
4. En esa misma página, activa la opción de `docs.json` en un subdirectorio e indica `/docs`, sin barra final.
5. Guarda y comprueba que el despliegue termine bien en el panel.

### Previews por pull request

- Requieren plan **Pro o Enterprise**.
- Mintlify las genera para los PR que apuntan a su **rama de despliegue**. Como aquí los PR van a `development`, usa esa rama mientras el sitio sea de pruebas; con `main`, esos PR no tendrían preview automática.
- Con la GitHub App instalada, el bot agrega el enlace en el PR. Si falla, los registros están en la página **Previews** del panel.
- Las URLs de preview son públicas por defecto. Restringirlas a la organización requiere Enterprise, así que no publiques ahí contenido confidencial.
