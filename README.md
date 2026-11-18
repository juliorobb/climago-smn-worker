# ClimaGo SMN Worker

Worker de ClimaGo para consultas oficiales del SMN (CAP), radar oficial y notificaciones Web Push.

## Recursos Cloudflare necesarios para activar Push

1. `wrangler.toml` ya declara los bindings KV de producción y vista previa. Antes de desplegar, confirmar en Cloudflare que los IDs configurados existen y pertenecen a este proyecto; no crear ni reemplazar namespaces a ciegas.
2. En el entorno de producción del Worker, configurar:
   - `APP_ORIGIN`: origen canónico exacto de la PWA publicada, sin barra final.
   - `VAPID_SERVER_PUBLIC_KEY`: clave pública correspondiente a la privada.
   - `VAPID_SUBJECT`: contacto VAPID válido del propietario.
3. Cargar `VAPID_SERVER_PRIVATE_KEY` como Secret, nunca como variable pública ni dentro de Git:
   `npx wrangler secret put VAPID_SERVER_PRIVATE_KEY`
4. Instalar dependencias y validar:
   `npm install`
   `npm run check`
   `npx wrangler deploy --dry-run`
5. Desplegar solo después de confirmar los bindings, el origen y ambas claves VAPID:
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

La integración de la PWA para pedir permiso, ejecutar `PushManager.subscribe()`, registrar la suscripción y mostrar eventos `push` está implementada en la rama de validación del repositorio `juliorobb/Climago`, PR #14. Ambos PR siguen sin fusionar. La entrega real a un teléfono continúa pendiente hasta desplegar el Worker con sus variables y secretos correctos y completar una prueba de extremo a extremo en Android.
