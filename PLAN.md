# Estela — Plan de arquitectura

> HackMeridian 2026 · Plan acordado el 2026-10-25 · **Todavía no se ha construido nada de este plan.**

## 1. Producto

Estela es un **Booking/Travala en web3** sobre Stellar:

- **Producto A, ticket del evento**: el cliente compra la entrada a un evento de un organizador socio.
- **Producto B, paquete completo**: ticket + vuelo + hotel.
- Estela es el **merchant of record** de los viajes: el cliente paga en stablecoin (USDC/EURC) a un escrow on-chain y Estela compra los vuelos y hoteles en **Duffel** pagando en fiat.
- Los **organizadores socios cobran directo** su parte del ticket desde el escrow (`payee`).
- **Login y wallet con Pollar**: el usuario entra con Google o email, sin frases semilla y sin pagar comisiones de red.
- **Fidelización propia** con NFTs de OpenZeppelin: `EstelaPass` (membresía con XP y nivel) + `EstelaStamps` (sellos de evento y viaje).

### Decisiones tomadas
| Tema | Decisión |
|---|---|
| Qué vendemos | Ticket solo **y** paquete completo |
| Cómo cobramos | Escrow on-chain; Estela como merchant of record de los viajes |
| Proveedor de viajes | **Duffel** (vuelos + Stays) |
| Organizadores socios | **Cobran directo** con un `payee` en el contrato |
| Login y wallet | **Pollar** |
| Luma | **Sin Luma Plus** → sin API ni webhooks |
| Stellar Passport | **No se puede integrar** → fidelización propia |
| NFTs | Opciones **A (EstelaPass) + C (EstelaStamps)** con OpenZeppelin **0.8.0** |
| Niveles | Explorer 0 · Voyager 500 · Globetrotter 2 000 · Legend 5 000 XP → 0 / 5 / 10 / 15 % |
| XP | 1 XP por unidad confirmada (USDC/EURC) + 100 por sello de evento + 50 por viaje completado |

## 2. Qué está construido (commit `93a4793`)

- **Contrato `EstelaEscrow`** (`contracts/estela-escrow`), en Rust con soroban-sdk 29 y 12 tests.
  - `create_booking` (admin, precio y plazos exactos) → `fund` (viajero) → `release` (fondos a la treasury).
  - `refund(id, to_traveler)` (reembolso parcial por política), `cancel` (viajero, antes de `refund_until`), `reclaim` (viajero, si no se confirmó antes de `confirm_by`).
  - Emite `BookingChanged { id, status, amount }` en cada cambio.
- **Despliegue en testnet** (`deploy/testnet.json`): contrato `CBOIYZWJMSMNET35AO2ZVJXGP5BM3HQVTLIH4TZCOCUC35N6BRS2CPIE`. Acepta **USDC y EURC oficiales de Circle en testnet** + XLM. El smoke test create → fund → release pasó.
- **Bindings TS** (`packages/estela-escrow`).
- **Scaffold Next.js 15** (`apps/web`), sin interfaz real.

**Falta**: escrow v2 (payee + XP), contratos de fidelización, backend, base de datos, login con Pollar, interfaz, Duffel y off-ramp.

## 3. Duffel (proveedor de viajes)

[Duffel](https://duffel.com) es una **API de viajes** que permite **buscar, reservar, cambiar y cancelar vuelos** de cientos de aerolíneas y **hoteles** (*Duffel Stays*) sin ser una agencia acreditada IATA.

**Vuelos** (disponible al crear la cuenta):
1. `offerRequests.create` (origen, destino, fecha, pasajeros, cabina) → lista de `offers`.
2. `offers.get(id)` justo antes de reservar: las ofertas caducan rápido y el precio puede cambiar.
3. `orders.create` con `selected_offers`, `passengers` (nombre, apellidos, fecha de nacimiento, género, email, teléfono) y `payments: [{ type: "balance", amount, currency }]` → `booking_reference`.
   - `type: "balance"` = se paga desde el **saldo prefinanciado de Estela en Duffel** (nuestro float en fiat).

**Hoteles, Duffel Stays** (**no viene activado por defecto**: hay que **pedir acceso** desde su página de contacto):
1. `stays.search` (ubicación o alojamientos, fechas, huéspedes) → `search_result_id`.
2. `stays.searchResults.fetchAllRates` → `rate_id`.
3. `stays.quotes.create` (confirma disponibilidad) → `quote_id`.
4. `stays.bookings.create` (con huéspedes y contacto).

**Modo test**: con un token de prueba del dashboard se reserva sin dinero real.
**Precio**: según fuentes de terceros, unos $3 por orden + 1 %. Hay que verificarlo en duffel.com.

## 4. Eventos y tickets

Sin Luma Plus no podemos registrar asistentes ni recibir webhooks de Luma.

**Fuentes del catálogo**
1. Eventos de **organizadores socios**, creados en el panel de Estela (precio, cupo, fechas, política de cancelación y **wallet del organizador** = `payee`).
2. **Importar por URL** un evento público de Luma: el admin completa fecha, ciudad y precio.

**Emisión del ticket**
| Caso | Qué hace Estela |
|---|---|
| Organizador socio | **Estela emite el ticket** (con escrow). El organizador **cobra directo** su parte al `release`. Check-in por QR → sello NFT |
| Evento gratis en Luma | Vende el viaje o paquete y da el link de registro de Luma |
| Evento de pago en Luma | No se puede emitir por API → fuera del MVP |

**Eventbrite**: su API no permite crear órdenes ni buscar eventos públicos → fase posterior.

**Organizadores**: también entran con Pollar, que les crea una wallet con los trustlines de USDC/EURC ya configurados. Esa dirección es su `payee`.

## 5. Contratos

### 5.1 EstelaEscrow v2 (cambios sobre v1)
Se añade a `Booking`:
- `payee: Option<Address>`: wallet del organizador socio (vacío en reservas sin organizador).
- `payee_amount: i128`: la parte del organizador (precio del ticket menos la comisión de Estela).

Reglas de dinero (el dinero solo puede ir al viajero, al `payee` o a la treasury):
- `create_booking(..., payee, payee_amount)`: valida `0 <= payee_amount <= amount` y que `payee_amount == 0` si no hay `payee`.
- `release(id)`: `payee_amount` → organizador; el resto (`amount - payee_amount`) → treasury (cubre Duffel + comisión). Después llama a **`EstelaPass.add_xp(traveler, amount / 10^7)`**.
- `refund(id, to_traveler, to_payee)`: el admin aplica la política. Se valida `to_traveler + to_payee <= amount` y `to_payee <= payee_amount`; el resto va a la treasury.
- `cancel` y `reclaim`: sin cambios (100 % al viajero).
- **Un paquete con ticket de un socio = una sola reserva**: el viajero firma un solo `fund` y un solo `release` reparte entre organizador y treasury.
- Al constructor se le añade la dirección de `EstelaPass`.
- Tests nuevos: reparto en `release`, `refund` con tres destinos, validaciones del payee y XP otorgado solo en `release`.

### 5.2 Fidelización con OpenZeppelin `0.8.0`
Crates: `stellar-tokens` (`non_fungible`), `stellar-access` (AccessControl), `stellar-macros` (`#[only_role]`, `#[only_admin]`). Requieren **soroban-sdk ^28**. **Resuelto (spike, 2026-10-25):** las sdk 28 y 29 no pueden convivir en un mismo workspace (fijan pre-releases incompatibles de `soroban-wasmi`), así que **todo el workspace pasa a soroban-sdk 28**. Los 12 tests del escrow siguen pasando y los dos contratos compilan a wasm.

**`EstelaPass`** (opción A): un NFT **soulbound** por cliente
- `ContractType = Base`; `transfer`, `transfer_from` y `approve` **sobrescritos para que fallen** (intransferible, con test).
- Guarda `xp` y `level` por usuario.
- `add_xp(user, amount)` con `#[only_role(caller, "awarder")]`: si el usuario no tiene pase, **lo acuña** (perezoso) y luego suma XP y recalcula el nivel.
- `remove_xp(user, amount)` (rol `awarder`): por si se reembolsa una reserva ya confirmada.
- Lectura: `xp_of`, `level_of`, `token_of`.
- Metadatos con `set_metadata(base_uri, "Estela Pass", "EPASS")`: el backend sirve el JSON y la imagen según el nivel actual.
- Roles `awarder`: **EstelaEscrow**, **EstelaStamps** y el backend.

**`EstelaStamps`** (opción C): un NFT **soulbound** por evento asistido o viaje completado
- `ContractType = Enumerable` (para listar "mis sellos") + `Burnable` (para revocar un sello fraudulento); transfer bloqueado.
- `mint_stamp(user, kind, ref_id)` con `#[only_role(caller, "issuer")]`. `kind` = `Event` | `Trip`. Uno por `(user, kind, ref_id)`.
- Al acuñar llama a `EstelaPass.add_xp` (+100 si es evento, +50 si es viaje).
- Rol `issuer`: el backend.

**Check-in con QR (reemplaza el de Passport)**: el asistente muestra en la app un QR con su wallet y un código de un solo uso (firmado por el backend, válido 60 s) → el staff lo escanea con la app de Estela → el backend verifica que tenga ticket y que no haya entrado ya → `mint_stamp(Event)`.
**Viaje completado**: una tarea del backend, al pasar la fecha de regreso de una reserva confirmada → `mint_stamp(Trip)`.

**Niveles** (se calculan en `EstelaPass`): Explorer 0 · Voyager 500 · Globetrotter 2 000 · Legend 5 000 XP. Descuento de 0 / 5 / 10 / 15 % aplicado en la cotización (el precio final lo fija el admin en `create_booking`) + ventana de cancelación más larga en niveles altos.

### 5.3 Quién cobra qué (organizador vs. Duffel)

- El **organizador socio** es el **organizador del evento** (conferencia, meetup, festival) que vende sus entradas en Estela. No tiene relación con el viaje.
- **Duffel no aparece en el contrato**: se le paga **en fiat, fuera de la cadena**, desde el saldo prefinanciado de Estela. La parte de la **treasury** cubre ese costo más el margen de Estela.

**Ejemplo (ilustrativo): paquete de 900 USDC = ticket 150 + vuelo y hotel 750**
| Concepto | Monto | Quién lo recibe | Cómo |
|---|---|---|---|
| Ticket del evento menos la comisión de Estela | 138 USDC | **Organizador** (`payee_amount`) | On-chain, del escrow al confirmar |
| Comisión del ticket + vuelo y hotel + margen | 762 USDC | **Treasury de Estela** | On-chain, del escrow al confirmar |
| Vuelo + hotel (costo) | ≈ 690 USDC en € | **Duffel** | Fiat, desde el saldo de Estela (pagado al reservar) |

Secuencia: el viajero paga 900 al escrow → Estela reserva en Duffel con su saldo → si confirma, `release` (138 al organizador, 762 a la treasury, 900 XP al viajero) → la treasury convierte a € y repone el saldo de Duffel.

| Tipo de reserva | `payee` | Treasury |
|---|---|---|
| Solo ticket de un organizador socio | Organizador (precio − comisión) | La comisión |
| Paquete con evento de un socio | Organizador (su parte del ticket) | Comisión + vuelo y hotel + margen |
| Paquete con evento gratis de Luma | Ninguno | Todo |
| Solo viaje | Ninguno | Todo |

En un `refund`, `to_payee` es lo que el organizador se queda según su política. Si Duffel ya cobró algo no recuperable, Estela lo absorbe desde la parte de la treasury.

## 6. Modelo de negocio: qué gana Estela

### Fuentes de ingreso
| # | Fuente | Cómo funciona | Rango orientativo (a decidir) |
|---|---|---|---|
| 1 | **Comisión sobre tickets** de organizadores socios | Se descuenta de su parte: `payee_amount` = precio − comisión | 5–10 % del ticket |
| 2 | **Margen sobre vuelos** | Precio al cliente = costo Duffel + cargo de servicio fijo (los vuelos dejan poco margen) | 5–15 € por pasajero |
| 3 | **Margen sobre hoteles** | Precio al cliente = costo Duffel Stays + markup (el margen hotelero es mayor) | 8–15 % |
| 4 | **Prima de paquete** | El paquete combinado tiene un margen algo mayor que la suma de las partes, a cambio de la comodidad y del XP | +2–5 % |
| 5 | **Servicios para organizadores** (B2B, fase posterior) | Eventos destacados, analítica de asistentes, paquetes de viaje "oficiales" del evento | Suscripción o tarifa por evento |

### Costos que hay que cubrir con ese margen
- **Duffel**: tarifa por orden (según terceros, ~$3 + 1 %; verificar en duffel.com).
- **Off-ramp** (MYKOBO u otro): comisión por convertir USDC/EURC a € en lotes (verificar).
- **Pollar**: créditos por las wallets y el patrocinio de comisiones de red.
- **Descuentos por nivel** (0 / 5 / 10 / 15 %).
- Comisiones de red de Stellar (mínimas).

### Reglas para que el modelo cierre
- **El descuento por nivel sale del margen de Estela, nunca de la parte del organizador.** Se aplica sobre el cargo de servicio, el markup y la comisión, no sobre el costo de Duffel ni sobre `payee_amount`.
- El quote service garantiza un **margen mínimo** después del descuento: si un descuento lo dejaría en negativo, se limita.
- Las reservas de ticket solo de un evento gratis no generan ingresos → solo se ofrecen como parte de un paquete.

### Ejemplo de unidad (ilustrativo) con el paquete de 900 USDC
| Línea | USDC |
|---|---|
| Comisión del ticket (8 % de 150) | +12 |
| Margen vuelo + hotel (750 − 690) | +60 |
| Tarifa Duffel (~3 + 1 % de 690) | −10 |
| Off-ramp (supuesto 0,5 % de 690) | −3,5 |
| **Margen bruto sin descuento** | **≈ 58,5 (6,5 %)** |
| Con nivel Voyager (5 % sobre el margen de 72 → −3,6) | ≈ 54,9 |

Los porcentajes son supuestos para dimensionar; las tarifas reales de Duffel y del off-ramp hay que confirmarlas.

## 7. Login y wallet con Pollar

- SDK `@pollar/react` (`PollarProvider` + `usePollar()`), con una **publishable key** del dashboard (dashboard.pollar.xyz) en `NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY`.
- `login({ provider: 'google' })` o email → Pollar crea una **wallet G…**, la activa, abre los **trustlines** de los assets configurados en el dashboard (USDC/EURC de Circle testnet) y **patrocina las comisiones**.
  - En testnet la clave la guarda Pollar cifrada; en mainnet es una wallet co-firmada o self-custody (Turnkey).
- **Pagar la reserva (`fund`)**: el backend o el front construye la transacción con nuestros bindings TS → `pollar.signAndSubmitTx(xdr)`. Pollar pide confirmación al usuario (las llamadas a contratos siempre la piden) y aplica el patrocinio de comisiones.
- **Política de transacciones** en el dashboard: subir la comisión máxima si una llamada Soroban supera el límite por defecto (10 XLM).
- Smart wallets con passkey (direcciones C…) existen en Pollar desde la 0.10.1, pero **para el MVP usamos wallets G…** (login social, más probado con XDR propio). Las smart wallets quedan para después.
- Ramps de Pollar: hoy solo LatAm (Abroad, Anclap, Etherfuse, Stereum); Bridge (USD/EUR) en integración. Para Europa, ver la sección 8.

## 8. Escrow cripto → fiat (pago a proveedores)

**Modelo: float en fiat ya cargado (estilo Travala)**

```
Cliente ──USDC/EURC──► EstelaEscrow (bloqueado)
                           │
Estela compra en Duffel con su saldo fiat (payments: balance)
                           │
        ┌── confirmado ──► release → organizador (payee_amount) + treasury (resto)
        │                           treasury → off-ramp por lotes → repone el saldo Duffel
        └── falla/cancela ► refund (100 % o según política)
```

1. Cotización → `create_booking` con `pay_before` = expiración de la oferta de Duffel.
2. El cliente hace `fund` con Pollar y los fondos quedan bloqueados.
3. El orquestador vuelve a pedir la oferta (`offers.get`), y si el precio no cambió, reserva en Duffel con `balance`.
4. Si se confirma → `release` (reparto + XP), y la treasury convierte a fiat **en lotes**.
5. Si Duffel falla o cambió el precio → `refund` del 100 %. Si cancela el cliente → `refund` según la política. Si se cancela el evento → `refund`.

**Off-ramps en Stellar**
| Proveedor | Uso |
|---|---|
| **MYKOBO** | EURC → EUR (SEPA). Encaja con un equipo en España |
| **MoneyGram Access** | USDC ↔ efectivo/fiat, global (SEP-24) |
| **Bitso / Anclap / CLPX** | LatAm (también vía Pollar) |
| **FinClusive** | SEP-31, global |
| **Anchor de prueba de la SDF** | Demo en testnet (SEP-24) |

## 9. Arquitectura

```
┌──────────────── Web (Next.js) ─────────────────┐
│ Catálogo · Checkout · Mis reservas · Estela Pass │
│ Panel organizador · Panel admin · App check-in   │
│ Login y wallet: Pollar (@pollar/react)           │
└───────────────────────┬─────────────────────────┘
                        │
┌──────────────── API Estela (Next.js route handlers) ─┐
│ Quote svc (precio Duffel + ticket + descuento nivel)  │
│ Orquestador de reservas (máquina de estados)          │
│ Adaptadores: Duffel vuelos · Duffel Stays · Luma(URL) │
│ Chain svc: firma admin/issuer (secreto fuera del repo)│
│            + indexador de eventos Soroban             │
│ Loyalty svc: check-in QR → sellos, viaje completado   │
│ Tesorería: saldo Duffel + off-ramp por lotes          │
└──────────┬──────────────────────────┬────────────────┘
       Postgres                Soroban (testnet)
                    EstelaEscrow v2 ──add_xp──► EstelaPass (OZ)
                    EstelaStamps (OZ) ──add_xp──► EstelaPass
```

**Estados de una reserva (en la base de datos)**
```
QUOTED → ESCROW_CREATED → FUNDED → SUPPLIER_BOOKING → CONFIRMED (release + XP)
                                                    ↘ FAILED (refund 100 %)
CONFIRMED → CANCEL_REQUESTED → REFUNDED (según política)
CONFIRMED → (fecha de regreso) → sello Trip
```

### 9.1 Backend: qué hay que construir

Next.js route handlers en `apps/web` + Postgres (Drizzle) + tareas programadas (Vercel Cron). Secretos **solo en el servidor**: clave del admin (`estela-admin`), clave del backend (`estela-backend`: rol `issuer` en Stamps y `awarder` en Pass), secret key de Pollar, token de Duffel y la clave para firmar los QR.

| # | Módulo | Qué hace | Endpoints / tareas |
|---|---|---|---|
| 1 | **Autenticación** | Pollar no expone un token verificable en el servidor, así que usamos **SEP-10** (Stellar Web Auth): el backend genera un challenge, el usuario lo firma con `pollar.signTx(xdr)` y el backend lo verifica (`WebAuth` de `@stellar/stellar-sdk`) → cookie de sesión httpOnly. Roles: viajero, organizador, staff, admin | `POST /api/auth/challenge`, `POST /api/auth/verify`, `POST /api/auth/logout` |
| 2 | **Base de datos** | `users` (wallet, email, rol) · `organizers` (wallet de cobro, comisión) · `events` (socio o URL de Luma, fechas, precio, cupo, política) · `quotes` · `bookings` (= id on-chain, estado, desglose, payee, ids de Duffel, hashes) · `tickets` (secreto QR, check-in) · `stamps` · `xp_ledger` · `chain_cursor` · `jobs` | Migraciones con Drizzle |
| 3 | **Catálogo y panel del organizador** | CRUD de eventos del socio; importar evento de Luma por URL (lee los metadatos públicos, el admin completa) | `GET /api/events`, `POST/PATCH /api/organizer/events`, `POST /api/admin/events/import-luma` |
| 4 | **Cotización** | Pide ofertas a Duffel (vuelos: offer request; hoteles: search → rates → quote), calcula el precio (costo + cargo/markup + comisión), lee `discount_bps_of(user)` del Pass y aplica el descuento **sobre el margen**, con margen mínimo. Caducidad = la de la oferta de Duffel (máx. 15 min). EUR → cobrar en EURC; USD → USDC (evita FX) | `POST /api/quotes`, `GET /api/quotes/:id` |
| 5 | **Orquestador de reservas** | Máquina de estados de la §9: `create_booking` (firma admin) → devuelve la XDR de `fund` para que el usuario firme con Pollar → al ver `Funded`, re-verifica la oferta y reserva en Duffel (`balance`) → `release`, o `refund` si falla. Idempotente, con reintentos; expira lo no pagado | `POST /api/bookings`, `GET /api/bookings/:id`, `POST /api/bookings/:id/cancel`; tarea `process-bookings` |
| 6 | **Servicio on-chain + indexador** | Firma con las claves del servidor usando los bindings TS. El indexador lee `getEvents` del RPC (`BookingChanged`, `XpChanged`, `StampIssued/Revoked`) y actualiza la DB; guarda el cursor (el RPC solo retiene ~7 días) | Tarea `index-chain` (cada minuto) |
| 7 | **Tickets y check-in** | Al confirmar una reserva con evento → ticket. La app del viajero muestra un QR rotativo (HMAC del secreto, válido 60 s); la app del staff lo escanea → valida → `mint_stamp(Event)`. Viaje completado: tarea diaria → `mint_stamp(Trip)` | `GET /api/tickets/:id/qr`, `POST /api/checkin`; tarea `trip-stamps` |
| 8 | **Webhooks de Duffel** | Cancelación o cambio de la aerolínea → reembolso desde la treasury + `remove_xp` | `POST /api/webhooks/duffel` (verificar firma) |
| 9 | **Metadatos de los NFTs** | JSON con nombre, imagen según el nivel y atributos (XP, nivel / evento). Los contratos apuntan aquí con `set_base_uri` | `GET /api/meta/pass/:id`, `GET /api/meta/stamps/:id` |
| 10 | **Panel admin y tesorería** | Reservas, reembolsos manuales, saldo de Duffel, alertas del float, lotes de off-ramp (en el MVP, manual + demo SEP-24) | `/api/admin/*` |

**Orden recomendado para el MVP**: 1 → 2 → 6 → 5 (solo ticket) → 7 → 9 → 4 y 5 con Duffel vuelos → Stays → 8 → 10.

**Base de datos: Supabase** (decidido el 2026-10-25), accedida solo desde el servidor con Drizzle + postgres-js (`prepare: false` para el pooler de transacciones).

**Avance (2026-10-25):**
- ✅ Módulo 1, login SEP-10: `POST /api/auth/challenge`, `/verify` (anti-replay con la tabla `auth_challenges`, crea el usuario y la cookie httpOnly JWT de 7 días), `/logout`, `GET /api/auth/me`. Validez del challenge: 5 min + 30 s de margen (el SDK por sí solo acepta 5 min extra; lo cerramos). 12 tests con vitest.
- ✅ Módulo 2, esquema: 10 tablas con RLS activado y sin políticas (la API anon de Supabase no puede leerlas); migración `apps/web/drizzle/0000_init.sql` **aplicada** en Supabase (región eu-north-1, Postgres 17) el 2026-10-25. Comprobado: la clave pública (anon) no puede insertar ni leer. Para migrar: `node --env-file=.env.local node_modules/drizzle-kit/bin.cjs migrate` (drizzle-kit no lee `.env.local` solo).
- ✅ Cliente de la API de Supabase en el servidor con `@supabase/server` (`src/server/supabase.ts`, `createAdminClient`, solo servidor) para Storage y demás servicios; las tablas siguen por Drizzle. Conexión verificada con el proyecto `cazdoykkxjmhbtpouxqy`. Claves solo en `apps/web/.env.local`.
- ✅ Pantalla de login (`src/components/login-panel.tsx`, `@pollar/react` 0.12): Pollar → `getClient().stellar.sep10.sign({ challengeXdr, homeDomains, webAuthDomain })` (método específico de Pollar para SEP-10; `signTx` no sirve porque por defecto añade un fee bump) → `/api/auth/verify`. Probado de punta a punta contra el servidor y Supabase reales simulando la firma de la wallet (challenge, verify, anti-replay, `me`, errores). ✅ **Probado con una cuenta real de Pollar (Google) el 2026-10-25**: usuario creado en Supabase, wallet `GADRESYS…3ZZHX` en testnet. Las wallets con passkey (C…) no pueden hacer SEP-10; la UI lo avisa.
  - Lo que hizo falta en Pollar: `http://localhost:3000` en **Build → Domains** (origins) + `http://localhost:3000/oauth/callback` (redirect URIs); **créditos** (la app está en modelo de créditos: sin saldo, `POST /auth/login` da 402 → se recargaron 20 USDC de prueba de Circle en la deposit address `GAFQOEER…WUHA`); importar `@pollar/react/styles.css` (sin él la ventana de login sale sin estilos).
  - Google abre una pestaña nueva; el login termina en la pestaña original. La nueva cae en `/oauth/callback`.
- ✅ Módulo 6, servicio on-chain (`src/server/chain/`): `createBooking`/`release`/`refund` firmados por el admin, `buildFundTx` (XDR que firma Pollar en el navegador), `mintStamp` (backend), `getBooking`, `membership`. Probado contra testnet con `npm run test:testnet`.
- ✅ Producto A (ticket de socio) de punta a punta, **probado con Pollar real el 2026-10-25**: catálogo (`GET /api/events`) → `POST /api/bookings` (precio con descuento de nivel tomado de la comisión, reserva en DB + `create_booking`) → Pollar `signAndSubmitTx` → `POST /api/bookings/:id/confirm` (`release`: 4,6 XLM al organizador, 0,4 a la treasury, +5 XP) → ticket emitido. Reservas #1000 y #1001 confirmadas en cadena; ids de reserva empiezan en 1000 (migración 0002). Datos de demo: `node --env-file=.env.local scripts/seed-demo.mjs`.
- ✅ Módulo 7, check-in con QR (2026-10-25): QR rotativo `ticket.ventana.HMAC` (cambia cada 60 s, acepta el minuto anterior; 7 tests), "Mis tickets" con QR en la home, página `/staff` (cámara con jsQR o pegar el código), `POST /api/checkin` (roles staff/organizer/admin leídos de la DB; un organizador solo su evento) → `mint_stamp(Event)` +100 XP; un solo sello por persona y evento aunque tenga varios tickets. Probado contra testnet: sello #1 acuñado, XP 15 → 115, repetición 409. Roles: `scripts/set-role.mjs <wallet> <rol>`.
- ✅ Módulo 9, metadatos NFT (2026-10-25): `GET /api/meta/pass/:id` y `/api/meta/stamps/:id` (JSON estándar: name, description, image, attributes) + `/image` (SVG generado desde el estado on-chain: el pase cambia de color y barra de progreso por nivel; el sello muestra evento, ciudad y fecha). 404 para tokens inexistentes. En la home: tarjeta del pase con su arte y "Mis sellos". 6 tests. **Al desplegar la web**: `set_base_uri` (admin) en EstelaPass → `https://<dominio>/api/meta/pass/` y en EstelaStamps → `https://<dominio>/api/meta/stamps/`.
- ✅ Producto B, paquete con vuelo vía Duffel (2026-10-25): `POST /api/flights/search`, `POST /api/bookings/package` (vuelo + cargo de servicio `FLIGHT_SERVICE_FEE` + ticket opcional; descuento solo del margen; pago en EURC/USDC 1:1 o XLM con `DEMO_XLM_PER_FIAT` solo testnet), confirmación que re-verifica el precio, compra en Duffel con `balance` y libera el escrow; si el precio cambió o Duffel falla → `refund` 100 %. Probado E2E con Duffel test + testnet: reserva #1003, PNR NGN4XR, 63,83 XLM (4,6 al organizador). UI "✈ Añadir vuelo" en cada evento. **Stays (hoteles) da 403: hay que pedir acceso a Duffel.** No probado aún: la ruta de reembolso por cambio de precio.
- ✅ Una reserva viva por viajero y evento: si ya tiene ticket → 409; si tiene una sin pagar dentro de plazo → se retoma (no se crea otra); si ya estaba pagada → solo se confirma.
  - **Pendiente:** la wallet solo tiene XLM; hay que añadir **USDC y EURC de Circle testnet** como assets en el dashboard de Pollar para que abra las trustlines y se pueda pagar el escrow.

## 10. Fases

| # | Fase | Contenido |
|---|---|---|
| 0 | Cuentas y accesos | Duffel (token test + **pedir Stays**), Pollar (app + key), Postgres |
| 1 | Contratos | Spike sdk 28/29 → EstelaEscrow v2 → EstelaPass → EstelaStamps → tests → deploy testnet → bindings |
| 2 | Base web | Pollar login, API, DB, chain svc, indexador |
| 3 | Producto A | Panel organizador, catálogo, checkout, `fund`, `release` con payee, check-in → sello |
| 4 | Producto B | Duffel vuelos + Stays en modo test, orquestador con float simulado |
| 5 | Estela Pass UI | Nivel, XP, sellos, descuento en la cotización |
| 6 | Off-ramp | Demo con el anchor de prueba SEP-24; luego MYKOBO |
| 7 | Más adelante | Smart wallets (passkey), cupones NFT, Eventbrite, mainnet |

**MVP del hackathon = fases 0 a 5 + off-ramp en modo demo.**

## 11. Pasos para empezar

### Paso 0: cuentas (en paralelo, hoy)
1. **Duffel**: crear la cuenta, sacar el token de test y **pedir acceso a Stays ya** (puede tardar).
2. **Pollar**: crear la app en dashboard.pollar.xyz (testnet) → publishable key → añadir USDC y EURC de Circle testnet como assets → activar el patrocinio de comisiones → revisar la política de transacciones.
3. **Base de datos**: Postgres (Supabase o Neon) para el entorno de desarrollo.
4. **Fondos de prueba**: USDC/EURC de testnet en faucet.circle.com para las cuentas de prueba.
5. Definir **dónde vive el secreto del admin** (variables de entorno del servidor, nunca en el repo ni en `NEXT_PUBLIC_*`).

### Paso 1: contratos (lo primero que se programa)
1. ✅ **Spike de compatibilidad** (2026-10-25): sdk 28 y 29 no conviven → workspace en **soroban-sdk 28** + OpenZeppelin `=0.8.0`. El escrow (12 tests) y un `estela-pass` mínimo (soulbound + rol `awarder`, 3 tests) pasan y compilan a wasm.
2. ✅ **EstelaEscrow v2** (2026-10-25): `payee`, `payee_amount`, reparto en `release`, `refund(id, to_traveler, to_payee)`, llamada a `add_xp` (1 XP por unidad; si el contrato de fidelización falla, el `release` sigue adelante y el backend repone el XP). 18 tests con un contrato de fidelización simulado; el wasm compila (10,4 KB).
3. ✅ **EstelaPass** (2026-10-25): soulbound (transfer/approve fallan), se acuña al primer `add_xp`, `remove_xp` sin underflow, XP con saturación, niveles + `discount_bps_of`, evento `XpChanged`, solo el rol `awarder` cambia el XP. 8 tests; wasm de 24,5 KB.
4. ✅ **EstelaStamps** (2026-10-25): Enumerable, soulbound, `mint_stamp(user, Event|Trip, ref_id)` con el rol `issuer` (un sello por `(user, kind, ref_id)`, +100/+50 XP en EstelaPass de forma atómica), `revoke_stamp` solo para el rol `issuer` (quita el sello y su XP sin la firma del dueño; los usuarios no pueden quemar). 9 tests con el EstelaPass real; wasm de 29,5 KB.
5. ✅ **Test de integración** (2026-10-25, crate `contracts/estela-integration`, solo tests, sin wasm): 6 tests con los tres contratos reales y los roles como en el deploy. Cubren el paquete completo (138 al organizador, 762 a la treasury, 900 XP → Voyager, sellos, segundo viaje → Globetrotter), la cancelación sin pagos ni XP, el XP quitado por el backend tras un reembolso tardío, el escrow sin rol que igual paga y la autorización real (solo firma el admin o el issuer; la llamada entre contratos se autoriza sola). Total del workspace: 41 tests.
6. ✅ **Deploy en testnet** (2026-10-25): Pass `CB6ENR37…WL6S`, Stamps `CDQQ7PKX…HF7ZD`, Escrow v2 `CDUARFKL…HCTD`; roles asignados y verificados; `set_base_uri` (admin) añadido para cambiar la URL temporal `https://estela.invalid/meta/...` cuando exista el backend. Smoke test en cadena OK (reserva de 10 XLM con payee + sello → 110 XP). Todo en `deploy/testnet.json`. **Ojo**: subir cada wasm costó entre 3 900 y 6 500 XLM de testnet; se pagó con cuentas desechables de friendbot.
7. ✅ **Bindings TS** regenerados en `packages/estela-escrow`, `packages/estela-pass` y `packages/estela-stamps` (compilan con `tsc`).

### Paso 2: web base
1. `PollarProvider` en `apps/web` + botón de login + mostrar la wallet.
2. Esquema de la base de datos: usuarios, organizadores, eventos, reservas (con el estado), sellos.
3. Chain svc: `create_booking`, `release`, `refund` y `mint_stamp` firmados en el servidor.
4. Primer flujo de punta a punta en testnet: crear la reserva → `fund` con Pollar → `release` → ver el XP.

## 12. Decisiones abiertas

- [ ] ¿**Fecha límite** del hackathon? (para recortar fases si hace falta)
- [ ] **Precios de Estela** (sección 6): comisión sobre tickets (5–10 %), cargo de servicio por vuelo (5–15 €), markup de hoteles (8–15 %), prima de paquete y margen mínimo después del descuento.
- [ ] ¿Base de datos en Supabase o Neon?
- [ ] Producción en España: regulación MiCA/CASP y KYC de pasajeros → asesoría legal (no bloquea el hackathon).

## Fuentes
- Duffel, vuelos: https://duffel.com/docs/guides/getting-started-with-flights
- Duffel, Stays: https://duffel.com/docs/guides/getting-started-with-stays
- Pollar docs: https://docs.pollar.xyz
- OpenZeppelin Stellar NFT: https://docs.openzeppelin.com/stellar-contracts/tokens/non-fungible/non-fungible
- OpenZeppelin stellar-contracts: https://github.com/OpenZeppelin/stellar-contracts · crate: https://crates.io/crates/stellar-tokens
- Luma API (OpenAPI): https://public-api.luma.com/openapi.json
- Anchors SEP-24 / SEP-31: https://developers.stellar.org/docs/platforms/anchor-platform
- Cierre de Amadeus Self-Service: https://ignav.com/docs/amadeus-self-service-shutdown
