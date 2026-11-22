# Modelos de detección de atención

Esta carpeta contiene los artefactos que la extensión carga en tiempo de ejecución para detectar
desatención a partir del video de la cámara. **Están versionados en el repositorio** — son 4,8 MB
y hacen que un checkout limpio pueda buildear sin pasos manuales.

Antes se ignoraban por ser binarios regenerables, pero eso rompía el build de CI de la peor
manera: la extensión compila y funciona igual, y la detección falla recién en tiempo de
ejecución. El script `scripts/copy-model-assets.js` avisa si falta alguno, pero el que más duele
—`preprocesamiento.json`— no rompe nada al faltar: simplemente alimenta al modelo con features
sin normalizar.

La tabla de abajo sigue siendo la referencia de **de dónde sale cada archivo**, para cuando haya
que regenerarlos desde el pipeline de entrenamiento.

## De dónde sale cada archivo

| Archivo | Tamaño aprox. | Origen |
| :--- | ---: | :--- |
| `preprocesamiento.json` | ~15 kB | `Sparkle_V2_Fase3_3_Modelo_Final.ipynb` |
| `cnn_extractor.tflite` | ~767 kB | `Sparkle_V2_Fase3_3_Modelo_Final.ipynb` |
| **`modelo_ensemble.json`** | **~48 kB** | **`exportar_ensemble_a_json.py`** (tras `Fase3_6f`) |
| `modelo_A_resumen_lineal.tflite` *(reserva)* | ~5 kB | `Sparkle_V2_Fase3_3_Modelo_Final.ipynb` |
| `modelo_B_tcn_fusion.tflite` *(opcional)* | ~70 kB | `Sparkle_V2_Fase3_3_Modelo_Final.ipynb` |
| `face_landmarker.task` | ~3,8 MB | MediaPipe (ver abajo) |

Los primeros salen de Google Drive: los de `Fase3_3` quedan en `SparkleV2/modelo_final/` y
`modelo_ensemble.json` en `SparkleV2/fase3_6_cierre/`. El de MediaPipe se descarga directo:

```bash
curl -L -o face_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task
```

## Sobre `modelo_ensemble.json` — la cabeza de decisión actual

Es el modelo **validado y el que usa el detector por defecto**. Son 8 regresiones logísticas
promediadas (776 parámetros) sobre el resumen temporal de la geometría más un bloque de 16
columnas de la salida del extractor. Va en JSON y no en TFLite a propósito: en texto plano es
auditable y se elimina el riesgo del orden de entradas/salidas de la conversión, que en este
proyecto ya causó dos errores silenciosos.

**No hace falta reexportar el extractor.** Los 8 bloques son slices de columnas 16j..16j+15 de
las 128 dimensiones que `cnn_extractor.tflite` ya produce.

Si falta el archivo, `detector.js` cae al modelo A y lo avisa por consola. En ese caso **la
abstención queda desactivada**: el margen de confianza está calibrado para el ensemble y con otro
modelo no daría la cobertura de 0,60 en la que se midió el resultado.

Rendimiento sobre la partición de prueba oficial, en ventanas de 50 s con abstención al 40 %:
**76,1 % de exactitud** (IC 95 % [69,3 – 81,9]) contra un trivial de 56,8 %. Ver
`Fase3_Registro_de_Resultados.md` §16 y `Ficha_Tecnica_Modelos.md` §11.

## Sobre `modelo_A_resumen_lineal.tflite` y `modelo_B_tcn_fusion.tflite`

El **modelo A** queda como reserva: es lo que se carga si falta el ensemble. Regresión logística
de 321 parámetros, 62,1 % de exactitud por clip aislado.

El **modelo B** es opcional y rinde menos (59,1 % contra 62,1 % por clip, sobre un trivial de
54,4 %).

El modelo B existe porque da dos salidas que el A no tiene: el **nivel ordinal** de tres grados
(atento / desatención leve / desatención marcada) y los **pesos de atención temporal**, que
permiten mostrar en qué momento de los 10 segundos se apoyó la predicción. Si en algún momento la
interfaz necesita esas dos cosas, hay que cargarlo en `detector.js` junto al A — los dos consumen
exactamente las mismas entradas, así que correr ambos cuesta muy poco.

## Por qué `preprocesamiento.json` es imprescindible

Contiene las medianas y los escaladores ajustados sobre el conjunto de entrenamiento. El modelo
espera entradas normalizadas con **esos** estadísticos exactos; alimentarlo con features crudas o
normalizadas de otra forma no produce ningún error, simplemente devuelve predicciones sin sentido.

`preprocessing.js` valida al cargarlo que el orden de las 22 features declarado en el JSON
coincida con el que produce `features.js`, y falla ruidosamente si no coinciden — es el tipo de
desfase que de otro modo pasaría desapercibido.

## Contrato de privacidad

Los tres modelos corren enteros en el dispositivo, dentro de un documento offscreen de la
extensión. Ni los cuadros de video ni los recortes del rostro se guardan ni se transmiten: existen
en memoria durante la inferencia de cada cuadro y se descartan. Lo único que sale del documento
offscreen es un número entre 0 y 1.
