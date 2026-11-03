# ClimaGo — servicio de alertas SMN

Worker de consulta para avisos oficiales del Servicio Meteorológico Nacional argentino (SMN), basado en el estándar CAP.

## Despliegue de diagnóstico en Cloudflare

El proyecto independiente de Cloudflare `climago-smn-diagnostico` está vinculado exclusivamente a la rama `diagnostico-alertas-smn-2026-11-03`. Los commits en esta rama inician sus compilaciones y despliegues; `main` permanece reservada para el Worker principal.

## Prueba acotada de conectividad SMN

Después de desplegar esta rama en Cloudflare Workers, abrir:

`https://<URL-DEL-WORKER>/?resource=smn-probe`

La prueba realiza únicamente dos solicitudes salientes:
1. Descarga el índice oficial `https://ssl.smn.gob.ar/CAP/AR.php`.
2. Extrae el primer enlace CAP XML y descarga solamente ese documento.

No recorre el listado completo ni intenta reintentos automáticos. Devuelve por separado:
- `feedHttpStatus`: respuesta del índice.
- `candidateUrlsFound`: enlaces CAP detectados.
- `capHttpStatus`: respuesta del XML de prueba.
- `infoBlocksFound` y `alertsParsed`: comprobación de lectura del estándar CAP.
- `retryAfter`: valor comunicado por el SMN, si responde HTTP 429.
- `stage`: indica si falló el índice, la extracción, la descarga o el análisis.

La prueba usa Córdoba como ubicación de comprobación. Se puede indicar otra ubicación con `&lat=-31.4&lon=-64.2`.

**Interpretación:** HTTP 200 con `ok: true` confirma que se pudo descargar y analizar un documento CAP. No demuestra que se hayan descargado todas las alertas vigentes ni que las alertas ya estén integradas en la aplicación. HTTP 429 confirma que el SMN limitó esa descarga.

## Consulta de alertas

`?resource=alerts&lat=-31.4&lon=-64.2`

La consulta de alertas de esta rama limita el procesamiento a un máximo de 12 documentos CAP por solicitud y los descarga de manera secuencial. Se detiene al primer HTTP 429. El índice del feed se guarda en la caché interna del Worker durante 120 segundos y cada XML CAP correcto durante 300 segundos; así, las consultas repetidas no vuelven a pedir los mismos archivos al SMN en el mismo punto de presencia. La ruta de diagnóstico `smn-probe` evita deliberadamente esa caché para comprobar la respuesta real.

Los resultados incluyen `dataStatus` y `coverageComplete`:
- `ok`: se procesaron todos los documentos encontrados.
- `partial`: se procesó solo una parte; no se debe interpretar una lista vacía como ausencia de alertas.
- `rate_limited`: el SMN respondió HTTP 429.
- `unavailable`: no se pudo obtener o analizar ningún documento.

La API usa HTTP 200 solo para cobertura completa, HTTP 206 para resultados parciales, HTTP 429 cuando el SMN limita las descargas y HTTP 503 cuando no se pudo obtener información utilizable.

## Otros recursos

- `?resource=health`: estado del Worker.
- `?resource=radar-snapshot&layer=radars`
- `?resource=radar-tile&layer=radars&snapshot=...&forecast=0&z=...&x=...&y=...`

## Configuración

El radar Rainbow requiere el secreto `RAINBOW_API_KEY`. No guardar claves privadas en este repositorio ni en `wrangler.toml`.

## Estado de esta rama

Rama de diagnóstico aislada: `diagnostico-alertas-smn-2026-11-03`. No modifica `main`, no despliega el Worker automáticamente y no activa las alertas dentro de la interfaz de ClimaGo.
