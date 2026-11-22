# Sparkle V2: código del modelo de detección de atención

Proyecto Final de Ingeniería en Informática, UADE, 2026.
Isola, Francisco · Trufelman, Máximo Elian. Tutora: Cuadrado Estrebou, María Fernanda.

Esta carpeta contiene el código con el que se entrenó y validó el módulo de detección de atención
que describe la sección 3.7 de la tesis:

1. la extracción de características de DAiSEE (secciones 3.7.1 y 3.7.2);
2. el entrenamiento del clasificador estadístico, el ensamble de ocho regresiones logísticas con
   abstención, y de los modelos con los que se lo comparó (secciones 3.7.3 y 3.7.4);
3. la validación de las reglas geométricas y del puntaje de cara con conjuntos de datos públicos
   (secciones 3.7.5 y 3.7.6).

El modelo ya entrenado y su uso dentro de la extensión están en este mismo repositorio
(`frontend/public/models/` y `frontend/src/offscreen/`). Esta carpeta incluye además la versión del
código de la extensión con la que se hicieron las mediciones de la validación (ver
[«Código de la extensión medido»](#4-código-de-la-extensión-medido)).

## En resumen

- **Qué se necesita.** Los notebooks de extracción y entrenamiento se ejecutaron en Google Colab,
  con GPU T4. Los scripts de validación se ejecutaron en una computadora local con Python 3.13, y
  los que comparan con la extensión necesitan además Node.js 22. Las librerías y sus versiones
  están en `requirements.txt`.
- **Qué datos se necesitan.** Cada conjunto de datos se pide o se descarga de su sitio oficial
  (ver [«Conjuntos de datos»](#conjuntos-de-datos)). Ninguno viene en esta carpeta.
- **Por dónde empezar.** El orden que produce el modelo final está en
  [«Ensamble final con abstención»](#ensamble-final-con-abstención), y el de la validación, en
  [«Validación de la capa geométrica»](#3-validación-de-la-capa-geométrica).

## Lo que no incluye esta carpeta

- **Videos e imágenes** de ningún conjunto de datos. Las licencias prohíben redistribuirlos.
- **Las características extraídas de DAiSEE**, por la misma razón: derivan de sus videos. Sí se
  incluyen las listas de identificadores de fragmentos utilizados (ver
  [«Verificación del conjunto DAiSEE»](#5-verificación-del-conjunto-daisee)), que no contienen datos
  de los videos.
- **El archivo de referencia de la prueba de equivalencia de las reglas**
  (`reglas_referencia.json`), porque contiene la orientación de la cabeza y la apertura de los ojos
  medidas sobre 400 ventanas de DAiSEE (ver
  [«Código de la extensión medido»](#4-código-de-la-extensión-medido)).
- **Las etiquetas originales de EngageNet**. Su licencia prohíbe redistribuirlas en cualquier forma.
  Los scripts las leen desde una ruta local indicada por el usuario.
- **Las salidas de los notebooks**, que se vaciaron antes de entregarlos.
- **Los resultados de las mediciones** (CSV y JSON). Las cifras están en la tesis.
- **Los protocolos y prerregistros de cada medición.** Algunos comentarios del código los citan
  por nombre, pero no forman parte de esta entrega.

Para ejecutar el código hay que obtener cada conjunto de datos de su fuente oficial, bajo su propia
licencia. La tesis detalla las condiciones de cada uno en la sección 3.9.2, «Propiedad intelectual y
licencias».

## Conjuntos de datos

| Conjunto | Para qué se usa | Dónde se pide o se descarga |
|---|---|---|
| DAiSEE | Entrenamiento y evaluación del clasificador | https://people.iith.ac.in/vineethnb/resources/daisee/index.html |
| ImageNet | Pesos iniciales del extractor de apariencia (los descarga Keras) | https://www.image-net.org/ |
| FER2013 | Ajuste del extractor de apariencia | https://www.kaggle.com/datasets/msambare/fer2013 |
| BIWI Kinect Head Pose | Orientación de la cabeza y puntaje de cara | https://huggingface.co/datasets/ETHZurich/biwi_kinect_head_pose |
| AFLW2000-3D | Error de la orientación de la cabeza | https://www.tensorflow.org/datasets/catalog/aflw2k3d |
| EngageNet | Estudiantes en aprendizaje en línea | https://github.com/engagenet/engagenet_baselines |
| UTA-RLDD | Somnolencia | https://sites.google.com/view/utarldd/home |
| NTHU-DDD | Mirada al costado y ojos somnolientos | http://cv.cs.nthu.edu.tw/php/callforpaper/datasets/DDD/ |
| Columbia Gaze | Cabeza y mirada en ángulos conocidos | https://www.cs.columbia.edu/CAVE/databases/columbia_gaze/ |
| Eyeblink8 | Parpadeos | https://www.blinkingmatters.com/research |
| MPIIFaceGaze | Conversión de la mirada a grados y regla R4 | https://www.mpi-inf.mpg.de/departments/computer-vision-and-machine-learning/research/gaze-based-human-computer-interaction/its-written-all-over-your-face-full-face-appearance-based-gaze-estimation |

## Organización

```
Fase 1/                         Extracción de características de DAiSEE y primeros modelos secuenciales
Fase 3/                         Apariencia, comparación de modelos y ensamble final con abstención
Fase 4/                         Validación de la capa geométrica con conjuntos públicos
  analisis/                     Scripts de medición, uno o más por conjunto de datos
extension_medida/               Código de la extensión tal como se midió (commit b556d66)
herramientas/verificar_daisee/  Listas de fragmentos de DAiSEE y scripts de verificación
requirements.txt                Librerías y versiones
```

Ninguna ruta apunta a una computadora en particular. Los scripts reciben las rutas a los datos por
variables de entorno o argumentos (ver [«Parámetros»](#parámetros)); si no se indican, usan rutas
relativas genéricas como `datasets/<Conjunto>/`. Las únicas rutas fijas son las de Google Colab
(`/content/...`), en los notebooks que solo corren ahí.

## 1. Extracción de características de DAiSEE

Los notebooks se ejecutaron en Google Colab y guardan sus resultados en una carpeta de proyecto
(`PROJECT_DIR`, por defecto `MyDrive/SparkleV2`). Los de `Fase 3/` también corren fuera de Colab:
la carpeta se indica con la variable `SPARKLE_PROJECT_DIR`. Los de `Fase 1/` y `Fase 4/`, y el script
`Fase 3/exportar_ensemble_a_json.py`, están escritos para Colab.

| Notebook | Qué hace |
|---|---|
| `Fase 1/Sparkle_V2_Fase0_1_Setup_y_Dataset.ipynb` | Descarga DAiSEE desde Kaggle y prepara las etiquetas. |
| `Fase 1/Sparkle_V2_Fase2_3_Extraccion_Landmarks.ipynb` | Primera extracción de puntos faciales con MediaPipe FaceLandmarker. |
| `Fase 1/Sparkle_V2_Fase2_3_v2_MAR_Blendshapes.ipynb` | Extracción geométrica definitiva por cuadro (`features_v2`), la que usan los modelos de Fase 3. |
| `Fase 1/Sparkle_V2_Fase4_Tratamiento_Faltantes.ipynb` | Tratamiento de los cuadros sin rostro detectado. |
| `Fase 3/Sparkle_V2_Fase3_2a_Extraccion_Embeddings_CNN.ipynb` | Ajuste de MobileNetV2 sobre FER2013 y extracción de la representación de apariencia del recorte facial. |
| `Fase 3/Sparkle_V2_Fase3_5a_Extraccion_Raw1280.ipynb` | Reextracción de la apariencia en 1.280 dimensiones, antes de la proyección. |
| `Fase 3/Sparkle_V2_Fase3_6c_Extraccion_Backbone_v2.ipynb` | Extracción con un extractor alternativo, evaluado y descartado. |

**Importante.** La extracción procesa solo los videos `.avi`. Los 652 fragmentos etiquetados que
DAiSEE distribuye en `.mp4` quedan fuera, y corresponden a ocho participantes completos. Por eso el
conjunto utilizado tiene 7.919 fragmentos, como declara la tesis. Quien procese también los `.mp4`
trabajará con otro conjunto y obtendrá otras cifras.

## 2. Entrenamiento y evaluación del clasificador

### Modelos comparados

| Notebook | Qué hace |
|---|---|
| `Fase 1/Sparkle_V2_Fase5_6_Target_y_LSTM.ipynb`, `Fase 1/Sparkle_V2_Fase5b_Diagnostico.ipynb` | Definición del objetivo y primer modelo LSTM. |
| `Fase 1/Sparkle_V2_Fase2Modelado_BiGRU.ipynb` | Modelo BiGRU. |
| `Fase 3/Sparkle_V2_Fase3_0_Binarizacion_Resplit.ipynb` | Objetivo binario y partición agrupada por participante. |
| `Fase 3/Sparkle_V2_Fase3_1_TCN_MultiTask.ipynb` | Red temporal convolucional multitarea. |
| `Fase 3/Sparkle_V2_Fase3_2b_Fusion_Apariencia_Geometria.ipynb` | Fusión de apariencia y geometría, con ablación de cada rama. |
| `Fase 3/Sparkle_V2_Fase3_3_Modelo_Final.ipynb` | Regresión logística sobre resúmenes (321 parámetros) y TCN de fusión; exporta el extractor y el preprocesamiento que usa la extensión. |
| `Fase 3/Sparkle_V2_Fase3_4_Agregacion_Temporal.ipynb` | Agregación de fragmentos en ventanas. |

### Ensamble final con abstención

Este es el orden que produce el 76,13 % sobre la partición de prueba oficial.

| Paso | Notebook o script | Qué hace |
|---|---|---|
| 1 | `Fase 3/Sparkle_V2_Fase3_5b_Brazos_Proyeccion.ipynb` | Compara proyecciones de la apariencia con validación cruzada por participante. |
| 2 | `Fase 3/Sparkle_V2_Fase3_5c_Controles.ipynb` | Controles del experimento anterior. |
| 3 | `Fase 3/Sparkle_V2_Fase3_6a_Prediccion_Selectiva.ipynb` | Predicción selectiva: curva de riesgo y cobertura que fundamenta la abstención. |
| 4 | `Fase 3/Sparkle_V2_Fase3_6b_Agregacion_Tolerante.ipynb` | Ventanas de cinco fragmentos, tolerantes a fragmentos faltantes. |
| 5 | `Fase 3/Sparkle_V2_Fase3_6d_Evaluacion_Backbone_v2.ipynb` | Evaluación del extractor alternativo, que se descarta. |
| 6 | `Fase 3/Sparkle_V2_Fase3_6e_Ensemble_Proyecciones.ipynb` | Ensamble de ocho regresiones logísticas, una por bloque de la proyección, evaluado fuera de muestra. |
| 7 | `Fase 3/Sparkle_V2_Fase3_6f_CIERRE_Test_Oficial.ipynb` | **Única evaluación sobre la partición de prueba oficial**, con la configuración congelada: cobertura 1,00 y 0,60. Guarda el modelo final. |
| 8 | `Fase 3/exportar_ensemble_a_json.py` | Exporta el ensamble al formato que carga la extensión (`modelo_ensemble.json`). |

Los pasos 1 a 6 trabajan solo con las particiones de entrenamiento y validación. La partición de
prueba se usa una sola vez, en el paso 7.

### Análisis complementarios

| Archivo | Qué hace |
|---|---|
| `Fase 3/Sparkle_V2_Fase3_7_Modos_de_Clase.ipynb` | Puntos de operación de los modos de clase. |
| `Fase 3/Sparkle_V2_Fase3_8_Metricas_Derivadas.ipynb` | Métricas derivadas de las características. |
| `Fase 3/Sparkle_V2_Inferencia_End2End.ipynb` | Inferencia completa, del video a la predicción. |
| `Fase 4/analisis/techo_ruido_etiqueta.py`, `figura_desacuerdo.py` | Estimación del ruido de la etiqueta de aburrimiento y del techo del 73,0 % (sección 3.7.4). |
| `Fase 4/analisis/descomposicion_varianza.py` | Peso de la identidad del participante en la etiqueta (sección 3.7.4). |
| `Fase 4/analisis/calibracion_por_sujeto.py` | Simulación de una abstención calibrada por estudiante. |

### Reproducibilidad

- El ensamble final se reentrenó desde cero con NumPy 2.3.4, scikit-learn 1.7.2, SciPy 1.16.2 y
  pandas 2.3.3, y se obtuvo el mismo punto: 76,13 % sobre la partición de prueba.
- Los coeficientes difieren en hasta 0,005 de los del modelo publicado, porque la versión de
  scikit-learn usada en Colab no quedó registrada. Para reproducir las cifras exactas, usar el
  modelo publicado en `frontend/public/models/` de este repositorio.
- Los modelos con redes neuronales se informan como media sobre cinco semillas, no como valores
  reproducibles bit a bit.

## 3. Validación de la capa geométrica

Corresponde a las secciones 3.7.5 y 3.7.6 de la tesis. Los scripts están en `Fase 4/analisis/` y se
corren desde esta carpeta (`entrenamiento/`). Antes de correr cualquiera:

```bash
python "Fase 4/analisis/preparar_entorno.py"
```

Descarga el detector facial de MediaPipe desde una URL fijada y verifica su SHA-256, para que sea
exactamente el que despacha la extensión.

Las rutas a los datos están al comienzo de cada script y se indican con las variables de la sección
[«Parámetros»](#parámetros).

Los scripts `ensayo_*.py` prueban cada medición sobre datos inventados antes de la corrida real, que
se hace una sola vez con criterios fijados de antemano. Los archivos `*_ref.py` son traducciones a
Python de la lógica de la extensión. Los arneses `.mjs` corren el código JavaScript original de la
extensión sobre los mismos datos y comprueban que ambas versiones decidan lo mismo.

| Conjunto | Qué se mide | Archivos |
|---|---|---|
| **BIWI** | Precisión de la orientación de la cabeza y del puntaje de cara contra un sensor de profundidad | `biwi_yaw/bajar_biwi.py`, `biwi_yaw/validar_yaw_biwi.py` (y el notebook `Fase 4/Sparkle_V2_Fase4_0_Validacion_Yaw_BIWI.ipynb`), `facescore/extraer_facescore_biwi.py`, `facescore/medir_facescore_biwi.py`, `recall_cuadro_R1_biwi.py`, `verificar_curva_R1_biwi.py` |
| **AFLW2000-3D y BIWI** | Curva operativa de R1 a partir del error medido de la orientación | `curva_operativa_R1.py`, `curva_R1_enmienda9.py`, `figura_curva_R1.py` |
| **DAiSEE** | Especificidad de R1 y R2 con estudiantes atentos | `control_negativo_daisee.py`, `control_negativo_R2_calib30.py`, `estabilidad_linea_base_R2.py`, `mirada_vs_cabeza.py` |
| **EngageNet** | Especificidad y discriminación según el compromiso anotado | `engagenet/medir_engagenet.py`, `engagenet/alcance_R1_desatencion_anotada.py`, `facescore/extraer_facescore_engagenet.py`, `facescore/medir_facescore_engagenet.py` |
| **Columbia Gaze** | Suma de cabeza y mirada en el puntaje de cara | `facescore/ensayo_medir_facescore_columbia.py`, `facescore/extraer_facescore_columbia.py`, `facescore/medir_facescore_columbia.py` |
| **Eyeblink8** | Que un parpadeo no cuente como ojos cerrados | `facescore/registro_eyeblink8/` (inventario sin mirar rostros), `facescore/ensayo_medir_eyeblink8.py`, `facescore/extraer_eyeblink8.py`, `facescore/medir_eyeblink8.py` |
| **UTA-RLDD** | Especificidad y discriminación de R2 (somnolencia) | `utarldd/extraer_utarldd.py`, `utarldd/medir_utarldd.py`, `utarldd/procesar_folds.sh` |
| **NTHU-DDD** | Mirada al costado y ojos somnolientos anotados por cuadro; fidelidad del veredicto | `nthu/registro_nthu/`, `nthu/ensayo_medir_nthu.py`, `nthu/extraer_nthu.py`, `nthu/medir_nthu.py`, `nthu/complemento_nthu.py`, `nthu/complemento_f2_f3.py`, `nthu/extraer_secuencias_veredicto.py`, `nthu/veredicto_ref.py`, `nthu/veredicto_arnes.mjs` |
| **MPIIFaceGaze** | Conversión de la mirada a grados y evaluación de R4 | `Fase 4/Sparkle_V2_Fase4_2_Calibracion_Mirada_MPIIGaze.ipynb`, `barrido_R4.py` |

Implementaciones de referencia que usan varios scripts: `reglas_geometricas.py` (R1 y R2),
`facescore/facescore_ref.py` (puntaje de cara) y `nthu/veredicto_ref.py` (veredicto).
Los arneses `facescore/equivalencia_*.mjs` reciben como argumento la ruta a `faceScore.js`; los
scripts de medición les pasan la copia de `extension_medida/`.

### Etiquetas de EngageNet

Los scripts de EngageNet leen las etiquetas desde la ruta de la variable `ENGAGENET_ETIQUETAS`, y los
videos desde `ENGAGENET_VIDEOS` cuando el script la admite:

```bash
ENGAGENET_ETIQUETAS=/ruta/a/validation_engagement_labels.xlsx python "Fase 4/analisis/engagenet/medir_engagenet.py"
```

De EngageNet solo se informan resultados agregados, como exige su licencia.

### Parámetros

| Variable o argumento | Qué indica | Valor por defecto | Lo usan |
|---|---|---|---|
| `SPARKLE_PROJECT_DIR` | Carpeta de proyecto con `features_v2/`, `labels/` y los resultados de los notebooks | `./SparkleV2` | Notebooks de `Fase 3/` fuera de Colab, scripts de DAiSEE de `Fase 4/analisis/` y `herramientas/verificar_daisee/armar_recalculo.py` |
| `DAISEE_FEATURES` | Carpeta `features_v2` de DAiSEE, si no está dentro del proyecto | `$SPARKLE_PROJECT_DIR/features_v2` | `control_negativo_R2_calib30.py` |
| `ENGAGENET_VIDEOS` | Carpeta de videos de la partición de validación de EngageNet | `datasets/EngageNet/Validation` | `engagenet/medir_engagenet.py`, `facescore/extraer_facescore_engagenet.py` |
| `ENGAGENET_ETIQUETAS` | Archivo de etiquetas de EngageNet | `validation_engagement_labels.xlsx` | `engagenet/medir_engagenet.py`, `facescore/medir_facescore_engagenet.py` |
| `EYEBLINK8_RAIZ` | Raíz de Eyeblink8 | `datasets/Eyeblink8` | `facescore/*eyeblink8*.py`, `facescore/registro_eyeblink8/` |
| `COLUMBIA_RAIZ` | Raíz de Columbia Gaze | `datasets/ColumbiaGaze` | `facescore/ensayo_medir_facescore_columbia.py`, `facescore/extraer_facescore_columbia.py` |
| `NTHU_RAIZ` | Raíz de NTHU-DDD | `datasets/NTHU-DDD/Training Dataset` | `nthu/extraer_nthu.py` |
| Primer argumento | Raíz de NTHU-DDD | `datasets/NTHU-DDD` o `datasets/NTHU-DDD/Training Dataset` | `nthu/registro_nthu/` |
| `--raiz` | Carpeta de videos de UTA-RLDD | (obligatorio) | `utarldd/extraer_utarldd.py` |
| `UTARLDD_VIDEOS`, `UTARLDD_ZIPS`, `UTARLDD_DESCARGAS` | Videos, zips de cada fold y carpeta de descargas de UTA-RLDD | `datasets/UTA-RLDD/videos`, `datasets`, `$HOME/Downloads` | `utarldd/procesar_folds.sh` |
| `SPARKLE_FRONTEND` | Carpeta `frontend` de la extensión que se mide | `extension_medida/frontend` | `facescore/medir_eyeblink8.py`, `facescore/medir_facescore_columbia.py`, `nthu/medir_nthu.py` |
| `FACESCORE_JS` | Archivo `faceScore.js` que se mide | `extension_medida/frontend/src/offscreen/faceScore.js` | `facescore/medir_*.py` |
| `FACESCORE_SALIDA` | Carpeta de salida de las mediciones | `salida/` junto al script | `facescore/`, `nthu/` |
| `FACE_LANDMARKER_LOCAL` | Copia local del detector facial, para no descargarlo | (se descarga de la URL fijada) | `preparar_entorno.py` |
| `DAISEE_ETIQUETAS_COPIA` | Carpeta de etiquetas de la copia de DAiSEE que se compara | `SparkleV2/labels` | `herramientas/verificar_daisee/comparar_copias.py` |

BIWI se descarga con `biwi_yaw/bajar_biwi.py` a la caché estándar de Hugging Face
(`~/.cache/huggingface`).

## 4. Código de la extensión medido

`extension_medida/frontend/` contiene los archivos de la extensión que usan las mediciones de la
validación, **tal como estaban en el commit `b556d66` del 11 de septiembre de 2026**:

- `src/offscreen/faceScore.js`, `reglas.js`, `preprocessing.js` y `features.js`;
- `tests/reglas.equivalenciaPython.test.js`;
- `package.json`.

Se incluye esta versión y no la de `frontend/` porque las enmiendas 9 a 11 del 27 de septiembre
cambiaron tres constantes de esos archivos después de las mediciones. Para reproducir las cifras de
la tesis hay que medir exactamente el código que se midió.

Los scripts de medición comprueban el SHA-256 de `faceScore.js` y `reglas.js` antes de correr, y se
detienen si no coincide. Los hashes se calcularon sobre los bytes del archivo, incluido el fin de
línea: `faceScore.js` usa CRLF y `reglas.js` usa LF. El archivo `extension_medida/.gitattributes`
evita que git los normalice. Si se copian los archivos con otra herramienta, conviene verificar que
no cambien los fines de línea.

**Prueba de equivalencia de las reglas.** `tests/reglas.equivalenciaPython.test.js` compara las
reglas en JavaScript con su referencia en Python (`Fase 4/analisis/reglas_geometricas.py`) sobre 400
ventanas de DAiSEE. Esas ventanas estaban en `tests/fixtures/reglas_referencia.json`, que no se
incluye porque contiene medidas extraídas de los videos de DAiSEE. Sin ese archivo la prueba falla,
y `nthu/medir_nthu.py` y `facescore/medir_eyeblink8.py`, que la exigen en verde antes de medir, se
detienen en ese paso. Quien tenga DAiSEE puede regenerarlo con `reglas_geometricas.py` y correrla
con Node.js 22:

```bash
cd extension_medida/frontend
node --test tests/reglas.equivalenciaPython.test.js
```

## 5. Verificación del conjunto DAiSEE

`herramientas/verificar_daisee/` permite comprobar que se trabajó con el mismo conjunto de
fragmentos que declara la tesis.

| Archivo | Qué contiene o hace |
|---|---|
| `ids_todos_fase3.txt` | Los 7.919 identificadores de fragmento usados en Fase 3. |
| `ids_test_usados.txt` | Los 1.638 fragmentos de la partición de prueba oficial que se evaluaron. |
| `ids_test_excluidos_mp4.txt` | Los 146 fragmentos de prueba que quedaron fuera por estar en `.mp4`. |
| `comparar_copias.py` | Compara la copia de DAiSEE usada en el proyecto con la distribución oficial: las etiquetas (`DAISEE_ETIQUETAS_COPIA`) o el SHA-256 de cada video. No abre ni decodifica los videos. |
| `armar_recalculo.py` | Arma, a partir del notebook `Fase 3/Sparkle_V2_Fase3_6f_CIERRE_Test_Oficial.ipynb`, un script que recalcula la evaluación sobre la partición de prueba. |

Las listas contienen solo identificadores numéricos de fragmento, sin datos de los videos ni de las
personas.

`armar_recalculo.py` compara el recálculo con los resultados guardados por el notebook en
`SPARKLE_PROJECT_DIR` (`TEST_OFICIAL_RESULTADO.json` y `modelo_final_ensemble.npz`). Esos archivos se
generan al ejecutar el notebook; no vienen en esta carpeta.
