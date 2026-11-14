# ClimaGo SMN Worker

Worker de ClimaGo para consultas oficiales del SMN (CAP), radar oficial y notificaciones Web Push.

## Recursos Cloudflare necesarios para activar Push

1. Crear un namespace KV:
   `npx wrangler kv namespace create ALERTS_KV`
2. Copiar el ID devuelto en `wrangler.toml`, descomentando el bloque `[[kv_namespaces]]`.
3. En el Worker, configurar estas variables:
   - `APP_ORIGIN`: origen exacto de la PWA publicada, sin barra final.
   - `VAPID_SERVER_PUBLIC_KEY`: clave pública VAPID correspondiente a la privada.
   - `VAPID_SUBJECT`: contacto VAPID; el proyecto propone `mailto:soporte@climago.app`, que debe reemplazarse por un contacto válido del propietario.
4. Cargar `VAPID_SERVER_PRIVATE_KEY` como Secret, nunca como variable pública ni dentro de Git:
   `npx wrangler secret put VAPID_SERVER_PRIVATE_KEY`
5. Instalar dependencias y desplegar:
   `npm install`
   `npx wrangler deploy`

El Cron Trigger configurado ejecuta `scheduled()` cada 10 minutos (UTC). El proceso agrupa suscripciones por coordenadas, consulta el catálogo CAP, y solo envía avisos cuando la descarga de todos los documentos descubiertos fue completa. Un endpoint 404/410 elimina la suscripción vencida. Los identificadores de avisos enviados se conservan en KV para evitar duplicados.

## Endpoints

- `GET /?resource=health`: diagnóstico de recursos configurados.
- `GET /?resource=push-public-key`: clave pública para que la PWA pueda suscribirse.
- `POST /?resource=subscribe`: guarda `{ subscription, lat, lon, locationName }`.
- `POST /?resource=unsubscribe`: elimina la suscripción por `{ endpoint }`.
- `GET /?resource=alerts&lat=...&lon=...`: consulta CAP por ubicación.
- `GET /?resource=radar-snapshot` y `radar-tile`: conservan la respuesta actual del visor oficial SMN.

Las rutas de suscripción requieren el encabezado `Origin` igual a `APP_ORIGIN`. El Worker no envía notificaciones hasta que KV, el origen y ambas claves VAPID estén configurados.

## Alcance actual

Este repositorio prepara el backend. La PWA todavía debe pedir permiso, ejecutar `PushManager.subscribe()`, enviar la suscripción y mostrar los eventos `push` en su Service Worker. Hasta completar esa parte no se puede hacer una prueba de entrega a un teléfono.
