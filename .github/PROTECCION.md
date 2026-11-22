# Proteccion de la rama `main` (pasos A.5 y D.4)

## Como se aplica

```bash
gh api -X POST repos/maxiTrufel/Saprkle_V2_Codigo/rulesets --input .github/ruleset-main.json
```

Para verificar que quedo activa:

```bash
gh api repos/maxiTrufel/Saprkle_V2_Codigo/rulesets --jq '.[] | "\(.id)  \(.name)  \(.enforcement)"'
```

Para sacarla (hace falta el id del comando anterior):

```bash
gh api -X DELETE repos/maxiTrufel/Saprkle_V2_Codigo/rulesets/<id>
```

## ⚠️ Requiere GitHub Pro

En un repositorio **privado** del plan gratuito, tanto la proteccion de ramas
clasica como los rulesets devuelven:

```
403 Upgrade to GitHub Pro or make this repository public to enable this feature.
```

El **GitHub Student Developer Pack incluye GitHub Pro gratis** mientras seas
estudiante. Es el mismo tramite que da el dominio `.me` gratis, asi que
conviene hacerlo una sola vez y destrabar las dos cosas.

## Que hace esta configuracion, y por que

| Regla | Decision |
|---|---|
| Se exige pull request | Es el pedido de A.5: `main` no se toca con un push directo |
| **0 aprobaciones requeridas** | Son dos personas y una sola corre el despliegue. Exigir una aprobacion significaria que cada cambio espera a que el otro este disponible — el mismo cuello de botella que ya aparecio con el DNS. El PR sigue siendo obligatorio, asi que el CI corre igual |
| Tres checks obligatorios | Paso D.4. Los nombres tienen que coincidir **exactamente** con los `name:` de los jobs en `ci.yml`, tilde de "extension" incluida |
| `strict` en false | No obliga a rebasear cada rama contra el ultimo `main` antes de mergear. Con dos personas trabajando en carpetas separadas (backend/infra contra frontend/vexa) el riesgo es bajo y evita el ciclo de "actualizar rama" en cada merge |
| Sin `enforce_admins` | El admin puede saltearse la regla. Es la salida de emergencia para un `hotfix/` con produccion caida, que es justo el escenario donde no se quiere estar peleando con la configuracion |
| Sin force push ni borrado | Nadie reescribe la historia de `main` ni la borra por accidente |

## Ojo con los nombres de los checks

Si en `ci.yml` cambia el `name:` de un job —por ejemplo, porque cambia la
cantidad de tests y "Backend (143 tests)" pasa a ser otra cosa— el check
obligatorio deja de existir y **los PR quedan esperando para siempre** un
check que nunca va a llegar. Si tocas esos nombres, actualiza este archivo y
volve a aplicar el ruleset.
