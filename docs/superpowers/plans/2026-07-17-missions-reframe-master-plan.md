# Plan maestro — El reencuadre a Misiones (2026-07-17)

> **Estado:** aprobado en dirección estratégica; este documento es el plan de ejecución.
> **Audiencia:** el fundador + subagentes ejecutores. Cada paso cita rutas, tablas, comandos, tokens y patrones exactos del codebase para que un ejecutor barato pueda implementar **sin re-escanear el repo** (solo re-confirmando números de línea locales, ver Fase 0).
> **Grounding de origen:** los hechos técnicos citados provienen del mapa verificado del codebase (backend v0.4.1→main v0.4.18; el drift es aditivo, los patrones son estables).

---

## 0. Estrella polar y encuadre

Octopush deja de ser "una app que gestiona worktrees con agentes dentro" y pasa a ser **la superficie de operación donde un desarrollador dirige workstreams concurrentes de agentes a través de TODO el espectro del trabajo de desarrollo**. La unidad de primer nivel deja de ser el worktree (un mecanismo de git) y pasa a ser la **misión**: un hilo de intención con agentes, terminales y artefactos dentro. El worktree no muere — **se convierte de sustantivo en adjetivo**: la *propiedad de aislamiento* que una misión elige, en dos ejes independientes:

- **Eje git-state:** `worktree` (default para código) · `readonly` (checkout compartido de solo lectura) · `ephemeral` (worktree efímero auto-archivado) · `pr` (cabeza de un PR).
- **Eje ejecución:** `none` (proceso normal) · `sandbox` (seatbelt local) · `container` · `cloud` (reservado, M5).

**Lo invariante (no se toca):**
- El **worktree sigue siendo el default incuestionado para misiones de código** (build/fix). La industria acaba de validar el modelo; no lo tiramos, lo ascendemos.
- El **aislamiento de contexto** por misión (sesiones, threads, prompts propios) se preserva SIEMPRE, incluso cuando dos misiones comparten checkout — es el invariante anti-alucinación.
- Checkpoints, local-first, y el **contrato de superficie Atelier** (Rail · ContextHeader · Modes · Canvas · Companion · Input bar — cero chrome nuevo de primer nivel, cero tabs).

**No-goals explícitos (correcciones ya pactadas):**
1. **Octopush NO se convierte en un task manager.** Una misión nace SOLO cuando hay agentes/terminales/artefactos involucrados — es *execution-anchored*. El backlog vive en Jira (y GitHub Issues). **Nunca** añadimos estimaciones, sprints, ni asignaciones de personas. Si un cambio propuesto huele a Jira, se rechaza.
2. El aislamiento son **dos ejes, no un menú único.** Nunca colapsar git-state y ejecución en un solo selector.
3. Cloud es un **adaptador de terceros, tardío** (M5) — no construimos infraestructura cloud propia.

Los 5 movimientos, en orden: **M1** misiones como entidad de primer nivel · **M2** el Logbook · **M3** sandboxing de ejecución + unattended · **M4** tipos de misión no-código · **M5** adaptador cloud.

---

## 1. Fase 0 — Baseline e higiene de rama

**El punto de partida NO es este worktree.** La rama `new-experience` está en v0.4.1 (`d01a88c`), **0 adelante / 37 detrás** de `origin/main` (v0.4.18, `c1c9e45`). No hay nada que reconciliar: todo lo nuevo de main (detached runs v0.4.8, routines v0.4.9, effort v0.4.10, ask_director v0.4.11, escalación v0.4.12, Atelier Listbox v0.4.14, paridad MCP v0.4.15–18) está ausente aquí y es *prerequisito* de este plan.

**Pasos exactos:**

```bash
git fetch origin
git worktree add ../missions-reframe -b missions-reframe origin/main
# El documento del plan viaja: copiarlo desde este worktree al nuevo
cp docs/superpowers/plans/2026-07-17-missions-reframe-master-plan.md \
   ../missions-reframe/docs/superpowers/plans/
cd ../missions-reframe
git add docs/superpowers/plans/2026-07-17-missions-reframe-master-plan.md
git commit -m "docs: master plan del reencuadre a misiones"
```

**Reglas para ejecutores:**
- Todo el trabajo apunta a `main`. Cada slice = un PR contra main = una release (patch bump), siguiendo el workflow por slice: **code review con subagente fresco antes y después del PR, atender todos los findings, auto-merge, release**.
- Los números de línea citados en este plan son de la era v0.4.1: **re-confirmar el número exacto en el archivo concreto que tocas** (barato y localizado — NO re-escanear el repo; las rutas, tablas, columnas y patrones son estables).
- `docs/FEATURES.md` se edita contra la copia de main (990 líneas allí).
- Verificar la UX premium **dentro de la app** (WebKit ≠ jsdom: clipboard/focus/user-activation esconden bugs tras un vitest verde — ya nos mordió dos veces).

---

## 2. Las dos constituciones transversales

### 2a. Constitución de monetización

**La línea libre/pro ya enviada (principio intocable, de `docs/premium/premium-features-plan.md`, "Option C — Platform fee + BYOK"):** NUNCA se cobra por las llaves/cómputo del usuario — BYOK/local, TALK completo, REVIEW, git/GitHub, terminales, el builder visual y su authoring, budgets/analytics, themes: gratis para siempre. **Se vende volumen + concurrencia + memoria/telemetría + ejecución desatendida + colaboración sobre el motor de orquestación propio de Octopush.**

**Reformulación de la línea para las superficies NUEVAS:** el *acto* de dirigir (crear misiones, elegir aislamiento, ver tu misión actual) es gratis; la *escala* y la *memoria* (flota concurrente, telemetría agregada, ejecución sin supervisión, nube) son Pro. La seguridad (sandboxing) es gratis siempre — un producto que cobra por seguridad se percibe como extorsión, y un free tier más seguro que Cursor es marketing puro.

**Decisión tomada (el fundador preguntó):** el **picker de intención de misión es GRATIS**. Es la puerta de entrada del reencuadre completo; ponerle paywall mataría la adopción del modelo mental que queremos instalar y violaría la línea "core UX gratis". El mordisco premium está exactamente donde ya funciona: volumen (`direct.unlimited`), concurrencia (`runs.parallel`), desatendido (`runs.detached`), sync (`history.sync`) — y el nuevo `logbook.reports`.

#### Tabla de gating (capability × tier)

| Capacidad | Free | Pro ($20/mo) | Team (semilla) | Enterprise (semilla) | Racional |
|---|---|---|---|---|---|
| Entidad misión + picker de intención + wizard | ✅ | ✅ | — | — | Puerta de entrada del reencuadre; core UX nunca se cobra |
| Aislamiento git (worktree/ephemeral/PR/readonly) | ✅ | ✅ | — | — | Mecánica git local = cómputo del usuario |
| Sandbox local (seatbelt) y container local | ✅ | ✅ | — | — | La seguridad es gratis; free tier más seguro que la competencia |
| Mission Control como cabina de misiones | ✅ | ✅ | — | — | Navegación, no escala |
| Volumen de runs DIRECT | 25/mes | Ilimitado | pool por equipo | pool + política | Key existente `direct.unlimited` |
| Concurrencia de runs activos | 1 global | Muchos | — | — | Key existente `runs.parallel` |
| Ejecución desatendida (detached, incl. sandboxed) | ❌ | ✅ | — | — | Key existente `runs.detached`; se REUSA, no se crea otra |
| Misiones programadas (Routines) | s/ gating actual | ✅ | — | — | Ya enviado v0.4.9; no se re-decide aquí |
| Logbook por misión (tarjeta Companion, misión actual) | ✅ | ✅ | — | — | El anzuelo: probar la telemetría en pequeño |
| **Logbook Room: rollups cross-misión/proyecto, períodos, export CSV/JSON, digest semanal** | ❌ | ✅ **`logbook.reports`** (key nueva) | rollup por equipo (`logbook.team`, futura) | + export de auditoría | LA venta nueva: memoria/telemetría sobre el motor |
| Recap narrativo por misión (generado con BYOK) | ✅ | ✅ | — | — | La llamada al modelo es del usuario; lo gated es la agregación, no el BYOK |
| Sync cross-máquina de misiones/Logbook | ❌ | ✅ (extensión de `history.sync`) | — | — | Key existente; misma semántica |
| Adaptador cloud (M5) | ❌ | ✅ **`exec.cloud`** (key futura, se declara al construir M5) | pool/quotas | + red privada | Ejecución sobre infraestructura que Octopush intermedia |
| Rollup de Logbook por equipo, seats, admin | ❌ | ❌ | ✅ | ✅ | La PRIMERA razón real de existir de Team |
| SSO, auditoría, retención dictada por policy | ❌ | ❌ | ❌ | ✅ | Clásico enterprise; no antes |

#### Dónde se plantan las semillas de Team/Enterprise

Hoy `enum Plan { Free, Pro, Team, Enterprise }` en `entitlement.rs` tiene Team/Enterprise como **placeholders muertos** — `Entitlement::for_plan()` solo matchea `"pro"`. Este plan NO construye el tier Team (decisión de negocio pendiente, ver §7), pero deja el terreno listo sin rework:

1. **El shape del reporte del Logbook** (`LogbookMissionRow`, M2.1) se diseña con `project_id`, `mission_id` y período explícitos y serialización estable — exactamente el shape que un servidor agregaría por-seat. El rollup de equipo es "el mismo JSON, sumado en octopush-api", no un rediseño.
2. **`spend_events`** (rebuild de token-accounting, M2.0) lleva `mission_id` denormalizado desde el día 1 — el ledger por-usuario ya es agregable.
3. **`work_spans`** (M2.1) es por-usuario-local pero su clave (`mission_id`, `surface`, intervalo) suma trivialmente entre máquinas vía el mismo canal que `synced_runs`/`history.sync` ya usa.
4. Los feature keys nuevos se nombran con la familia en mente: `logbook.reports` (Pro) → `logbook.team` (Team, futura). Cuando Team exista, el único cambio de código es `for_plan()` + `Entitlement::team().features`.
5. Misiones desatendidas + notificaciones de crew (v0.4.7) + Routines = el paquete "crews sin supervisión" que un equipo paga por-seat.

**Anti-semilla deliberada:** NO se planta "asignar misión a un compañero" — eso es task-manager drift. La colaboración de Team será *visibilidad* (logbook agregado, biblioteca compartida de pipelines/roles), no *asignación*.

#### La receta de gating reusable (5 pasos, seguir verbatim)

Para cada capacidad gated de este plan (se referencia como "los 5 pasos"):
1. Declarar el key en `entitlement.rs` `mod feature`; añadirlo a `Entitlement::pro().features`; dejarlo fuera de `free_restricted()`.
2. **Enforcement en backend (obligatorio):** booleano → espejar `require_history_sync()` retornando `AppError::UpgradeRequired { feature, used: 0, limit: 0 }` (serializa estructurado `{"kind":"UpgradeRequired",...}` vía `error.rs`); cuota → espejar `start_run` en `commands.rs` (leer uso de db, comparar contra el límite del plan).
3. Frontend: pre-check `hasFeature(k)` de `useEntitlement()` + `useUpgradeStore.getState().show({feature, used, limit})`, y/o capturar `isUpgradeRequired(e)` (`src/lib/upgradeError.ts`) alrededor de la llamada ipc.
4. Extender el ternario de copy en `src/components/UpgradeSheet.tsx` con la rama del nuevo key (eyebrow mono-brass / título serif / cuerpo sage; CTA exacto "Upgrade to Pro" — frase sancionada, no inventar variantes).
5. Actualizar `docs/FEATURES.md` §4 "Entitlement & quota" (+ §10 y Appendix A donde cruce).

Prohibido: gatear BYOK/local/TALK/REVIEW/builder; confiar solo en el check frontend; inventar code paths Team/Enterprise sin cablear `for_plan()`.

### 2b. Constitución de UX premium

Toda superficie nueva de este plan usa EXCLUSIVAMENTE el toolkit existente. Nada se inventa.

**Tokens (CSS var ↔ Tailwind, en `src/styles.css` `@theme`; JAMÁS hex hardcodeado):** onyx `bg-octo-onyx` (fondo app) · panel `bg-octo-panel` · panel-2 (hover/activo) · hairline `border-octo-hairline` · **brass `bg/text/border-octo-brass` — EL acento, ≤5% de píxeles, ≤2-3 elementos por pantalla** · brass-hi (hover) · ivory `text-octo-ivory` (titulares) · sage `text-octo-sage` (cuerpo) · mute `text-octo-mute` (meta/ghost) · verdigris (éxito/ahorro) · rouge (peligro) · warning (precaución, nunca acento) · state-blue (sustrato API) · state-purple (sustrato CLI). Alphas: `--brass-line .55`, `--brass-dim .4` (borde activo), `--brass-glow .12`, `--brass-ghost .08` (bg activo sutil), `--brass-quiet .22`, `--brass-faint .04` (lavado ambiental), `--onyx-40`.

**Tipografía:** `--font-serif` Spectral **solo upright** (itálicas PROHIBIDAS globalmente — `em,i{font-style:normal}`; CTAs = frases serif uprights: `"Begin the mission"`, no `"+ Create"`), `--font-sans` sistema (cuerpo 13px), `--font-mono` JetBrains Mono (eyebrow **mono 10px uppercase tracking .25em**, código 12px). `.brand-wordmark` = Fraunces solo en superficies de marca. Números vivos SIEMPRE con `.octo-tabular`.

**Sistema de themes — CRÍTICO:** NO existe `prefers-color-scheme` ni `data-theme`. Los themes son un catálogo backend (`theme.rs::builtin_themes()`: `atelier` + familia premium de 4 + 3 legacy); `themeStore` → `applyThemeToDom(t)` escribe `--color-octo-*` inline en root y despacha `window "octo:theme"`. **"Theme-aware" = token-driven.** Toda superficie nueva que solo use tokens `octo-*` es automáticamente compatible con los 8 themes. Cero media queries de color.

**Primitivas de movimiento (`src/styles.css`; reusar, NUNCA hand-roll):** timing `--ease-octo: cubic-bezier(0.2,0.8,0.3,1)`, duraciones 220/280/320/600ms, stagger 45ms. Clases: `.octo-overlay-enter` (backdrop) · `.octo-modal-enter` (diálogo) · `.octo-menu-enter` · `.octo-fade-in` (crossfade de modo/tab) · `.octo-pop-in` (dots/badges) · `.octo-rise-in` (filas de lista) · `.octo-sweep` (completado) · `.octo-flash` (mira-aquí) · `.octo-stage-pulse` (EL beacon único). Colapsables = grid-rows 0fr↔1fr vía `<Reveal open>` (`src/components/primitives/Reveal.tsx`). Swap de vista = `<FadeSwap swapKey>`. PRM: neutralizador global; solo añadir rama PRM por-componente cuando la primitiva cambia a un visual estático distinto (beacon→halo).

**Componentes compartidos obligatorios:** `<ModalShell>` (EL diálogo canónico — jamás hand-roll un backdrop) · `<OverlayRoom>` + `<RoomClose>` (superficies full-screen z40, fondo ambiental canónico `radial-gradient(ellipse at 20% 10%, var(--brass-faint), transparent 50%), var(--color-octo-onyx)`) · `<StageDots stages tone?>` (micro-track universal 5px) · `beaconAnchor()` (`src/lib/beacon.ts` — exactamente UN elemento pulsando brass por scope de atención, ley inviolable) · `<OctoMark size state>` (mascota; `pushed` para momentos de unlock) · `<UpgradeSheet>` + `awaitProAfterCheckout()` (`src/lib/awaitPro.ts`) para todo paywall/checkout · Atelier Listbox `[main-only, v0.4.14]` para todo selector desplegable.

**Reglas de colocación ("la UI nueva vive aquí"):** el contrato Atelier fija 5 superficies (Rail 48px · ContextHeader flotante · Modes pill · Canvas · Companion 280px · Input bar). TODO lo nuevo de este plan vive en: **Companion** (tarjeta Logbook por misión), **el Canvas de un modo**, **Settings**, o un **`OverlayRoom`** (Logbook Room, Mission Control ya lo es). Cero chrome nuevo de primer nivel, cero tabs, cero cuarta fuente, cero acento nuevo.

**Checklist anti-flicker / continuidad (aplicar a CADA slice frontend):**
- [ ] Geometría fija: toda tarjeta/slot reserva su altura (patrón `CrewCard` de Mission Control: "geometry never jumps"). Nada de layout shift al llegar datos.
- [ ] Nada monta/desmonta en seco: entrada con la primitiva correspondiente; salida vía FadeSwap/Reveal; contenido colapsado queda montado + `inert`.
- [ ] Estado loading: **no existe skeleton/shimmer en el design system y no se inventa** — se reserva la geometría y el contenido entra con `.octo-fade-in` al estar listo.
- [ ] Estado vacío: `<OctoMark state="idle">` + una línea sage + CTA frase serif upright cuando aplique.
- [ ] Estado error: línea rouge inline (`text-octo-rouge`), sin modales de pánico.
- [ ] Grep del diff: cero hex (`#[0-9a-fA-F]{3,8}`), cero `font-family` fuera de styles.css, cero `italic`, cero `transition:all`, cero glifos retirados (`§`, romanos, `✦`, brass-rule, `⟶` fuera de los 3 sitios sancionados), iconos solo lucide-react y siempre con `title`.
- [ ] Copy 100% en inglés (labels, placeholders, aria-labels, tooltips, empty states).
- [ ] Verificación EN LA APP (WebKit), no solo vitest: focus programático, clipboard, user-activation.

---

## 3. Plan movimiento a movimiento

> Convención de nombres de slice: `M<mov>.<n>`. Cada slice = 1 PR contra main = 1 release patch. Ejecución profunda y lista-para-picar en M1 y M2; arquitectura + slices + gating en M3–M5 con fronteras explícitas de "detalle al llegar".

---

### M1 — Misiones como entidad de primer nivel

**Meta:** la misión existe en la base de datos, nace ANTES que la rama en el wizard, y el Rail + Mission Control hablan de misiones. Al terminar M1, un usuario nunca más "crea un workspace": comienza una misión, y el worktree es una consecuencia.

#### M1.1 — La espina dorsal: tabla `missions` + backfill + chip de intención (release 1)

**Backend (`src-tauri/src/`):**

1. **`db.rs` — migración** (append en `Db::migrate()`, patrón idempotente sin version-table):

```rust
self.conn.execute_batch(r#"
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,                  -- NULL permitido: misiones design/probe sin worktree (M4)
  project_id TEXT NOT NULL,
  intent TEXT NOT NULL,               -- build|fix|review|probe|design|perf|ops
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- active|done|archived
  linked_issue_key TEXT,
  git_isolation TEXT NOT NULL DEFAULT 'worktree',  -- worktree|readonly|ephemeral|pr
  exec_isolation TEXT NOT NULL DEFAULT 'none',     -- none|sandbox|container|cloud (cloud reservado M5)
  payload TEXT NOT NULL DEFAULT '{}', -- JSON por-tipo (recap M2.3, config M4)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_missions_project ON missions(project_id, created_at DESC);
-- Invariante "nunca dos misiones escribiendo un checkout": índice parcial único sobre escritores
CREATE UNIQUE INDEX IF NOT EXISTS idx_missions_writer
  ON missions(workspace_id)
  WHERE status = 'active' AND workspace_id IS NOT NULL
    AND git_isolation IN ('worktree','pr','ephemeral');
"#)?;
```

2. **Back-refs** vía el helper existente `add_column_if_missing` (traga "duplicate column name"):
   - `add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN mission_id TEXT")?;`
   - Ídem para `chat_threads` y `terminals` (tabla `terminals` confirmada en db.rs, ~línea 169).
   - **ATENCIÓN ejecutor:** no hay ORM — cada lectura lista columnas por posición. Añadir `mission_id` obliga a actualizar CADA `SELECT` + closure de mapeo de esas tres tablas en `db.rs`. Buscar todos los `SELECT ... FROM runs`, `FROM chat_threads`, `FROM terminals` y añadir la columna al final de la lista + al struct.

3. **Backfill one-shot** (patrón `app_meta`): re-parenting workspaces→missions.

```rust
if self.meta_get("missions_backfill_v1")?.is_none() {
    // 1 workspace existente = 1 misión 'build' con su worktree
    self.conn.execute_batch(r#"
    INSERT INTO missions (id, workspace_id, project_id, intent, title, status,
                          linked_issue_key, git_isolation, exec_isolation, payload,
                          created_at, updated_at, archived_at)
    SELECT lower(hex(randomblob(16))), w.id, w.project_id, 'build',
           CASE WHEN w.task <> '' THEN w.task ELSE w.name END,
           CASE WHEN w.status = 'archived' THEN 'archived' ELSE 'active' END,
           w.linked_issue_key, 'worktree', 'none', '{}',
           w.created_at, w.last_active,
           CASE WHEN w.status = 'archived' THEN w.last_active ELSE NULL END
    FROM workspaces w
    WHERE NOT EXISTS (SELECT 1 FROM missions m WHERE m.workspace_id = w.id);
    UPDATE runs SET mission_id =
      (SELECT m.id FROM missions m WHERE m.workspace_id = runs.workspace_id)
      WHERE mission_id IS NULL;
    UPDATE chat_threads SET mission_id =
      (SELECT m.id FROM missions m WHERE m.workspace_id = chat_threads.workspace_id)
      WHERE mission_id IS NULL;
    UPDATE terminals SET mission_id =
      (SELECT m.id FROM missions m WHERE m.workspace_id = terminals.workspace_id)
      WHERE mission_id IS NULL;
    "#)?;
    self.meta_set("missions_backfill_v1", "done")?;
}
```

   Nota: el índice parcial `idx_missions_writer` se satisface porque el mapeo es 1:1. Misiones archivadas quedan fuera del índice (`status='active'`).

4. **`MissionRow`** al fondo de `db.rs` junto a `WorkspaceRow`, con `#[derive(serde::Serialize,...)] #[serde(rename_all="camelCase")]` — espejo 1:1 de la tabla. Métodos db: `insert_mission`, `list_missions(project_id)`, `get_mission`, `mission_for_workspace(ws_id)`, `update_mission_status`, `update_mission_title`, `touch_mission(updated_at)`.

5. **Módulo compartido `src-tauri/src/mission.rs`** (espejo del rol de `workspace.rs`: un solo camino usado por comandos Tauri Y el bin `octopush-mcp`): `create(db, project_id, intent, title, git_isolation, exec_isolation, workspace_id, linked_issue_key) -> AppResult<MissionRow>` — valida los dos enums, valida el invariante escritor (si el índice único dispara, mapear a error legible), estampa timestamps. Además `create_for_workspace(db, ws: &WorkspaceRow, intent: &str) -> AppResult<MissionRow>`.

6. **Emparejamiento automático:** en el comando `create_workspace` (`commands.rs`) y en `ensure_main_workspace`, tras el `workspace::create(...)` exitoso, llamar `mission::create_for_workspace(...)` con intent `'build'` (el wizard pasará el intent real en M1.2). Garantiza desde el día 1: **no existe workspace sin misión**. El outcome `Existed|Restored|Adopted` reutiliza la misión existente vía `mission_for_workspace` (idempotencia).

7. **Comandos** en `commands.rs` + registro en el único `tauri::generate_handler![...]` de `lib.rs`: `create_mission`, `list_missions`, `get_mission`, `update_mission` (title/status/linked_issue_key), `archive_mission`. `archive_mission` de una misión con workspace delega en el camino de archive existente (`archive_workspace`, con sus guardas `is_project_root`/`owns_worktree_on_disk` — nunca rm de un dir vivo).

**Frontend (`src/`):**

1. **`src/lib/ipc.ts`** — nueva sección `// ─── Missions ───` con wrappers tipados finos (`invoke<MissionRow>("create_mission", {...})`; opcionales TS coalescidos a `null`, nunca `undefined`).
2. **`src/stores/missionsStore.ts`** (zustand plano, patrón de `workspaceStore`): `missionsByProjectId: Record<string, Mission[]>`, selector `missionByWorkspaceId`, acciones `load(projectId)`, `loadAll`, `create`, `archive`, `update`. **NO es un segundo store de selección** — la selección sigue viviendo en `workspaceStore.activeId`; la "misión activa" es un selector derivado (`missionByWorkspaceId[activeId]`).
3. **ContextHeader — chip de intención:** encima del nombre del workspace, eyebrow `INTENT · BUILD` en mono 10px uppercase tracking .25em `text-octo-mute` con icono lucide (`Hammer` build / `Wrench` fix, siempre con `title`). **Sin brass** (el brass es quirúrgico; un chip permanente no lo merece). Altura reservada en el card flotante (cero layout shift); el chip entra con `.octo-fade-in` cuando el store resuelve.

**Spec UX del slice:** un solo elemento visible (el chip), tokens mute/hairline, `.octo-fade-in`, tooltip `title="Mission intent"`. Copy en inglés.

**Gating:** ninguno (gratis). No aplican los 5 pasos.

**Tests:**
- `cargo test` (`src-tauri/src/tests.rs`): migrate() dos veces seguidas es no-op (idempotencia); backfill crea 1 misión por workspace y no duplica en segunda pasada; el índice `idx_missions_writer` rechaza una segunda misión activa escritora sobre el mismo workspace; back-refs pobladas.
- vitest: `missionsStore.test.ts` (load/create/selector derivado).
- En-app: abrir proyecto existente → chip visible con `BUILD`; crear workspace → misión emparejada aparece.

**`docs/FEATURES.md`:** retitular `## 2. Projects & Workspaces` → `## 2. Projects, Missions & Workspaces`; bullet nuevo `- **Missions (threads of intent)** — ... _Support:_ missions table, mission.rs, create_mission/list_missions..., missionsStore. _Entry:_ automatic pairing on workspace creation.`; Appendix B: DDL de `missions` + back-refs; Appendix A: los 5 comandos nuevos.

**Criterios de aceptación:** DB de un usuario real (con proyectos/workspaces/runs históricos) migra sin pérdida; segunda apertura no re-ejecuta backfill; typecheck + vitest + cargo verdes; chip visible sin flicker en los 8 themes.

#### M1.2 — El wizard "intención antes que rama" (release 2)

**Frontend:**

1. **`git mv src/components/WorkspaceCreator.tsx src/components/MissionCreator.tsx`** — actualizar los 3 call sites en `App.tsx` (rail "+", empty-project inline, ticket-driven).
2. **Paso nuevo 1 de 3 — "Intent"** (antes del actual "Task & intent"): pregunta serif `font-serif` ivory **"What is this mission about?"** bajo eyebrow `STEP 1 OF 3` (mono-brass, arábigo — los `StepIndex` existentes). Dos tarjetas (M1; M4 añade cuatro más):
   - **Build** — icono `Hammer`, título serif "Build something new", descripción sage "A feature, a surface, a capability."
   - **Fix** — icono `Wrench`, título serif "Fix something broken", descripción sage "A bug, a regression, a rough edge."
   - Tarjetas: `bg-octo-panel`, borde `border-octo-hairline`; seleccionada → borde `var(--brass-dim)` + fondo `var(--brass-ghost)`; entrada `.octo-rise-in` con stagger 45ms; navegación ←/→ + Enter + atajos `1`/`2`; foco programático al montar (gotcha WebKit: focus explícito, no confiar en autofocus).
3. **Paso 2 "Task & branch"** = el actual paso 1 (TASK autofocus, BRANCH derivado `slugify(task)` — mantener byte-idéntico al `slugify()` de `workspace.rs` —, `BaseBranchPicker` con `ipc.listBranches`, `PrPicker` con `ipc.ensurePrBranch`). Se añade un disclosure **"Isolation"** colapsado vía `<Reveal open>`: un Atelier Listbox `[main-only]` con el eje git:
   - **"Own worktree"** (default, preseleccionado — el default incuestionado para código)
   - **"Ephemeral — auto-archived when the mission is done"**
   - **"From a PR head"** (equivale al flujo PrPicker existente; elegir un PR en el picker selecciona esta opción automáticamente — un solo estado, dos entradas)
   - `readonly` NO se ofrece aquí todavía (llega con M4, donde es el default de probe/review). El eje ejecución llega en M3.1. **Cero opciones muertas en UI.**
4. **Paso 3 "Setup script"** = el actual paso 2, sin cambios (recordado por-proyecto vía `useCompanionPrefs`).
5. CTA final: frase serif upright **"Begin the mission"**. `FadeSwap swapKey={String(step)}` entre pasos (ya existe). Escape guardado por `e.defaultPrevented` (ya existe).
6. Flujo de creación: `useWorkspaceStore().create(projectId, projectPath, name, task, branch, base, setupScript)` → el comando `create_workspace` **extendido con params opcionales `intent: Option<String>` y `git_isolation: Option<String>`** que fluyen al emparejamiento `mission::create_for_workspace`. Luego `ipc.updateWorkspaceLink` si `linkIssueKeyOnCreate` (existente) + espejo en `missions.linked_issue_key`.

**Backend:** extender firma de `create_workspace` en `commands.rs` (y el tool MCP `create_workspace` con default `'build'`); comportamiento `ephemeral`: al llamar `update_mission(status='done')` o `archive_mission` sobre una misión `git_isolation='ephemeral'`, el backend encadena el archive del workspace por el camino existente (guardas `owns_worktree_on_disk` intactas — jamás rm de un dir no-managed).

**Gating:** ninguno (decisión tomada: el picker es gratis, §2a).

**Tests:** vitest de flujo de pasos (intent→task→setup) y del mapping PrPicker→`git_isolation='pr'`; cargo del passthrough de intent y del encadenado ephemeral→archive; en-app: teclado completo (1/2, flechas, Enter, Escape), foco correcto en WebKit, los 3 call sites abren el wizard.

**FEATURES.md:** §2 — reescribir el bullet del wizard (3 pasos, intent-first, isolation disclosure); Appendix C sin cambios (mismos atajos).

**Aceptación:** crear misión build con worktree default en <10s sin tocar el disclosure; crear misión ephemeral y verificar auto-archivado al completarla; cero flicker entre pasos.

#### M1.3 — El Rail se re-ancla a misiones (release 3)

**Frontend:**

1. `App.tsx` construye `ProjectGroup[]` (el shape que consume `WorkspaceRail.tsx`, puro presentacional) desde **`missionsStore` join `workspaceStore`**: cada fila = misión activa; sus chips git (`gitSummaryByWs`, `prByWs`, `runningByWs`) se resuelven vía `mission.workspaceId`. Misiones archivadas fuera (como hoy los workspaces archivados).
2. `WorkspaceRow` (dentro de `WorkspaceRail.tsx`): el monograma incorpora el glifo de intent (lucide 12px, `title` con el intent); se mantienen intactos la barra 3px brass/tint, `.rail-bar-running`, StatusChips (ticket/ahead-behind/PR/dirty) y el pulso de atención (`useAttentionStore().flagsByWs` — keyed por ws id, mapeado vía `mission.workspaceId`; la regla `showPulse = flag && !active && (isCollapsed || !running)` no cambia).
3. Selección: `onSelect(mission)` → `workspaceStore.select(mission.workspaceId)` (un solo store de selección, sin duplicar estado). Prop forward-compat: la fila tolera `workspaceId === null` (misiones M4 sin worktree) renderizando monograma con borde hairline discontinuo — se especifica en M4, aquí solo no romper el tipo.
4. Vocabulario (barrido fase 1, solo Rail): empty state **"No missions yet."** + CTA serif **"Begin a mission"**; aria-labels en inglés (`aria-label="Missions in {project}"`). El colapso por-proyecto persiste en localStorage `railProjectCollapsed` (sin cambios).

**Backend:** ninguno.

**Gating:** ninguno.

**Tests:** vitest del builder de `ProjectGroup[]` (misión↔workspace join, archivadas fuera, orden); en-app: pulso de atención, marcha `.rail-bar-running`, colapso 0fr↔1fr, los 8 themes.

**FEATURES.md:** §2 bullets del Rail (fila = misión); §1 navegación si menciona "workspace rail" textualmente.

**Aceptación:** paridad visual total con el Rail actual salvo el glifo de intent; cero regresión de pulso/chips; selección idéntica en comportamiento.

#### M1.4 — Mission Control asciende a cabina de misiones (release 4)

Hoy `src/components/MissionControl.tsx` (OverlayRoom, `⌘⇧M` + chip fleet del `RunsTray` en AppTopBar) lee **solo** `useRunsStore().runsByWs` (runs DIRECT). Asciende a cabina de TODO lo que reclama atención en la flota de misiones.

**Frontend:**

1. El `useMemo` del board pasa a **unión discriminada** (el patrón previsto por el propio componente): `type BoardItem = { kind: "run"; run: Run } | { kind: "attention"; missionId: string; workspaceId: string; flag: "chat" | "terminal"; at: number }`. Los items `attention` provienen de `useAttentionStore().flagsByWs` mapeados a misión vía `missionsStore`.
2. Bandas sin cambio de mecánica: `needs-you` (runs pausados + flags de atención) | `in-flight` (running) | `settled` (settledAt local de sesión). Orden FIFO por `statusSince`/`at`.
3. `CrewCard` para `kind:"run"`: sin cambios de geometría (slots fijos); la línea de nombre pasa de `useWorkspaceName` a **título de misión + glifo de intent** (mute). Para `kind:"attention"`: **`AttentionCard`** nueva, misma altura fija que CrewCard (geometry never jumps), glifo lucide `MessageSquare`/`Terminal` + palabra de estado ("waiting in Talk" / "terminal bell") + título de misión + tiempo-en-estado (`useTimeInState` reusado); click → `onJumpToRun`-equivalente que selecciona el workspace y fuerza `mode="talk"`/abre terminal.
4. **Ley 2 intacta y extendida:** `beaconAnchor()` decide el ancla sobre la unión completa de `needs-you` (FIFO) — exactamente UNA tarjeta con `.octo-stage-pulse`; el resto borde brass estático. PRM → halo estático.
5. `RunsTray` (AppTopBar): el contador fleet suma los flags de atención como punto mute adicional (no brass — el brass del tray sigue reservado al beacon fleet).

**Backend:** ninguno.

**Gating:** ninguno (Mission Control es navegación — gratis, como hoy).

**Tests:** vitest del reducer del board (unión, FIFO, ley 2 sobre unión mixta); en-app: pausa un run + provoca un bell de terminal en otra misión → solo el más antiguo pulsa; jump correcto de AttentionCard; `⌘⇧M` monta/desmonta con `.octo-fade-in` sin flicker.

**FEATURES.md:** §1 — bullets de Mission Control actualizados (cobertura: runs DIRECT + atención chat/terminal por misión; ley del beacon sobre la unión).

**Aceptación:** Mission Control muestra la flota completa de misiones que necesitan al director; cero regresión en cards de runs; un solo pulso brass siempre.

#### M1.5 — Paridad MCP (release 5, fino)

El bin `octopush-mcp` (autoría read+author, sin ejecución) gana: `list_missions`, `get_mission`, `create_mission` (vía el módulo compartido `mission.rs` — mismo camino que Tauri, cero lógica duplicada), y el tool existente `create_workspace` acepta `intent` (default `'build'`, emparejamiento automático ya garantizado por M1.1). Actualizar el instructions string del server.

**Gating:** ninguno. **Tests:** cargo de los tools nuevos. **FEATURES.md:** §9 (Integrations: Jira, MCP & Skills) — contador de tools y bullets.

---

### M2 — El Logbook

**Meta:** telemetría de trabajo nativa — **horas + costo + narrativa por misión y proyecto** — como la memoria del taller. Es la feature premium insignia del reencuadre y la primera semilla real de Team.

**LA DECISIÓN DE SECUENCIA (el bloqueo duro):** el gasto de DIRECT hoy **no llega a `token_events`** (4 ledgers desconectados; 3 de 4 modelos actuales pricean a $0; el session_id está sobrecargado de 3 maneras). Un Logbook que omita silenciosamente DIRECT en una herramienta DIRECT-first sería mentiroso — inaceptable. **Decisión: el rebuild de token-accounting Fases 0→2 se pliega DENTRO de M2 como prerequisito explícito (M2.0), no se esquiva diseñando alrededor.** Razones: (a) el rebuild ya tiene plan propio escrito y beneficia budgets/usage/projection independientemente del Logbook; (b) diseñar el Logbook contra un shape futuro Y gatearlo parcialmente crearía dos versiones de la verdad durante meses; (c) el Logbook es la feature que le da al rebuild su retorno visible (el rebuild solo es plomería — juntos son una release con impacto UX, que es lo que el fundador exige de cada release). Las horas (`work_spans`) no dependen del rebuild, así que M2.1 puede solaparse con el final de M2.0.

#### M2.0 — Prerequisito: rebuild de token-accounting, Fases 0→2 (releases 6–7)

- Ejecutar `docs/superpowers/plans/2026-07-17-token-accounting-rebuild.md` (hoy propuesto/sin commitear — **primera acción: commitearlo enmendado**) Fases 0, 1 y 2: ledger canónico único **`spend_events`** (surface ∈ talk/run/direct/review/adhoc, `project_id`/`workspace_id`/`source_id` denormalizados, `cost_basis`, clave de idempotencia) + UNA autoridad de pricing + `check_budget` backend único.
- **Enmienda de este plan al rebuild (una línea):** `spend_events` lleva además **`mission_id TEXT` denormalizado (nullable)**, poblado en el punto de escritura (el emisor conoce workspace → `mission_for_workspace`) y backfilleado para histórico vía las back-refs de M1.1. Es la columna que hace agregable el Logbook (y, mañana, el rollup Team).
- Las Fases 3 (budgets) y 4 (RUN telemetry) del rebuild NO bloquean el Logbook — siguen su curso propio después.
- Releases según defina el plan del rebuild (estimo 2). Gating: ninguno (contabilidad correcta es para todos).
- **FEATURES.md:** §8 (Providers, Models, Tokens, Budgets & Usage) según el plan del rebuild.

#### M2.1 — Horas: `work_spans` + resumen + tarjeta Companion (release 8)

**Backend:**

1. **`db.rs`** — tabla nueva (mismo patrón migrate):

```sql
CREATE TABLE IF NOT EXISTS work_spans (
  id TEXT PRIMARY KEY,
  mission_id TEXT,
  workspace_id TEXT,
  project_id TEXT NOT NULL,
  surface TEXT NOT NULL,      -- talk|direct|terminal|review
  source TEXT NOT NULL,       -- chat|stage|pty|edit
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_spans_mission ON work_spans(mission_id, started_at);
CREATE INDEX IF NOT EXISTS idx_work_spans_project ON work_spans(project_id, started_at);
```

2. **Instrumentación — regla de coalescing única** (helper `db::record_activity(mission_id, workspace_id, project_id, surface, source)`): buscar el span más reciente de la misma `(mission_id, surface)` con `ended_at > now - 10min` → `UPDATE ended_at = now`; si no → `INSERT` nuevo span de duración 0. Throttle en memoria: máximo 1 escritura/60s por `(mission_id, surface)` (un `Mutex<HashMap>` en `AppState`; el worker detached escribe directo — abre el mismo SQLite). Puntos de gancho:
   - **TALK:** persistencia de `chat_messages` en el ChatEngine (`state.chat`).
   - **DIRECT:** transiciones de stage en `orchestrator/mod.rs` (started/finished de `run_stages`) — cubre in-process Y el worker detached (`orchestrator/worker.rs` re-deriva de DB y comparte el camino).
   - **Terminal:** actividad PTY en el PtyManager (throttled — el ruido de un `tail -f` no debe fabricar horas: solo input del usuario + primeras salidas tras input).
   - **REVIEW/edits:** insert de `file_edits`.
3. **Definición de horas (decidida):** horas de una misión = **unión de intervalos** de sus spans (merge en Rust tras fetch — nunca sumar superficies solapadas, eso inflaría; el desglose por superficie se muestra aparte, sin sumar al total).
4. **Comando `logbook_summary(scope_type: String, scope_id: Option<String>, from: String, to: String) -> AppResult<Vec<LogbookMissionRow>>`** — `scope_type ∈ "mission"|"project"|"global"`. `LogbookMissionRow { mission_id, title, intent, status, hours_secs, cost_usd, savings_usd, runs_count, messages_count, per_surface: Vec<(surface, secs)> }` (serde camelCase). Costo desde `spend_events` por `mission_id` (M2.0); savings desde la mecánica baseline existente (`orchestrator/cost.rs::baseline_cost`) agregada por misión donde exista.
5. **Gate backend (paso 2 de la receta):** `scope_type != "mission"` → `require_logbook_reports()` (espejo exacto de `require_history_sync()`), que verifica `Entitlement::current().has_feature(feature::LOGBOOK_REPORTS)` o retorna `AppError::UpgradeRequired { feature: "logbook.reports", used: 0, limit: 0 }`. El scope misión es gratis por diseño (el anzuelo).

**Frontend:**

1. `ipc.ts`: sección `// ─── Logbook ───`, wrapper `logbookSummary(...)`.
2. **`src/stores/logbookStore.ts`**: `summaryByScope`, acción `load(scope, from, to)`, invalidación al recibir eventos `run://*` relevantes (throttled).
3. **Tarjeta "Logbook" en Companion** (Talk y Direct): `<Reveal>` colapsable, eyebrow mono `LOGBOOK`, tres cifras de la misión activa hoy: horas (`.octo-tabular`, sage), costo (`text-octo-brass`), savings (verdigris). Geometría reservada; cifras entran con `.octo-fade-in`. Click en la tarjeta → abre el Logbook Room (M2.2) en scope misión. Empty state: línea mute "No work recorded yet."

**Gating (los 5 pasos, key `logbook.reports`):** paso 1 declarar key en `entitlement.rs` `mod feature` + `Entitlement::pro().features`; paso 2 `require_logbook_reports()` sobre scope project/global y sobre `logbook_export` (M2.2); paso 3 el frontend pre-checka `hasFeature("logbook.reports")` antes de ofrecer el switch de scope; paso 4 rama en UpgradeSheet (copy en M2.2); paso 5 FEATURES.md §4 "Entitlement & quota".

**Tests:** cargo — coalescing (dos actividades a <10min = un span; a >10min = dos), merge de unión de intervalos (solape talk+terminal no duplica), gate de scope (Free + project → UpgradeRequired estructurado); vitest — logbookStore, tarjeta Companion (estados vacío/cargado); en-app — sesión real de 10 min de TALK + un run → horas plausibles, costo coincide con Usage.

**FEATURES.md:** §8 — bullet `- **Logbook (work telemetry)** — hours (activity-span union) + cost + savings per mission. _Support:_ work_spans table, record_activity, logbook_summary, logbookStore, Companion card. _Entry:_ Companion → Logbook card.`; §4 entitlement; Appendix A/B.

**Aceptación:** las horas pasan la prueba del olfato (una sesión de 30 min reales reporta ~30 min, no 90 por triple conteo); el costo por misión cuadra con `spend_events`; Free ve su misión, el switch de scope muestra el UpgradeSheet.

#### M2.2 — El Logbook Room (release 9)

**Frontend:**

1. **`src/components/LogbookRoom.tsx`** — `<OverlayRoom ariaLabel="Logbook">` + `<RoomClose>`, fondo ambiental canónico, montado solo mientras abierto (patrón Mission Control). Entradas: atajo **`⌘⇧L`** (registrar en Appendix C), click en la tarjeta Companion (M2.1), y una línea al pie de Mission Control — frase serif mute→brass-hi al hover: **"Open the Logbook"**.
2. Layout: eyebrow mono-brass `LOGBOOK` · H1 serif ivory **"The record of the work"** · selector de scope (Mission / Project / All — Atelier Listbox; opciones no-mission con glifo lock lucide + `title="Pro"` cuando `!hasFeature`) · selector de período mono (`7D · 30D · CUSTOM`).
3. Tabla de misiones: filas `.octo-rise-in` stagger 45ms; columnas: glifo intent + título (ivory) · horas `.octo-tabular` sage con desglose por superficie en tooltip `title` · costo brass · savings verdigris · runs count mono mute · `<StageDots>` mini del último run. Orden: horas desc. **Totales del período** en cabecera fija (geometría reservada, `.octo-tabular`).
4. Footer: CTA frase serif **"Export this ledger"** → `logbook_export` (CSV/JSON). Free → pre-check + UpgradeSheet.
5. Estados: vacío → `<OctoMark state="idle">` + sage "Nothing in the log for this period. Hours and cost appear as agents work."; error → línea rouge; carga → geometría reservada + `.octo-fade-in` (sin skeleton — no existe en el sistema).

**Backend:** comando `logbook_export(scope_type, scope_id, from, to, format: "csv"|"json") -> AppResult<String>` (ruta del archivo escrito), **gated entero** por `require_logbook_reports()` (paso 2). Reusar la mecánica de los export existentes de RUN (`export_session_json/csv`).

**UpgradeSheet (paso 4)** — rama nueva del ternario por `feature === "logbook.reports"`: eyebrow `THE LOGBOOK` · título serif **"Every hour, every dollar, remembered."** · cuerpo sage "Roll hours, cost and savings up across every mission and project, pick any period, and export the ledger." · footer ghost "Maybe later" + solid brass **"Upgrade to Pro"** (frases sancionadas exactas). Checkout vía `upgrade()` → `billingCheckoutUrl()` → navegador → `awaitProAfterCheckout()` (toast "You're on Pro — premium unlocked.").

**Gating:** pasos 3–5 de la receta completados aquí (el 1–2 se hicieron en M2.1).

**Tests:** vitest — room (scopes, período, lock states), rama de UpgradeSheet; cargo — export gated, shape CSV/JSON estable (snapshot); en-app — `⌘⇧L` sobre escStack correcto (solo el topmost responde), flujo Free completo hasta el sheet, flujo Pro hasta el archivo, 8 themes, PRM.

**FEATURES.md:** §1 (superficie nueva OverlayRoom + atajo), §8 (export), §4 (entitlement), Appendix A (`logbook_export`), Appendix C (`⌘⇧L`).

**Aceptación:** un usuario Pro responde "¿cuánto costó y cuánto tiempo tomó esta semana?" en <5 segundos; un Free entiende exactamente qué compra; cero flicker al abrir/cerrar el room.

#### M2.3 — Narrativa: recap por misión + digest (release 10)

1. **Comando `generate_mission_recap(mission_id)`**: compone contexto (título/intent, stages y verdicts de runs, títulos de threads, conteo de file_edits, horas/costo del período) → una llamada vía ChatEngine con el modelo del usuario (BYOK) → párrafo breve + bullets, guardado en `missions.payload.recap = { text, at, model }` (JSON — sin migración). **Gratis** (es cómputo del usuario; lo que se vende es la agregación, no la llamada — coherencia con la línea).
2. UI: en el Logbook Room, click en una fila → drill-in de misión (FadeSwap dentro del room, patrón B2 run-detail `[main-only]`): spans por superficie, runs con StageDots, y el recap con CTA serif **"Write the recap"** / **"Refresh the recap"**. También visible en la tarjeta Companion (línea 1 del recap, mute).
3. **Digest del período (cross-misión) = parte del scope Pro:** el botón **"Write the week's digest"** vive en scope Project/All → ya está detrás de `logbook.reports` por construcción (no requiere key nueva). La generación usa BYOK igualmente — lo gated es la vista agregada, explícitamente documentado así en FEATURES.md para que la línea quede auditable.
4. **Semilla Team explícita:** el shape del digest (JSON en payload) es el que octopush-api agregaría por-seat.

**Tests:** cargo (recap persiste en payload, no rompe misiones con payload previo); vitest (drill-in, estados); en-app (recap real con modelo local Ollama — el camino BYOK-gratis funciona sin cuenta).

**FEATURES.md:** §8 bullets recap/digest con la nota de línea BYOK.

**Aceptación:** el recap se genera con CUALQUIER proveedor configurado incluido Ollama local sin login; el digest solo desde scopes Pro.

---

### M3 — Sandboxing de ejecución + unattended

**Meta:** el segundo eje de aislamiento se vuelve real: una misión puede ejecutar sus agentes dentro de un sandbox local (seatbelt) o un container, y correr desatendida — **extendiendo** el sustrato detached ya enviado (v0.4.8), jamás duplicándolo.

**Arquitectura (fijada, sin re-investigación):**
- **Punto de inyección ÚNICO: `cli_runner.rs`.** Hoy `CliRunner::run` hace `tokio::process::Command::new(resolve_executable("claude", path)).args(args).current_dir(&ctx.workspace_path).env(login_shell_env())...spawn()` — el cwd es HOY la única frontera. El sandbox envuelve `program`/`args` justo ahí: `sandbox-exec -f <profile> claude ...` (macOS seatbelt). Un solo wrapper, compartido por ejecución in-process Y el worker detached (ambos pasan por `CliRunner`), y por `orchestrator::launch::launch_run` — **cero segunda capa de aislamiento** (constraint no-collide honrada por construcción).
- **Perfil seatbelt generado por-run** al scratchpad: deny-write por default; allow-write: `ctx.workspace_path`, `$TMPDIR`, dirs de sesión del CLI (`~/.claude`); red permitida (los agentes la necesitan); allow-read general. **Variante read-only** (write solo `$TMPDIR`): la primitiva de enforcement que M4 usa para probe/review.
- **Plumbing:** `exec_isolation` viaja de `missions` → `create_run`/`start_run` → `RunContext` (campo nuevo `exec_isolation` + `allowed_write_roots`). El worker detached lo re-deriva de DB como todo lo demás (`drive_inner` re-deriva estado — sin estado cross-proceso nuevo).
- **Container (M3.2):** mismo wrapper, `container`/`docker run` con mount rw solo del workspace. La spec de imagen (base, binario claude, credenciales) es **"detalle al llegar"** — depende de decisiones de imagen/licencia que no condicionan M3.1/M3.3.
- **Frontera DIRECT slice 4:** nada de esto toca la semántica del grafo de stages (condicionales/branching pertenecen a slice 4 — cero colisión).

**Slices:**

- **M3.1 — Sandbox local (release 11).** Backend: wrapper seatbelt en `cli_runner.rs` + generación de perfil + plumbing `RunContext`; fallo de `sandbox-exec` → error legible, sin fallback silencioso a sin-sandbox (la seguridad no degrada en silencio). Frontend: el disclosure "Isolation" del wizard (M1.2) gana el **segundo Listbox "Execution"**: "None (default)" / "Local sandbox"; ContextHeader muestra glifo lucide `Shield` mute con `title="Sandboxed execution"` cuando aplica (junto al chip de intent, geometría reservada). **Gating: GRATIS** (decisión §2a — la seguridad no se cobra). Tests: cargo del builder de perfil; en-app: run sandboxed intenta escribir fuera del workspace → bloqueado y visible en el journal; run normal intacto. FEATURES.md §4 (RUN/Direct) + §2 (wizard).
- **M3.2 — Container (release 12).** Wrapper container + selección "Container" en el Listbox (aparece solo si runtime detectado — cero opciones muertas). Imagen: detalle al llegar. **Gating: GRATIS** (cómputo local del usuario).
- **M3.3 — Misiones desatendidas (release 13).** No es infraestructura nueva: es la COMPOSICIÓN sandbox (M3.1) × detached (v0.4.8: `octopush-run-worker` + lease en `runs` worker_nonce/worker_pid/heartbeat_at + bridge ~1.2s re-emitiendo `run://*`) × notificaciones de crew (v0.4.7). Slice: toggle **"Run unattended"** en el launcher de DIRECT (frase serif; Free → lock + pre-check `hasFeature("runs.detached")` → UpgradeSheet — **key existente REUSADA, no se crea otra**); recomendación activa de sandbox al ir unattended (línea sage "Unattended missions run best sandboxed", un click lo activa — nudge, no imposición); el worker respeta `exec_isolation` (gratis por M3.1, ya compartido). Tests: en-app — misión desatendida sandboxed sobrevive cierre de app (lease + reattach del bridge), notificación de checkpoint llega. FEATURES.md §4 + §4-entitlement.

---

### M4 — Tipos de misión no-código

**Meta:** el picker de intención completa su espectro: **review · probe · design · perf** — misiones que no escriben código y por eso eligen otras coordenadas de aislamiento. Aquí el reencuadre paga: el mismo modelo (misión + dos ejes) expresa trabajo que hoy no cabe en "un workspace".

**Arquitectura (fijada):**
- **Depende de M3.1**: `readonly` se vuelve *read-only-by-construction* (perfil seatbelt read-only), no una promesa en el prompt. Por eso M4 va después de M3.1 — decidido, sin ambigüedad.
- **review / probe / perf:** `git_isolation='readonly'`, `workspace_id` = el workspace "main" del proyecto (worktree_path == project root, garantizado por `ensure_main_workspace`). Múltiples misiones readonly comparten checkout legalmente — el índice `idx_missions_writer` solo restringe escritores. **Invariante anti-alucinación:** cada misión tiene sus PROPIOS chat_threads/sesiones/terminales (back-refs `mission_id` de M1.1) — checkout compartido, contexto jamás compartido.
- **design:** `workspace_id = NULL` (la columna es nullable por diseño desde M1.1). Artefactos en `~/.octopush/missions/<mission_id>/` — fuera del repo, checkout limpio.
- **Superficies:** las misiones no-código viven en los modos existentes (TALK canvas para probe/design, REVIEW para review) — cero chrome nuevo. El Rail las muestra con monograma de borde hairline discontinuo (prop preparada en M1.3).
- **perf:** probe especializado que siembra un pipeline template ("Perf probe") vía la autoría existente — sin mecanismo nuevo de ejecución.

**Slices:**

- **M4.1 — review + probe (release 14).** Backend: aceptar readonly en `mission::create` (workspace main + perfil read-only plumbed a `RunContext`); TALK/threads scoped por `mission_id` (el ChatEngine filtra threads por misión activa — **detalle al llegar** sobre el shape exacto post-M1: depende de cómo quedó el selector de misión activa). Frontend: 2 tarjetas nuevas en el paso Intent (`Eye` "Review the work" / `FlaskConical` "Probe a question"), eyebrow pasa a grid de 4; `git_isolation` default readonly para ambas (el disclosure lo muestra, no editable a escritor para estos intents — invariante en UI Y backend). Gating: intents gratis; volumen/concurrencia/unattended ya cubiertos por keys existentes. FEATURES.md §2 + §3 + §5.
- **M4.2 — design (release 15).** Misiones sin workspace: Rail discontinuo, TALK bound a misión sin repo cwd (cwd = dir de artefactos), artefactos listados en Companion. Detalles de la superficie de artefactos: **detalle al llegar** (depende de qué produzcan las primeras misiones design reales).
- **M4.3 — perf (release 16).** Template de pipeline sembrado + tarjeta `Gauge` "Chase a regression". Detalle del template: al llegar.

**Nota no-task-manager (guardia activa):** ninguna misión no-código gana campos de estimación/fecha/asignación. Una misión probe que concluye "hay que arreglar X" termina con un CTA "Begin a fix mission" (nace OTRA misión, execution-anchored) o "Send to Jira" (el backlog vive fuera). Ese CTA es la frontera del producto.

---

### M5 — Adaptador cloud (tardío, tercero)

**Meta:** `exec_isolation='cloud'` deja de estar reservado: una misión puede ejecutarse en un sandbox efímero de un proveedor tercero. **Octopush no construye nube propia** — intermediamos, con la misma UX.

**Arquitectura (fijada en lo estructural):**
- Trait **`ExecBackend`** en `orchestrator/launch` con dos impls: `Local` (todo lo de hoy — cli_runner con o sin sandbox) y `CloudAdapter` (aprovisiona sandbox remoto, sube contexto/repo ref, ejecuta el MISMO sustrato CLI, streamea eventos). El bridge detached ya demostró el patrón "otro proceso ejecuta, la app tailéa y re-emite `run://*`" — el adaptador cloud es el mismo contrato con transporte HTTP: **la UI entera (Mission Control, journal, notificaciones) funciona sin cambios**, que es exactamente el retorno de haber respetado no-collide.
- Resultado vuelve como PR o patch — nunca escritura directa al checkout local.
- El lease en `runs` sigue siendo la verdad de "quién ejecuta"; el adaptador es un holder más del lease.
- **Gating:** key nueva **`exec.cloud`**, Pro (los 5 pasos al construir). El proveedor cobra cómputo: decisión de modelo de margen y partner = del fundador (§7).

**Slices (bosquejo — no ejecutar antes de M1–M4):** M5.1 trait + config del adaptador en Settings (token del proveedor); M5.2 primer proveedor end-to-end. Todo lo demás: detalle al llegar, dependiente del partner.

---

## 4. La espina dorsal del modelo de datos (consolidado)

**Tabla `missions`** (DDL completo en M1.1): dos enums de aislamiento — `git_isolation ∈ worktree|readonly|ephemeral|pr` (default `worktree`) y `exec_isolation ∈ none|sandbox|container|cloud` (default `none`; `cloud` reservado hasta M5) — `workspace_id` **nullable** (design/probe pueden vivir sin worktree), `payload` JSON para datos por-tipo (recap, config), FK a `projects` con CASCADE.

**Back-refs:** `runs.mission_id`, `chat_threads.mission_id`, `terminals.mission_id` — nullable, vía `add_column_if_missing`, con actualización de TODOS los SELECT posicionales (sin ORM). `spend_events.mission_id` llega con M2.0.

**La migración de re-parenting (M1.1, one-shot vía `app_meta` key `missions_backfill_v1`):** cada workspace existente se convierte en una misión `build` con su worktree (`git_isolation='worktree'`), título = task o nombre, status e issue-key copiados; runs/chat_threads/terminals reciben su `mission_id` por join de workspace. Idempotente por `WHERE NOT EXISTS` + el meta-key.

**Invariantes (en orden de sacralidad):**
1. **Nunca dos misiones escribiendo un checkout** — índice parcial único `idx_missions_writer` (escritores = worktree/pr/ephemeral activos) + validación legible en `mission::create`. Los readonly comparten libremente.
2. **Aislamiento de contexto SIEMPRE, independiente del worktree** — threads/sesiones/terminales pertenecen a UNA misión (back-refs); dos misiones sobre el mismo checkout jamás comparten contexto de agente. Este es el invariante anti-alucinación del producto.
3. **readonly/design son read-only-by-construction** — tras M3.1, perfil seatbelt (write solo $TMPDIR / dir de artefactos), no una promesa de prompt.
4. **Las guardas destructivas existentes mandan** — `managed`/`created_branch` atómicos al insert, default false ante duda; `is_project_root`/`owns_worktree_on_disk` gatean todo rm; jamás borrar un dir presente-pero-roto. Las misiones ephemeral archivan por el camino existente, sin atajos.
5. **No existe workspace sin misión** (emparejamiento automático desde M1.1) y toda misión de código tiene exactamente un workspace.

---

## 5. Secuencia y grafo de dependencias

```
Fase 0 (rama off origin/main)
│
├── CARRIL A (misiones/UX) ──────────► M1.1 → M1.2 → M1.3 → M1.4 → M1.5
│                                        │
├── CARRIL B (ledger) ── M2.0 (rebuild F0→2; F2 espera a M1.1 por mission_id)
│                                        │
│                    ambos carriles convergen ▼
│                          M2.1 → M2.2 → M2.3   (Logbook completo)
│                                        │
├── M3.1 (sandbox; requiere M1.2 wizard) → M3.2 → M3.3 (unattended)
│                     │
├── M4.1 (requiere M3.1 read-only) → M4.2 → M4.3
│
└── M5 (último; requiere M1–M3 y partner)
```

- **Paralelizable:** el carril B (M2.0, backend de contabilidad) corre en paralelo con M1.2–M1.5 (frontend/wizard/rail) — archivos disjuntos, dos ejecutores sin pisarse. La Fase 2 del rebuild espera a M1.1 (necesita las back-refs para poblar `spend_events.mission_id`).
- **Dependencias duras:** Logbook (M2.1+) ⇐ M2.0 completo (regla: jamás un Logbook que omita DIRECT) y ⇐ M1.1. M4.1 ⇐ M3.1 (read-only real). M3.3 ⇐ M3.1. M5 ⇐ todo.
- **Frontera DIRECT slice 4 (depth-routing):** avanza independiente y en paralelo; este plan NO toca la semántica del grafo de stages. Si slice 4 aterriza durante M3/M4, cero conflicto por construcción (dominios disjuntos: aislamiento/telemetría vs. topología del DAG).
- **Rebuild Fases 3–4** (budgets/RUN-telemetry): siguen su plan propio tras M2.0, sin bloquear nada de aquí.
- Cada slice: review de subagente fresco antes y después del PR → findings atendidos → auto-merge → release patch. 16 releases estimadas para M1–M4 completos.

---

## 6. Riesgos y qué preservar

1. **El invariante anti-alucinación.** El mayor riesgo técnico del reencuadre: dos misiones sobre un checkout compartido contaminándose contexto. Mitigación: back-refs desde M1.1, threads/sesiones siempre scoped por misión, tests cargo explícitos de scoping, y el índice de escritores. Si alguna vez hay que elegir entre una feature y este invariante, gana el invariante.
2. **Deriva a task manager.** Cada slice nuevo será una tentación ("¿y si la misión tuviera due date?"). La guardia: misiones nacen execution-anchored (agentes/terminales/artefactos presentes), el backlog vive en Jira/GitHub, y el CTA frontera es "Begin a fix mission"/"Send to Jira" (M4). Este plan no añade NI UN campo de planificación — cualquier PR que lo intente cita este párrafo y se rechaza.
3. **Commoditización del foso.** La industria acaba de validar los worktrees — ya no son diferenciador, son mesa de entrada. El foso se muda a lo que este plan construye: la **cabina** (Mission Control sobre la flota), la **memoria** (Logbook con costo/horas/narrativa que nadie más tiene porque nadie más ES la superficie de operación), y la **honestidad** (savings ledger, contabilidad canónica). Riesgo residual: copiar la cabina es más fácil que copiar la telemetría acumulada — por eso el Logbook es la feature insignia, y por eso su schema se diseña agregable (Team) desde el día 1.
4. **Local-first: fuerza y debilidad.** Fuerza: el Logbook es privado por defecto (SQLite local), argumento de venta frente a telemetrías cloud involuntarias. Debilidad: multi-máquina y equipo requieren el canal de sync (Pro, `history.sync`) y un día octopush-api agregando por-seat. La decisión de si el Logbook cruza la máquina es del fundador (§7) — el plan deja ambas puertas abiertas sin comprometer ninguna.
5. **Deuda de renombrado.** "Workspace" seguirá existiendo en código (tabla, structs, stores) aunque la UI diga "mission". Se acepta deliberadamente: renombrar la tabla `workspaces` sería una migración destructiva sin valor de usuario. La frontera: **UI copy dice missions (barrido en M1.3/M1.4); el código conserva workspace como término de infraestructura git.** Documentado en FEATURES.md Appendix B para que nadie "arregle" la inconsistencia.
6. **Seguridad que degrada en silencio.** El sandbox jamás hace fallback silencioso a sin-sandbox (M3.1); unattended recomienda sandbox activamente (M3.3). Un incidente de un agente desatendido escribiendo fuera de su misión sería letal para la confianza — el costo de un error legible es siempre menor.

---

## 7. Decisiones abiertas para el fundador

Todo lo demás está decidido en este plan. Solo estos tres forks son genuinamente tuyos:

1. **Team: precio y momento.** Las semillas quedan plantadas (shapes agregables, keys nombradas, `for_plan()` como único punto de cableado). Construir el tier exige trabajo de servidor (octopush-api agregando por-seat) y seats en Dodo. ¿Lo priorizamos tras M2 (cuando el Logbook agregable exista y sea demostrable) o tras M4? Mi lectura: tras M2, si aparece demanda entrante; no antes.
2. **Privacidad del Logbook: ¿local estricto o sincronizable?** Opción A: el Logbook JAMÁS sale de la máquina (argumento de privacidad puro; Team se construiría sobre agregados explícitamente exportados). Opción B: bajo `history.sync` (Pro), el Logbook viaja como ya viaja `synced_runs` (continuidad multi-máquina hoy, rollup Team mañana, pero "tus horas están en nuestro servidor"). El plan funciona con ambas; mi recomendación es B con toggle explícito en Settings, pero la postura de privacidad es identidad de marca — tuya.
3. **Partner cloud para M5 y modelo de margen.** ¿Qué proveedor de sandboxes efímeros, y cobramos passthrough (estilo BYOK, cero margen, pura conveniencia) o bundled (margen sobre cómputo)? Depende de partnerships y no condiciona nada de M1–M4.

---

*Fin del plan. Cada slice referencia sus archivos, tablas, comandos, tokens y primitivas exactas — un ejecutor no necesita re-escanear el codebase, solo re-confirmar líneas locales contra main (Fase 0).*
