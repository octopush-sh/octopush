# Plan maestro — Génesis por prompt (misiones greenfield) (2026-07-18)

> **Estado:** propuesto; dirección estratégica del fundador, mecánica lista para ejecución.
> **Audiencia:** el fundador + subagentes ejecutores. Cada slice cita rutas, comandos, stores, tokens y patrones exactos del codebase para que un ejecutor barato implemente **sin re-escanear el repo** (solo re-confirmando números de línea locales contra main).
> **Grounding:** verificado contra el worktree `missions-reframe` en v0.4.30 (M1–M4.1a del reencuadre a misiones ya enviados). Hermano de `2026-07-17-missions-reframe-master-plan.md` — este plan lo **concluye**, no lo repite: sus constituciones (§2a monetización, §2b UX premium) aplican verbatim aquí; abajo solo se registran los deltas.

---

## 0. Estrella polar y encuadre

Hoy Octopush **exige un repo antes de existir**: todo modo (Talk/Run/Review/Direct) cuelga de `activeWorkspaceId` (`src/App.tsx:104`), todo workspace cuelga de un proyecto, y el welcome (`src/components/WelcomeScreen.tsx`) solo ofrece "Begin a new study" (wizard de proyecto) o abrir/soltar una carpeta. El usuario que llega con una **intención** pero sin repo — "Build me an iOS app to track my daily tasks" — se topa con burocracia de git antes de ver un solo agente trabajando.

**La visión:** el usuario parte de CERO. Escribe qué quiere construir, elige (o acepta) un modelo, y el crew empieza a CONSTRUIR — **el proyecto es un subproducto de la ejecución, no un prerequisito**. Esto es la conclusión natural del reencuadre a misiones: si la misión es la unidad de primer nivel de intención, entonces una misión puede nacer ANTES que su repo, y el repo se materializa porque la misión lo necesita. Lo llamamos **génesis por prompt** (misiones greenfield).

**Por qué esto es el cierre del reencuadre (no una feature suelta):**
1. **M1 invirtió el orden dentro del proyecto** (intención antes que rama: el wizard `MissionCreator` pregunta *what is this mission about?* antes de tocar git). La génesis invierte el orden **fuera** del proyecto: intención antes que repo. Es el mismo movimiento, un nivel más arriba.
2. **Resuelve el lock-in de adquisición.** Cursor/Windsurf también exigen "open a folder"; bolt/v0/Lovable son prompt-first pero te encierran en su nube. Octopush queda solo en el cuadrante **prompt-first ∧ local-first ∧ git-real desde el minuto uno**: el prompt produce un repo git de verdad en tu disco, con worktrees, checkpoints y un crew que diriges. Eso es identidad, no imitación.
3. **Subsume M4.2 ("design", hoy diferida).** Una misión design era "pensar sin worktree". La génesis la reformula mejor: *pensar es el primer acto de construir* — un sketch que puede promoverse a proyecto (G5, el Sketchbook). M4.2 tal como estaba especificada (workspace_id NULL, artefactos en `~/.octopush/missions/<id>/`, monograma discontinuo en el Rail) **se retira**: el Sketchbook la reemplaza con menos mecanismo nuevo (cero superficies nuevas de artefactos, cero caso NULL en el Rail) y más coherencia (los sketches viven en un repo git real y versionado, gratis).

**No-goals explícitos (heredados y propios):**
1. **Octopush NO se convierte en task manager.** Una misión génesis nace CON su crew/thread — execution-anchored. Nada de estimaciones, fechas, asignaciones. (Constitución del plan hermano, §0, vigente.)
2. **La entrada project-first NO se toca.** "Begin a new study", clone, open y drop-a-folder siguen exactamente igual; la génesis es **aditiva**. Ambas puertas coexisten para siempre.
3. **Cero cuenta obligatoria.** La génesis completa funciona sin login: BYOK/local. Clerk solo aparece donde ya aparece (Pro).
4. **Cero honestidad negociable.** El crew NO promete una app terminada; promete *scaffold + primer incremento funcional, con gates que tú apruebas*. Todo copy de génesis se escribe bajo esa doctrina (§2c).

Los 6 slices, en orden: **G1** el gesto mínimo (describe → nace el proyecto → crew en la puerta) · **G2** génesis dentro del wizard de proyectos · **G3** el crew greenfield (pipeline sembrado) · **G4** el pre-vuelo (modelo + llave inline) · **G5** el Sketchbook (empezar sin construir; subsume M4.2) · **G6** identidad post-build (el proyecto se nombra por lo que construyó).

---

## 1. Fase 0 — Baseline y qué se COMPONE (no se re-construye)

**Punto de partida:** rama fresca off `origin/main` (≥ v0.4.30; los slices M1–M4.1a del reencuadre son **prerequisito y están enviados**). Reglas de ejecutor idénticas al plan hermano §1: cada slice = 1 PR contra main = 1 release patch; review con subagente fresco antes y después del PR; verificación EN LA APP (WebKit ≠ jsdom); `docs/FEATURES.md` se edita en el mismo PR.

**Inventario de lo que ya existe y la génesis compone (verificado, con anclas):**

| Pieza | Dónde | Qué hace hoy | Cómo la usa la génesis |
|---|---|---|---|
| `create_project` | `src-tauri/src/commands.rs:520` | carpeta bajo location + `git init` + `ensure_initial_commit` + fila en `projects` + `ensure_main_workspace` | ES la materialización del repo. Solo gana un param `task` (G1) |
| `ensure_main_workspace` | `commands.rs:494` | crea el workspace "main" (worktree_path = raíz del proyecto) + **misión `build` emparejada** vía `mission::ensure_for_workspace` (`mission.rs:115`; título = `ws.task` si no está vacío) | el prompt fluye como `task` → el título de la misión ES el prompt |
| Wizard de proyecto | `src/components/NewProjectFlow.tsx` (2 pasos; tipos empty/clone/open/template — template ❦ deshabilitado "Coming soon") | la puerta project-first | G2 le añade la tarjeta "From a prompt" (reemplaza la tarjeta muerta Template) |
| Welcome | `src/components/WelcomeScreen.tsx` | The Octo 116px idle + wordmark Fraunces + CTA "Begin a new study" + drop/open + Recent/Closed | G1 lo vuelve prompt-first (es superficie de marca pre-proyecto — fuera del contrato de 5 superficies Atelier, puede reorganizarse sin chrome nuevo) |
| Prefill del launcher | `runsStore.setLauncherPrefill/consumeLauncherPrefill` (`src/stores/runsStore.ts:127,432-437`), consumo reactivo y workspace-scoped en `PipelineSetup.tsx:82-103` | FirstRunInvite ya entrega un brief + pipeline preseleccionado al launcher aunque esté montado bajo el overlay oculto | ES el mecanismo de "el prompt llega al crew". Cero código nuevo de entrega |
| Patrón de handoff honesto | `App.tsx:1433-1469` `handleSendFirstCrew` (captura del ws al click, `crewProviderReady()`, fallback a Settings·Models con toast, `setModePerWorkspace(ws,"direct")`) | el momento minuto-uno del diferenciador | la génesis lo replica casi verbatim con el ws main recién nacido |
| Readiness de provider | `stores/firstRunStore.ts::crewProviderReady()` | Anthropic habilitado + key configurada (el flagship es all-api claude) | G1 lo reusa tal cual; G4 lo vuelve inline |
| Guardas de lanzamiento | `orchestrator/launch.rs::launch_run` (cuota 25/mes `FREE_DIRECT_RUNS_PER_MONTH`, `runs.parallel`, budget, lease detached, first-run marker) | un solo camino guardado para todo Begin | la génesis NO añade guardas ni las esquiva: su run es un run |
| Pipelines sembrados | `db.rs::seed_builtin_pipelines` (~línea 3068; Feature Factory, Bugfix relay, Plan & review, Ship it, Claude Code build) | patrón idempotente de builtins | G3 siembra el sexto: el crew greenfield |
| Slugify | `MissionCreator.tsx:72` (TS) byte-idéntico a `workspace.rs::slugify` | task → branch | G1 deriva nombre de proyecto del prompt con la misma familia |
| Sandbox / unattended / Logbook / Routines | M3.x / M2.x enviados | los ejes premium del reencuadre | aplican al proyecto nacido por génesis sin UN cambio (misma tabla, mismas keys) |

**Lo genuinamente NUEVO es pequeño y es la tesis del plan:** un param `task` en `create_project`, una lib pura de derivación de nombre, la superficie prompt-first del welcome, una tarjeta en el wizard, un pipeline sembrado, y el Sketchbook. Todo lo demás es composición.

---

## 2. Constituciones transversales

### 2a. Monetización — la génesis es GRATIS, el mordisco está donde siempre

**Regla de oro (y advertencia grabada):** gatear la génesis mataría la conversión en la puerta. La génesis ES el funnel: el momento "escribí una frase y un crew está construyendo mi app en MI disco" es el gancho que convierte a un visitante en usuario — y a un usuario en Pro *después*, cuando quiere escala. Un paywall aquí violaría además la línea intocable "core UX gratis" (plan hermano §2a). **Este plan introduce CERO entitlement keys nuevas** — la receta de 5 pasos no aplica a ningún slice.

| Capacidad | Free | Pro | Key (existente, REUSADA) |
|---|---|---|---|
| Génesis completa: prompt → proyecto → misión → crew en la puerta | ✅ | ✅ | — (nunca se gatea) |
| El primer build greenfield (1 run DIRECT, BYOK) | ✅ dentro de 25/mes | ilimitado | `direct.unlimited` (cuota existente en `launch_run`) |
| TALK ilimitado sobre el proyecto nacido (BYOK/local) | ✅ | ✅ | — (línea intocable) |
| Sketchbook (G5): pensar antes de construir | ✅ | ✅ | — |
| Sandbox del crew greenfield | ✅ | ✅ | — (la seguridad es gratis, decisión M3) |
| 2º crew concurrente sobre el proyecto recién nacido | ❌ | ✅ | `runs.parallel` |
| Build greenfield desatendido (cerrar la laptop mientras nace la app) | ❌ | ✅ | `runs.detached` |
| Routine sobre el proyecto génesis ("ship a change every day") | ❌ | ✅ | `routines.scheduled` |
| Logbook por misión del build génesis | ✅ | ✅ | — (el anzuelo, M2) |
| Logbook cross-misión ("¿cuánto costó nacer este producto?") | ❌ | ✅ | `logbook.reports` |
| Historia/biblioteca cross-máquina | ❌ | ✅ | `history.sync` / `library.sync` |

**El diseño del upsell orgánico:** la génesis gratuita termina con exactamente los deseos que Pro vende — "quiero que siga construyendo mientras duermo" (detached), "quiero dos crews avanzando features en paralelo" (parallel), "quiero el recibo de lo que costó" (logbook.reports). No se inventa fricción: la escala ES la fricción natural.

### 2b. UX premium — deltas sobre la constitución del plan hermano

Todo lo del plan hermano §2b aplica (tokens, tipografía upright, themes token-driven, primitivas de movimiento, checklist anti-flicker por slice). Deltas específicos de la génesis:

1. **El Welcome es superficie de MARCA pre-proyecto** (como el About): The Octo y el wordmark Fraunces (`.brand-wordmark`) son legales ahí; el contrato de 5 superficies Atelier rige DENTRO del shell, no aquí. Reorganizar el welcome no es "chrome nuevo de primer nivel".
2. **PROHIBIDO un cuarto sitio `⟶`.** El glifo send está sancionado solo en Composer, `InlineTicketPicker` y `HunkRail` (CLAUDE.md). El submit de la génesis es una **frase serif upright** (`"Set a crew on it"`), no un glifo.
3. **Placeholder serif upright** en el textarea del prompt (receta §4 del cheatsheet), cuerpo del input en sans 13px.
4. **The Octo acompaña el momento:** `state="idle"` mientras se escribe; el instante post-submit (proyecto naciendo) usa `working` — cero animación nueva, es un prop del mark existente (`icons/OctoMark.tsx`).
5. **Cero spinner/skeleton:** la transición welcome → shell reserva geometría y cruza con `.octo-fade-in`; el nacimiento del proyecto es <1s local (git init + un commit) — no merece estado de carga ceremonial.

### 2c. Constitución de honestidad (nueva, vinculante para todo copy de génesis)

Octopush es el **arnés**, no la magia: lo que el crew construye está acotado por la capacidad del agente. El copy fija expectativas sin desinflar el momento:

- **La promesa canónica** (única frase de alcance, reusada en welcome, wizard y pipeline): *"A crew scaffolds it and ships a first working slice — you direct every gate."* Variaciones libres en tono, nunca en alcance.
- **Palabras prohibidas** en superficies de génesis: "complete", "production-ready", "App Store", "fully functional", "in minutes". Grep del diff por ellas en cada slice frontend.
- **La honestidad es mecánica, no solo verbal:** el crew greenfield (G3) termina en un stage de verificación cuyo artefacto dice qué se verificó y qué NO pudo verificarse (p.ej. "SwiftUI compiles; no simulator available to run it"), y los checkpoints ⟜ existentes hacen del usuario el director, no el espectador de una demo.
- **Lo que un primer slice greenfield entrega de verdad:** repo git inicializado + estructura del stack + un incremento que corre (un test que pasa, un server que responde, una vista que compila) + README honesto de "how to run it". Eso ES el wow — real y en tu disco — sin prometer el producto terminado.

---

## 3. Anatomía de la génesis (la mecánica exacta, decidida)

**La cadena completa del gesto G1** (todo existente salvo lo marcado ⊕):

```
[Welcome] prompt textarea ⊕ ── Enter/CTA
  │ deriveProjectName(prompt) ⊕            — src/lib/genesis.ts, heurística + slugify,
  │                                          editable inline antes del submit
  ▼
projectStore.create(location, name, prompt ⊕)
  → ipc.createProject(path, name, task ⊕)
  → commands::create_project + task param ⊕
      ├─ create_dir_all + colisión → sufijo -2/-3 ⊕ (jamás git-init sobre un dir ajeno no vacío)
      ├─ git_ops::init_repo + ensure_initial_commit          (existente)
      ├─ db.insert_project                                    (existente)
      └─ ensure_main_workspace(…, task ⊕)
           └─ insert_workspace(task = prompt) → mission::ensure_for_workspace
              → misión 'build' cuyo TÍTULO ES EL PROMPT       (mission.rs:115, ya funciona así)
  ▼
[App] project effect (App.tsx:541) monta el shell; genesis continúa:
  ipc.listWorkspaces(project.id) → ws main (primera fila)
  crewProviderReady() ?
    ├─ sí → setLauncherPrefill({task: prompt, pipelineId: flagship, workspaceId: ws.id})
    │       setModePerWorkspace(ws.id, "direct")
    │       → el launcher (montado bajo el overlay) consumió el prefill: crew + brief listos,
    │         UN click ("Begin the run") y los agentes construyen
    └─ no → MISMO prefill (parked, workspace-scoped — el prompt jamás se pierde)
            + setSettingsTab("models") + toast "Add your Anthropic key first — your crew
              is staged and waiting."
```

**Decisiones tomadas (con racional; solo §8 queda para el fundador):**

1. **El vehículo del primer build es un crew DIRECT, no TALK.** Es el flagship, es visualmente el wow (StageDots, Mission Control, checkpoints), y calza en el free tier (1 de 25 runs/mes). El "empezar solo conversando" llega en G5 como camino explícito, no como default.
2. **Un click de consentimiento se PRESERVA.** La génesis deja el crew *en la puerta* (launcher prefilled), no lo lanza sola: el usuario ve el ensemble, el costo estimado y el botón "Begin the run" antes de gastar un token. Deliberado — consentimiento de gasto + momento de dirección (puede cambiar modelo/pipeline ahí mismo). El mismo contrato que FirstRunInvite.
3. **El proyecto se crea ANTES de verificar la llave.** git init es local y gratis; crear primero garantiza que el prompt aterrice en un launcher real (prefill workspace-scoped) y que el camino sin-llave termine en Settings·Models con el crew staged — nada que rehacer al volver.
4. **Nombre: heurística local editable, no llamada a modelo.** En G1 no hay garantía de llave configurada, así que el nombre no puede depender de un LLM. `deriveProjectName`: minúsculas, fuera stopwords (build/me/a/an/the/i/want/to/that/app/for/please…), toma 2–4 tokens significativos, une con `-` (familia `slugify` de `MissionCreator.tsx:72`). `"Build me an iOS app to track my daily tasks"` → `ios-track-daily-tasks`. Se muestra en un campo mono editable bajo el textarea (geometría reservada, entra con `.octo-fade-in` al haber ≥2 palabras) — el usuario corrige en un tab si quiere. El renombrado fino post-build llega en G6.
5. **Ubicación: `~/.octopush/projects`** — el default ya existente de `NewProjectFlow.tsx:92`. Consistencia > novedad; "Reveal in Finder" ya existe en el menú de proyecto. (Fork del fundador en §8.1 si quiere un dir visible.)
6. **Pipeline en G1: el flagship existente** (Feature Factory vía el mismo fallback de `handleSendFirstCrew` — `pipelines.find(builtin && "Feature Factory") ?? find(builtin)`). Funciona sobre un repo vacío (plan→implement→review→test no presupone código previo). El crew greenfield DEDICADO llega en G3 y la génesis lo preselecciona desde entonces.
7. **El crew greenfield (G3) es all-api.** Un usuario desde cero no tiene el CLI `claude` instalado; el sustrato api ya ejecuta `run_command`/`write_file` vía `chat_engine::execute_tool` en stages DIRECT. Exigir una segunda instalación en el minuto uno mataría el gesto. (Variante cli: cuando exista demanda, no antes.)
8. **`exec_isolation` default `none` en génesis (por ahora).** El seatbelt (M3.1) permite escribir solo workspace + `$TMPDIR` + `~/.claude`; el scaffolding real escribe caches fuera (`~/.npm`, `~/.cargo`, SwiftPM…) y fallaría opaco. Sandbox-por-default en greenfield queda como mejora futura (necesita perfil con caches de package managers — riesgo §7.3); mientras tanto el Listbox Execution del wizard sigue disponible para quien lo quiera.
9. **Sin misiones-sin-proyecto en el modelo de datos.** `missions.project_id` es NOT NULL y se queda así: el arranque no-git (G5) usa el proyecto **Sketchbook** auto-provisionado — un repo git real, así que los sketches quedan versionados gratis y cero código especial de "misión huérfana".

---

## 4. Plan slice a slice

> Convención: `G<n>`. Cada slice = 1 PR contra main = 1 release patch, con el workflow por slice del plan hermano. Copy 100% inglés; checklist anti-flicker §2b del hermano + grep de honestidad §2c en cada slice frontend.

---

### G1 — El gesto mínimo: "describe → nace el proyecto → el crew en la puerta" (release 1)

**Backend (`src-tauri/src/commands.rs`):**

1. `create_project` (línea ~520) gana `task: Option<String>`:
   - **Colisión de dir (nuevo, obligatorio):** si `<location>/<name>` existe y NO está vacío, sufijar `-2`, `-3`… hasta dir libre (lección de dirs únicos de workspace-create; jamás `git init` sobre la carpeta ajena de alguien). Si existe y está vacío, usarlo.
   - Pasar `task` a `ensure_main_workspace`.
2. `ensure_main_workspace` (línea ~494) gana `task: Option<&str>`; el `insert_workspace` (línea ~510) pasa `task.unwrap_or("")` en vez de `""`. **Call sites a actualizar:** `open_project` (~435, ~450) y `clone_project` (~2739) pasan `None` — comportamiento idéntico al actual. Con `task` no vacío, `mission::ensure_for_workspace` ya titula la misión con él (`mission.rs:115-145`, cero cambios ahí).
3. Sin migraciones. Sin comandos nuevos. Sin keys.

**Frontend:**

1. **`src/lib/genesis.ts` ⊕** — lib pura: `deriveProjectName(prompt: string): string` (heurística de §3.4; exporta la lista de stopwords para el test) + `GENESIS_PROMISE` (la frase canónica §2c, una sola fuente para todo copy).
2. **`WelcomeScreen.tsx` — prompt-first.** Estructura resultante (de arriba a abajo, todo existente se conserva):
   - The Octo 116px + wordmark + tagline (sin cambios).
   - ⊕ **El bloque génesis** (centerpiece, max-w ~560px): textarea auto-resize 2→5 líneas, borde `border-octo-hairline`, focus `border-octo-brass`, placeholder serif upright *"Describe what you want to build…"*; debajo, línea sage 12px con `GENESIS_PROMISE`; debajo, el campo de nombre mono 11px editable (aparece con `.octo-fade-in` cuando la derivación produce algo, geometría reservada — cero layout shift); CTA a la derecha del nombre: frase serif **"Set a crew on it"** (patrón CTA ceremonial: `var(--brass-ghost)` + `var(--brass-dim)`), Enter en el textarea = submit (⇧↵ nueva línea), deshabilitado con prompt vacío.
   - "or" + fila secundaria: **"Begin a new study"** (demovido a la fila secundaria junto a "open one from disk" / drop-a-folder — mismos handlers, cero cambios de flujo).
   - Recent/Recently-closed al pie (sin cambios).
   - Durante el submit (<1s): The Octo pasa a `state="working"`; el CTA se deshabilita. Sin spinner.
3. **`App.tsx` — `handleGenesis(prompt, name)`** (callback pasado a `WelcomeScreen`): la cadena de §3 verbatim — `projectStore.create(DEFAULT_LOCATION, name, prompt)` → leer `useProjectStore.getState().current` (y `error`: si create falló, el welcome muestra la línea rouge existente y NO navega) → `ipc.listWorkspaces(current.id)` → ws main → `crewProviderReady()` → prefill + `setModePerWorkspace(ws.id,"direct")` (+ rama Settings·Models con el toast de §3 si no ready). Nota ejecutor: `projectStore.create` ya setea `current` y dispara el project effect (`App.tsx:541`) que monta el shell y llama `loadWorkspaces` — el `listWorkspaces` directo del handler evita la carrera con el store (mismo patrón de lectura fresca vía `getState()` que usa `handleSendFirstCrew`).
4. `ipc.ts`: `createProject(path, name, task?)`; `projectStore.create(path, name, task?)` (param opcional — los call sites existentes de NewProjectFlow no cambian).

**Interacciones verificadas:** el prefill es workspace-scoped y de consumo único (`PipelineSetup.tsx:82-103`) — no puede filtrarse a otro workspace; `FirstRunInvite` no estorba (el usuario aterriza en Direct, no en Talk; y al comenzar el run, `noteRunStarted` lo retira); la cuota free (25/mes) y `runs.parallel` aplican en `launch_run` sin caso especial.

**Tests:** vitest — `genesis.test.ts` (derivación: stopwords, prompts cortos, unicode, vacío→disabled); cargo — `create_project` con task puebla `workspaces.task` y el título de la misión = prompt; colisión sufija y no toca el dir existente; `open_project`/`clone_project` intactos con `None`. En-app (WebKit) — DB fresca: prompt → proyecto en `~/.octopush/projects/<slug>` → modo Direct con brief + flagship preseleccionado → "Begin the run" arranca el crew; camino sin llave: Settings·Models + toast + prefill sobrevive; el welcome con drop-a-folder/recent intactos; 8 themes; PRM.

**FEATURES.md:** §1 "Onboarding / welcome / empty states" — reescribir el bullet del Welcome (prompt-first + génesis + rutas secundarias); §2 "Project lifecycle — create" — bullet nuevo **Prompt genesis** con la cadena y las anclas; Appendix A — firma de `create_project`.

**Aceptación:** de app recién instalada (con llave) a crew-en-la-puerta en <30 segundos y DOS acciones (escribir + un Enter); el prompt jamás se pierde en ningún camino; cero flicker en la transición welcome→shell; el flujo project-first byte-idéntico al actual.

---

### G2 — La génesis dentro del wizard: ambas puertas en todas partes (release 2)

Hoy la génesis solo vive en el welcome (usuario sin proyecto). Un usuario CON proyectos abre el wizard desde el rail ("Add project", overlay `App.tsx:2368`) — esa puerta también debe ofrecer empezar desde un prompt.

**Frontend (`NewProjectFlow.tsx`):**

1. Paso 1: la tarjeta **Template (❦ "Coming soon", deshabilitada — UI muerta desde el redesign)** se REEMPLAZA por **"From a prompt"** (icono lucide `Sparkles` con `title`; descripción sage: *"Describe it; a crew scaffolds it."*). Minimalismo: muere una opción muerta, nace la puerta nueva. (Si el fundador quiere templates más adelante, viven DENTRO de la génesis como starters — §8.2 — no como quinta tarjeta.)
2. Paso 2, tipo `genesis` ⊕: el mismo bloque prompt/nombre/promesa de G1 (extraer a componente compartido ⊕ `src/components/GenesisPrompt.tsx` para no duplicar; el welcome lo consume también) + campo Location (default `~/.octopush/projects`, editable como en empty). CTA "Set a crew on it" → el `handleGenesis` de G1 (elevado para aceptar `location`); el overlay se cierra solo — el project effect (`App.tsx:547`) ya cierra `showAddProject` al cambiar el proyecto activo.
3. Cero cambios en empty/clone/open.

**Backend:** ninguno. **Gating:** ninguno.

**Tests:** vitest — selección de tarjeta y submit del tipo genesis; en-app — génesis desde el rail con OTRO proyecto abierto (el shell salta al recién nacido; PTYs del anterior sobreviven — canvas always-mounted); teclado completo del wizard.

**FEATURES.md:** §2 — bullet del wizard (4 tipos: la tarjeta nueva, Template retirada).

**Aceptación:** paridad de puertas — cualquier lugar desde donde se crea un proyecto ofrece génesis; usuarios existentes la descubren sin tocar el welcome.

---

### G3 — El crew greenfield: el pipeline que sabe nacer proyectos (release 3)

Feature Factory asume "una feature sobre una base"; un greenfield necesita otro arco: elegir stack → scaffolding → primer incremento → verificación honesta.

**Backend (`db.rs::seed_builtin_pipelines`, patrón idempotente existente):**

1. Sembrar el sexto builtin: **"Greenfield"** (nombre UI: *Greenfield — from a prompt to a first working slice*). Forma decidida; instrucciones exactas de cada stage: **detalle al llegar** (validarlas contra `validate_pipeline_stages` y los roles builtin):
   - `plan` (api) — lee el brief, **elige el stack** y propone la estructura + el primer incremento verificable. Instrucción clave: elegir lo más simple que satisfaga el prompt, y declarar qué NO va a intentar.
   - **⟜ checkpoint gate tras el plan** — la decisión de stack es del director: aprueba/rechaza ANTES del scaffolding. (Es el fork §8.3: si el fundador prefiere fricción cero, el gate se cambia a `auto` en la siembra — un booleano.)
   - `implement` scaffold (api, tools `run_command`+`write_file`+`read_file`+`list_files`) — estructura + deps + config.
   - `implement` primer incremento (api) — la primera rebanada que FUNCIONA.
   - `code_review` (api) — loop ⟲ gated ×2 al incremento.
   - `test` / verificación (api) — corre lo corrible y escribe el artefacto honesto de §2c: qué se verificó, qué no se pudo, y un `README.md` "how to run it".
   - **All-api con modelos claude** (decisión §3.7) — `crewProviderReady()` sigue siendo el check correcto sin cambios.
2. Retrofit one-shot para instalaciones previas: el mismo patrón UPDATE/`app_meta` que usó la siembra de loops.

**Frontend:**

1. `handleGenesis` preselecciona **Greenfield** (`pipelines.find(builtin && "Greenfield")`), con la cadena de fallbacks de G1 detrás.
2. `FirstRunInvite`/`handleSendFirstCrew` NO cambian (workspace existente ⇒ Feature Factory sigue siendo su flagship correcto).
3. El pipeline es un builtin normal: aparece en el picker del launcher, es forkeable en el builder, viaja por library-sync si lo forkean — cero código especial.

**Gating:** ninguno (los builtins son gratis; el run consume la cuota normal).

**Tests:** cargo — siembra idempotente (migrate×2), validación del grafo sembrado (gate, loop, tools, DAG); en-app — génesis real end-to-end con llave: `"Build me a CLI that tracks daily tasks in a JSON file"` → aprobar el gate del plan → crew corre → repo con scaffold + incremento + README honesto; el artefacto de verificación dice la verdad (probar también un prompt no-verificable tipo iOS).

**FEATURES.md:** §4 — bullet del sexto builtin con su forma; §2 — la génesis preselecciona Greenfield.

**Aceptación:** el primer build de un usuario nuevo produce un repo que un desarrollador respeta (estructura real, incremento que corre, README honesto), no un volcado de archivos; el gate de stack se siente como dirección, no burocracia.

---

### G4 — El pre-vuelo: modelo y llave sin salir del gesto (release 4)

El "pick a model" de la visión del fundador, y la eliminación del último desvío (el bounce a Settings·Models) para el usuario frío.

**Frontend (`GenesisPrompt.tsx`, compartido welcome+wizard):**

1. **Línea de modelo** bajo el bloque del prompt: mono 11px mute — `crew runs on {shortModel} · change` — "change" abre un picker compacto (**Atelier Listbox**, jamás `<select>` nativo) con los modelos claude configurables. La elección viaja en el prefill como overrides de las stages api del pipeline elegido (`LauncherPrefill.overrides` ya existe — mapear posición→modelo; **detalle al llegar:** el shape exacto contra `PipelineSetup.overrideTuples`). Default: el default del sistema (hoy `claude-sonnet-4-6`) — cero elección obligatoria, la visión es *poder* elegir, no *deber* elegir.
2. **Llave inline (cold start):** si `crewProviderReady()` es false, el bloque muestra — geometría reservada, `.octo-fade-in` — un campo mono enmascarado *"Paste an Anthropic API key to wake the crew"* + línea mute *"Stored locally in `~/.octopush` — never leaves your machine."* Al pegar: persistir por el MISMO camino que Settings·Models escribe `providerKeys` + habilitar el provider anthropic (**detalle al llegar:** citar el helper exacto de `ModelsPane`/settings al implementar; no inventar un segundo camino de escritura de llaves), re-check, y el CTA principal se habilita. El fallback a Settings·Models de G1 se conserva para quien cierre el campo.
3. **Stack hints (condicionado a §8.2):** fila opcional de chips mute (`let the crew choose · web · CLI · API · iOS`) que solo anotan el brief (`"\n\nStack preference: {chip}"`). NO se implementa hasta el fork del fundador; el plan lo deja especificado para no re-diseñar.

**Backend:** ninguno (la escritura de llaves reusa el camino existente de settings).

**Tests:** vitest — visibilidad condicional del campo llave, mapping modelo→overrides; en-app (WebKit, ojo clipboard/focus — nos mordió dos veces) — pegar llave real habilita el CTA sin salir del welcome; el modelo elegido aparece en las stages del launcher.

**FEATURES.md:** §1 (bloque génesis: modelo + llave inline) + §8 si toca el camino de providers.

**Aceptación:** un usuario SIN llave completa la génesis entera sin ver Settings; la elección de modelo sobrevive hasta el run; cero segunda fuente de verdad de llaves.

---

### G5 — El Sketchbook: empezar sin construir (subsume M4.2 "design") (release 5)

Para quien no quiere un crew todavía — quiere *pensar* el producto. El arranque no-git que la visión pide ("just talk/plan"), con la arquitectura que retira M4.2.

**Arquitectura (decidida):**

- **Proyecto "Sketchbook" auto-provisionado** en `~/.octopush/sketchbook`, creado lazy en el primer uso vía el `create_project` normal (repo git real ⇒ sketches versionados gratis; cero caso `workspace_id NULL`, cero superficie nueva de artefactos, cero monograma discontinuo — TODO el mecanismo especial de M4.2 muere). Es un proyecto normal en el rail (fila "Sketchbook"); su workspace main hospeda las misiones sketch.
- **Misión sketch = intent `design`** (ya en `mission::INTENTS`) sobre el workspace main del Sketchbook, git_isolation `worktree` — los agentes ESCRIBEN sus notas/specs como archivos markdown en el repo (execution-anchored: la misión nace con su thread TALK).
- **Restricción de create ya existente a considerar:** `mission::create` rechaza mezclar git_isolation distintos activos en un checkout (`conflicting_active_isolation`) — todas las misiones sketch usan `worktree` sobre main, así que conviven; **detalle al llegar:** si el índice `idx_missions_writer` (unique escritor activo por workspace) obliga, las misiones sketch adicionales pueden ser threads dentro de la misión sketch única del Sketchbook en vez de misiones separadas — decidir contra el esquema real al implementar, sin romper el invariante.

**Slice:**

1. Welcome + wizard: entrada secundaria serif — **"Think it through first"** (bajo el CTA génesis, tono mute→brass-hi al hover) → provisiona/reusa Sketchbook → crea/reusa la misión sketch → aterriza en **TALK** con un thread nuevo cuyo primer mensaje ES el prompt (enviado ya — aquí no hay gasto de crew que consentir: es un turno TALK normal BYOK, y el usuario ya consintió al elegir esta ruta).
2. **El CTA frontera** (el mismo patrón anti-task-manager de M4): al pie del Companion en threads del Sketchbook, frase serif **"Make it a project"** → el flujo génesis (G1) con prompt = título del thread + el contenido del último artefacto/summary como brief (**detalle al llegar:** qué se copia exactamente — ¿los .md del sketch al repo nuevo como `docs/`?— decidir con los primeros sketches reales). La misión sketch se marca `done`; el sketch queda en el Sketchbook como registro.
3. `docs/FEATURES.md` y el plan hermano: registrar explícitamente que **M4.2 queda subsumida por G5** (una línea en el plan hermano §M4.2 apuntando aquí, para que ningún ejecutor la implemente doble).

**Gating:** ninguno (TALK es gratis por línea intocable).

**Tests:** cargo — provisión lazy idempotente del Sketchbook; en-app — prompt → sketch → conversación → "Make it a project" → proyecto real con el contexto del sketch; el Sketchbook se comporta como proyecto normal (archivable, cerrable).

**Aceptación:** el camino "solo quiero pensarlo" existe sin repo previo y sin gasto de crew; la promoción a proyecto es un gesto; nada de M4.2 queda pendiente ni duplicado.

---

### G6 — Identidad: el proyecto se nombra por lo que construyó (release 6, fino)

El cierre del arco "el proyecto es un subproducto": el slug heurístico de G1 es funcional pero anónimo; una vez que el primer run terminó, el proyecto ya SABE qué es.

1. Al completarse el primer run de un proyecto nacido por génesis (marcador: **detalle al llegar** — candidato: `payload.genesis = {prompt, at}` en la misión de génesis, estampado en G1 sin costo), una única sugerencia quieta: toast con acción — *"This project built a task tracker. Rename it to `task-tracker`?"* — nombre generado con UNA llamada BYOK breve (title-case + slug; mismo racional gratis que el recap M2.3: la llamada es del usuario). Acepta → `update_project_customization` (existente). Ignora → jamás se repite (marca en el payload).
2. Estrictamente one-shot, jamás sobre proyectos project-first, jamás renombra solo.

**Gating:** ninguno. **Tests:** cargo del one-shot; en-app con Ollama local (el camino BYOK-gratis sin cuenta). **FEATURES.md:** §2. Slice deliberadamente pequeño; si el fundador resuelve §8.4 en contra, se cae sin tocar nada más.

---

## 5. Modelo de datos (delta consolidado)

Deliberadamente mínimo — la génesis es composición:

- **Cero tablas nuevas. Cero keys nuevas. Cero columnas nuevas en G1–G5.**
- `create_project` gana `task: Option<String>` (param, no schema); fluye por `ensure_main_workspace` → `workspaces.task` → título de misión (mecánica M1 existente).
- G6 (candidato): `missions.payload.genesis = { prompt, at, renameOffered? }` — JSON en el payload ya existente de M1.1, sin migración.
- El Sketchbook es una fila normal de `projects` + misiones `design` normales — cero schema especial.

**Invariantes que este plan JURA preservar** (además de los 5 del plan hermano §4): (a) `git init` jamás sobre un dir no vacío ajeno (sufijo de colisión G1); (b) el prompt del usuario jamás se pierde entre superficies (prefill workspace-scoped de consumo único, ya garantizado por `PipelineSetup`); (c) un solo camino de escritura de llaves de provider (G4 reusa el de Settings).

---

## 6. Secuencia y grafo de dependencias

```
main ≥ v0.4.30 (M1–M4.1a enviados — prerequisito cumplido)
│
G1 (el gesto mínimo) ──► G2 (wizard) ──► G3 (crew Greenfield) ──► G4 (pre-vuelo)
│                                                                    │
└──► G5 (Sketchbook; solo requiere G1) ─────────────────────────────►┴──► G6 (identidad)
```

- **G1 es el único slice bloqueante** — todo lo demás lo compone. G5 puede adelantarse en paralelo a G3/G4 (archivos disjuntos: Sketchbook toca TALK/Companion; G3/G4 tocan seeds/launcher).
- **Con el plan hermano:** ningún slice G toca `db.rs::migrate`, el orquestador, ni el grafo de stages — cero colisión con M2 (Logbook), M3 (sandbox), M4.3 (perf) ni DIRECT slice 4 (depth-routing) si corren en paralelo. La única intersección es documental: G5 retira M4.2 (anotar en ambos planes en el PR de G5).
- 6 releases estimadas. Cada una con impacto UX visible (regla del fundador): G1 el welcome nuevo, G2 la tarjeta, G3 el crew, G4 el pre-vuelo, G5 el Sketchbook, G6 el renombrado.

---

## 7. Riesgos y qué preservar

1. **Overpromise = muerte de confianza.** El riesgo #1 no es técnico: es que el welcome prometa una app y el crew entregue un scaffold que el usuario no sabe correr. Mitigación en tres capas: la promesa canónica única (§2c), el stage de verificación honesta + README (G3), y el gate de stack que hace al usuario director desde el minuto dos. Si un slice debe elegir entre wow y honestidad, gana la honestidad — el wow real es "esto existe en mi disco y corre".
2. **Cold start multidimensional.** Sin llave (→ G4 inline), sin CLI claude (→ all-api, §3.7), sin toolchain del stack (npm/xcode ausentes → el plan del crew debe preferir stacks verificables con lo detectado, y el artefacto de verificación declara lo no-corrible). Jamás un fallo opaco en el minuto uno.
3. **Sandbox × scaffolding.** El seatbelt de M3.1 bloquearía las caches de package managers (`~/.npm`, `~/.cargo`…) — por eso génesis arranca `exec_isolation='none'` (§3.8). Deuda consciente y registrada: perfil "greenfield" con caches permitidas = mejora futura; hasta entonces, NO activar sandbox por default en génesis (un scaffold que falla por deny-write invisible es exactamente el incidente ilegible que M3 prohíbe).
4. **La cuota free como fricción del funnel.** 1 génesis = 1 de 25 runs/mes — correcto y sin caso especial (un "génesis gratis ilimitado" sería un agujero de cuota trivial). Vigilar post-launch: si el dato dice que la cuota muerde el funnel, la palanca es el número 25, no un carve-out.
5. **Regresión del welcome.** Es la primera pantalla que TODO usuario nuevo ve; drop-a-folder, open-from-disk, Recent y Recently-closed deben salir byte-idénticos de G1. Test en-app explícito por camino.
6. **Deriva a task manager (guardia permanente).** El Sketchbook será la tentación ("¿y si los sketches tuvieran estados/prioridades?"). La frontera es el CTA "Make it a project" — un sketch se promueve a ejecución o se queda siendo un documento. Cualquier PR que le añada campos de planificación cita el §0.1 del plan hermano y se rechaza.
7. **Ambas puertas, para siempre.** La génesis jamás se vuelve la puerta única ni la default forzada — developers con repos existentes son el core actual; el welcome las presenta como pares (prompt-first arriba por ser la novedad, no por jerarquía moral).

---

## 8. Decisiones abiertas para el fundador

Todo lo demás está decidido arriba. Estos cuatro forks son genuinamente tuyos:

1. **Ubicación default de los proyectos génesis.** El plan usa `~/.octopush/projects` (consistente con el wizard actual, pero es un dotdir invisible en Finder). Alternativa: un dir visible tipo `~/Octopush/` — mejor para "esto es MÍO, está en mi disco" (el argumento anti-lock-in hecho carne), a costa de divergir del default actual o migrarlo. Mi lectura: visible gana para génesis (el público génesis es justo el que no vive en la terminal), pero es postura de producto, tuya. Afecta G1 (una constante).
2. **Estrategia de stack/starters.** El plan recomienda **crew-chooses-con-gate** (G3) y deja especificados los stack-hint chips (G4) sin implementarlos. Alternativa mayor: starters curados por Octopush ("iOS SwiftUI starter", "Next.js starter"…) = más determinismo y velocidad, pero mantenimiento perpetuo y sesgo de catálogo. Decide: ¿chips sí/no en G4, y starters como evolución de la tarjeta Template retirada o nunca?
3. **Hasta dónde llega el primer build greenfield.** El plan fija: scaffold + primer incremento + verificación honesta, con gate tras el plan. Forks: (a) ¿gate `gated` (recomendado: dirección desde el minuto dos) o `auto` (fricción cero, más "magia", menos control)? (b) ¿el pipeline termina en repo local (recomendado) o empuja a GitHub/abre PR como "Ship it" (más wow, exige auth de GitHub en el minuto uno)? Afecta la siembra de G3 (config, no arquitectura).
4. **Naming.** (a) Del producto: cómo se llama esta capacidad en marketing ("Genesis"? "From a prompt"? — el UI copy del plan ya evita bautizarla). (b) Del mecanismo G6: ¿quieres el renombrado post-build (mi recomendación: sí, es el detalle que cuenta la historia "el proyecto nació de la ejecución") o el slug heurístico basta? G6 entero cuelga de esto.

---

*Fin del plan. Cada slice referencia archivos, comandos, stores y patrones exactos verificados en v0.4.30 — un ejecutor no necesita re-escanear el codebase, solo re-confirmar líneas locales contra main en el momento de ejecutar.*
