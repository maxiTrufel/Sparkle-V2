# Migraciones

Cada archivo `.sql` de esta carpeta es un cambio de esquema. El runner
(`scripts/migrate.js`, `npm run migrate`) los aplica en orden alfabético y
registra cada uno en la tabla `schema_migrations`, así que **correrlo dos veces
no hace nada la segunda**. Por eso el deploy lo corre siempre, sin preguntarse
antes si hace falta.

```bash
npm run migrate     # producción y desarrollo: aplica lo que falte, nunca borra nada
npm run init-db     # SOLO desarrollo: dropea todo y vuelve a crear desde cero
```

`init-db.js` dropea las tablas y después llama a este mismo runner. El DDL está
definido en **un solo lugar** (`001_esquema_inicial.sql`): los dos caminos no se
pueden desincronizar.

---

## Las dos reglas que importan

### 1. Una migración, un cambio

**MariaDB no tiene DDL transaccional.** Un archivo con tres `ALTER TABLE` que
falla en el segundo deja la base a medio migrar, y no se deshace solo: hay que
entrar a mano y arreglarla. Como el archivo no queda registrado como aplicado,
el próximo `migrate` lo va a reintentar **entero** — incluido el `ALTER` que ya
había pasado, que ahora va a fallar por duplicado.

Archivos chicos. Si un cambio necesita tres pasos, son tres archivos.

### 2. Forward-only: no hay `down`

No hay reversión, a propósito. Revertir un deploy revierte el **código**, no el
esquema — `gh workflow run deploy.yml -f version=v0.1.0` levanta la imagen
anterior contra la base que ya migró.

La consecuencia práctica es que **toda migración tiene que ser compatible con la
versión anterior del código**:

| Querés | Hacelo así |
|---|---|
| Agregar una columna | Nullable o con `DEFAULT`, en un release. Empezar a escribirla en el siguiente. |
| Borrar una columna | Dejar de leerla en un release. Dropearla **un release después**. |
| Renombrar una columna | Agregar la nueva, escribir en las dos, migrar los datos, dejar de leer la vieja, dropearla. Cuatro releases, no uno. |
| Cambiar un tipo | Columna nueva + backfill + switch. Un `MODIFY COLUMN` sobre una tabla en uso bloquea escrituras mientras copia. |

La prueba mental antes de mergear: **si el deploy sale mal y hay que volver a la
versión anterior del código, ¿esa versión sigue funcionando contra esta base?**
Si la respuesta es no, la migración está mal partida.

---

## Cómo agregar una

1. Archivo nuevo, prefijo numérico de tres dígitos y un nombre que se entienda:
   `002_agregar_idioma_a_transcript_segments.sql`.
   El prefijo es lo que define el orden — **nunca** reutilices ni reordenes un
   número ya aplicado en algún lado.
2. Escribí el SQL. Comentá el *por qué*, no el *qué*: el `ALTER TABLE` ya dice
   qué hace.
3. Probala sobre una base descartable **antes** de commitearla:
   ```bash
   DB_NAME=sparkle_prueba npm run migrate
   DB_NAME=sparkle_prueba npm run migrate    # la segunda no debe hacer nada
   ```
4. Confirmá que `npm run init-db` sobre una base limpia sigue dejando el mismo
   esquema, y que la suite de tests pasa.
5. **Antes de desplegar una migración, backup.** Es el único momento del deploy
   que no es reversible con `docker compose up -d` de la imagen anterior.

## Qué NO va acá

- **Datos.** Estas migraciones son de esquema. Un `INSERT` de datos semilla que
  falle a mitad deja el mismo problema sin la excusa de que MariaDB no puede
  evitarlo.
- **`DROP TABLE` de algo con datos**, salvo que sea deliberado, esté hablado y
  haya un backup verificado de esa misma tarde.
- **Nada que dependa de un valor de `.env`.** El archivo tiene que producir el
  mismo esquema en la máquina de cualquiera y en el servidor.

## Si una migración se rompió a mitad

1. No vuelvas a correr `migrate` esperando que se arregle solo.
2. Mirá qué quedó realmente aplicado: `SHOW CREATE TABLE <tabla>`.
3. Deshacé a mano la parte que sí pasó, o completá a mano la que faltaba.
4. Si la completaste a mano, registrala para que el runner no la reintente:
   ```sql
   INSERT INTO schema_migrations (version) VALUES ('00N_lo_que_sea.sql');
   ```
5. Anotá en el archivo qué pasó. La próxima persona que lo lea vas a ser vos.
