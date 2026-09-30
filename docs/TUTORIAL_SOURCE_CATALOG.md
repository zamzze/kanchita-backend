# Tutorial Source Catalog Staging

## Objetivo

Importar el resultado consolidado de `authorized-tutorial-ingestor` sin mezclar todavía
URLs de iframe con la tabla productiva `streams`.

La capa mantiene dos conceptos:

- `source_catalog_items`: un registro por tutorial del catálogo.
- `source_catalog_servers`: candidatos iframe observados para ese tutorial.

El mapping hacia `movies` o `episodes` queda explícitamente pendiente mediante
`match_status = 'unmapped'`. Una reimportación no borra mappings ya realizados.

## Por qué no se usa streams directamente

`streams` exige un `content_type/content_id` local y su lifecycle actual trabaja con
streams directos/HLS validados. El dataset tutorial contiene candidatos embed antes de
haber resuelto de forma confiable qué película o episodio local corresponde a cada
tutorial.

## Migración

```powershell
cd C:\Proyectos\kanchita-backend
npm run migrate
```

## Auditoría del archivo antes de escribir

```powershell
npm run import:tutorial-sources -- `
  C:\Proyectos\authorized-tutorial-ingestor\data-private\tutorial-server-extraction-latest.json `
  --dry-run
```

Esperado para la captura consolidada actual:

- 17,933 items aceptados.
- 17,882 `ok`.
- 8 `no_servers`.
- 43 `not_found_404`.
- 36,314 servidores válidos.

## Importación

```powershell
$env:TUTORIAL_IMPORT_BATCH_SIZE="250"

npm run import:tutorial-sources -- `
  C:\Proyectos\authorized-tutorial-ingestor\data-private\tutorial-server-extraction-latest.json
```

El proceso no solicita las URLs iframe. Sólo lee el JSON local y escribe PostgreSQL.

## Idempotencia

Cada item usa `(provider_id, tutorial_url)` como identidad lógica. Los servidores usan
`(catalog_item_id, iframe_url)`.

Antes de reimportar un item se desactivan sus servidores previos y se reactivan/upsertean
los observados actualmente. Esto permite reflejar desapariciones sin duplicar filas.

## Próxima fase

Resolver el mapping:

```text
source_catalog_items.tutorial_url
        -> metadata de catálogo
        -> TMDB / movie / episode
        -> mapped_content_type + mapped_content_id
```

Sólo después del mapping el Resolver V2 debe consumir estos candidatos como estrategia
previa al fallback browser.
