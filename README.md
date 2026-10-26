# WTS — Juego Interactivo de Realidad Mixta y Rescate Sísmico

Prototipo interactivo 3D y de Realidad Mixta (**WebXR `immersive-ar`**) inspirado en el proyecto **WTS (Sistema Wearable de Emergencia)**: un arnés pectoral autónomo con sensores biométricos e inerciales, procesamiento local **TinyML**, **capa térmica flexible con control PWM** y radiobaliza **RF Sub-GHz de 433 MHz** (sin necesidad de internet, red celular ni infraestructura eléctrica externa), junto con el **Receptor del Rescatista**.

![Esquemático de referencia WTS](public/esquematico-wts.jpg)

---

## Características Principales

### 1. Ciclo Completo de Emergencia y Dos Modos Jugables + Inspector 3D
- **Modo Persona con el Chaleco (`WTS 014`)**:
  - Experimenta la emergencia desde un hueco estructural tras el terremoto.
  - Desplázate ligeramente, permanece inmóvil para observar el contador inercial o produce **secuencias de golpes rítmicos** (con `Espacio`, botón en pantalla o haciendo clic directamente sobre el chaleco 3D) para activar la alerta **«Posible SOS»** y forzar una transmisión prioritaria en **433 MHz**.
- **Modo Rescatista (3D en navegador y Realidad Mixta WebXR)**:
  - Explora la zona urbana dañada con el **Receptor de 433 MHz** en mano.
  - Alterna entre las 4 balizas (`WTS 014`, `WTS 007`, `WTS 021`, `WTS 032`), interpreta la frescura de los datos, gestiona prioridades y batería, y rastrea mediante **barras RSSI y guía acústica** hasta localizar y rescatar a cada superviviente antes de que termine el tiempo.
- **Inspector Técnico 3D (360°)**:
  - Inspecciona el **Arnés Pectoral** (vista frontal y dorsal) y el **Receptor del Rescatista**, pulsa sus botones físicos y selecciona cada módulo para consultar su rol técnico y compararlo con el boceto conceptual original.

### 2. Funcionamiento Simulado Fiel al Sistema WTS
1. **Signos vitales y movimiento en tiempo real**: simulación dinámica de **Pulso (lpm)**, **SpO₂ (%)**, **Temperatura cutánea (°C)** y acelerometría **IMU (`g` y segundos de inmovilidad)** modulados por frío ambiental, actividad y eventos.
2. **MCU + TinyML local y prioridades educativas inspiradas en START**: clasificación local con indicadores luminosos **`VERDE`**, **`AMARILLO`**, **`ROJO`** y **`NEGRO`**.
   > *Nota educativa explícita*: la prioridad mostrada constituye una simulación orientativa inspirada en triaje START para organizar la búsqueda; **no representa una evaluación médica real ni deduce fallecimiento** por ausencia de señal o pérdida de contacto de sensor.
3. **Detección de golpes rítmicos («Posible SOS»)**: analizador de cadencia en el IMU dorsal que distingue golpes rítmicos intencionales (3+ impactos en ventana rítmica) frente a movimientos ordinarios.
4. **Propagación RF Sub-GHz en 433 MHz realista (sin exigir LoRa)**: cálculo de pérdidas por trayecto, orientación corporal, desvanecimiento multicamino (*multipath*) y **atenuación específica por materiales** (madera, ladrillo, hormigón armado y vigas de acero), generando zonas de sombra donde la señal no atraviesa escombros densos.
5. **Frescura de telemetría en el Receptor**: identificación de baliza, minigráficas en vivo, nivel de batería, estado SOS, RSSI y avisos claros de **`DATO DESACTUALIZADO`** (> 4.5 s) o **`SIN COMUNICACIÓN RF`** (> 10 s, congelando la última lectura válida recibida).
6. **Guía de búsqueda no-GPS**: navegación guiada únicamente por barras RSSI (0–5) y pulsos acústicos Web Audio cuya frecuencia y tono varían al desplazarse y rodear obstáculos, sin flechas GPS ni distancias exactas.
7. **Hipotermia simulada y Capa Térmica Flexible PWM**: animación del circuito calefactor serpentino encendido por pulsos (**PWM**), estabilización y recuperación gradual de la temperatura, incremento medible de consumo (`mW`) y recorte automático a modo ahorro cuando la batería es baja.

### 3. Realidad Mixta (WebXR) y Adaptabilidad PC / Móvil
- **Con soporte WebXR (`immersive-ar` + `hit-test`)**: coloca la maqueta del terremoto sobre una mesa o suelo real mediante cámara AR y desplázate físicamente alrededor de los edificios para buscar señales de 433 MHz.
- **Sin cámara o sin WebXR**: versión 3D completa directamente en navegador con vista en primera persona (receptor 3D en mano) y **Vista Maqueta Espacial**, adaptable a computador (teclado + ratón) y móvil (cruceta táctil y paneles plegables).

---

## Requisitos e Instrucciones de Ejecución

### Requisitos previos
- **Node.js** `>= 18` (probado en Node 22) y **npm** `>= 9`.

### 1. Instalar dependencias
```bash
npm install
```

### 2. Ejecutar en modo desarrollo
```bash
npm run dev
```
Abre en tu navegador la URL mostrada en consola (por defecto `http://localhost:5173`).

> **Nota para Realidad Mixta (WebXR AR) en móvil**: los navegadores móviles (p. ej. Chrome en Android compatible con ARCore) requieren contexto seguro (`https://` o reenvío de puertos `localhost` mediante `chrome://inspect`) para habilitar `navigator.xr.requestSession('immersive-ar')`. Si no está disponible, el juego ofrece automáticamente el modo 3D completo en navegador.

### 3. Ejecutar pruebas automatizadas del motor de simulación
```bash
npm test
```

### 4. Compilar para producción
```bash
npm run build
npm run preview
```

---

## Controles Rápidos

| Acción | Computador (Teclado y Ratón) | Móvil / Pantalla Táctil |
| --- | --- | --- |
| Moverse | `W`, `A`, `S`, `D` o Flechas `↑` `↓` | Cruceta táctil en esquina inferior izquierda |
| Mirar / Orbitar cámara 3D | Arrastrar con el ratón (`clic + mover`) / Rueda para zoom | Arrastrar sobre la escena 3D + botones `↺` / `↻` |
| Golpes rítmicos SOS (Modo Chaleco) | Tecla `Espacio` / `T`, botón **GOLPEAR ARNÉS SOS** o clic sobre el chaleco 3D | Botón táctil **GOLPE SOS** o tocar el chaleco 3D |
| Cambiar de baliza en el Receptor | Botones `◀` / `▶`, pestañas `#014..#032` o teclas `Z` / `X` | Tocar `◀` / `▶` o pestañas superiores del receptor |
| Confirmar localización / Rescatar | Botón **`OK`** en el receptor o teclas `E` / `Enter` al estar cerca (< 4.6 m) | Botón **`OK`** o botón emergente **¡RESCATAR PERSONA!** |
| Activar eventos del escenario | **Panel de Situaciones y Eventos WTS** (Frío, Inmovilidad, Golpes SOS, Señal débil, Batería baja, Sin sensor) | Pestaña **Situaciones** |

---

## Estructura del Proyecto

- `src/types/wts.ts` — Modelos de datos de sensores, tramas RF 433 MHz, enlaces y estados de misión.
- `src/simulation/` — Motor físico y lógico desacoplado:
  - `sosDetector.ts` — Reconocimiento de cadencia rítmica de golpes en el IMU.
  - `tinymlProcessor.ts` — Clasificación local de prioridades educativas START y lazo de control térmico PWM.
  - `rfPropagation.ts` — Propagación Sub-GHz en 433 MHz con intersección geométrica de obstáculos y materiales.
  - `wtsEngine.ts` — Coordinador general de la emergencia, balizas, baterías y registro explicativo en vivo.
- `src/three/` — Modelos 3D procedurales fieles al boceto (`vestModel.ts`, `receiverModel.ts`) y gestor de escena 3D + WebXR (`disasterScene.ts`).
- `src/audio/soundEngine.ts` — Sintetizador procedural Web Audio API sin dependencias de archivos externos.
- `src/components/` — Interfaz reactiva en español (Receptor interactivo, Telemetría del Chaleco, Panel de Situaciones, Inspector 3D, Controles Táctiles y Tutorial).
