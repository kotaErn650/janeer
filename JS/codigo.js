// =============================================
// REFERENCIAS AL DOM
// =============================================
const video        = document.getElementById('video');
const canvasRaw    = document.getElementById('canvasRaw');  // Imagen normal
const canvas       = document.getElementById('canvas');      // Contorno adaptable
const canvasSeg    = document.getElementById('canvasSeg');   // Segmentacion
const ctxRaw       = canvasRaw.getContext('2d');
const ctx          = canvas.getContext('2d');
const ctxSeg       = canvasSeg.getContext('2d');
const info         = document.getElementById('info');
const btnActivar   = document.getElementById('btn-activar');
const visorRow     = document.getElementById('visor-row');
const camPlaceholder = document.getElementById('cam-placeholder');

// Contenedores de etiquetas
const tagsRaw    = document.getElementById('tags-raw');
const tagsCanvas = document.getElementById('tags-canvas');
const tagsSeg    = document.getElementById('tags-seg');

// =============================================
// ACTIVAR CAMARA — solo al pulsar el boton
// =============================================
btnActivar.addEventListener('click', () => {
  btnActivar.disabled = true;
  btnActivar.textContent = "Solicitando permiso...";

  navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
    .then(stream => {
      video.srcObject = stream;
      // Mostrar visores y ocultar placeholder
      camPlaceholder.hidden = true;
      visorRow.hidden = false;
      btnActivar.hidden = true;
      info.textContent = "Camara activada — iniciando procesamiento...";
      console.log("Camara activada correctamente");
    })
    .catch(err => {
      console.error("Error al abrir la camara:", err);
      btnActivar.disabled = false;
      btnActivar.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> Reintentar';
      info.textContent = "No se pudo acceder a la camara. Verifica los permisos en tu navegador e intenta de nuevo.";
    });
});

// =============================================
// CLASIFICADOR DE COLOR — THRESHOLDING
// Devuelve nombre del color o null
// =============================================
function clasificarColor(r, g, b) {
  const max    = Math.max(r, g, b);
  const min    = Math.min(r, g, b);
  const brillo = (r + g + b) / 3;
  const rango  = max - min;

  // BLANCO: muy brillante y baja saturacion
  if (brillo > 200 && rango < 45)
    return "Blanco";

  // NEGRO: muy oscuro
  if (brillo < 45)
    return "Negro";

  // GRIS: brillo medio, saturacion baja
  if (brillo >= 45 && brillo <= 200 && rango < 38)
    return "Gris";

  // NARANJA: rojo alto, verde medio-bajo, azul bajo
  if (r > 160 && g > 60 && g < 165 && b < 90 && r > g + 55)
    return "Naranja";

  // ROJO: canal rojo claramente dominante
  if (r > 120 && r > g + 50 && r > b + 50)
    return "Rojo";

  // VERDE: canal verde claramente dominante
  if (g > 100 && g > r + 40 && g > b + 40)
    return "Verde";

  // AZUL: canal azul claramente dominante
  if (b > 100 && b > r + 40 && b > g + 30)
    return "Azul";

  return null;
}

// =============================================
// MAPA DE ESTILOS POR COLOR
// =============================================
const estilos = {
  Rojo:    { contorno: "#ff4444", mascara: [220,  50,  50] },
  Verde:   { contorno: "#44cc44", mascara: [ 50, 200,  50] },
  Azul:    { contorno: "#4488ff", mascara: [ 50, 100, 220] },
  Naranja: { contorno: "#ffaa00", mascara: [255, 140,   0] },
  Blanco:  { contorno: "#dddddd", mascara: [210, 210, 210] },
  Negro:   { contorno: "#888888", mascara: [ 80,  80,  80] },
  Gris:    { contorno: "#aaaaaa", mascara: [150, 150, 150] }
};

// =============================================
// CONTORNO ADAPTABLE — detecta pixeles de borde
// Usa muestreo configurable para rendimiento
// =============================================
function calcularContorno(mascara, W, H, paso) {
  paso = paso || 2;
  const puntos = [];

  for (let y = paso; y < H - paso; y += paso) {
    for (let x = paso; x < W - paso; x += paso) {
      if (!mascara[y * W + x]) continue;

      // Pixel de borde: alguno de sus vecinos no pertenece al objeto
      const esBorde =
        !mascara[(y - paso) * W + x]     ||
        !mascara[(y + paso) * W + x]     ||
        !mascara[y * W + (x - paso)]     ||
        !mascara[y * W + (x + paso)];

      if (esBorde) puntos.push({ x, y });
    }
  }
  return puntos;
}

// =============================================
// CONVEX HULL — Graham Scan simplificado
// Suaviza el contorno evitando zigzag
// =============================================
function convexHull(puntos) {
  if (puntos.length < 4) return puntos;

  // Punto mas bajo (mayor y) como ancla
  let ancla = puntos.reduce((a, b) => (b.y > a.y || (b.y === a.y && b.x < a.x)) ? b : a);

  const sorted = puntos.slice().sort((a, b) => {
    const angA = Math.atan2(a.y - ancla.y, a.x - ancla.x);
    const angB = Math.atan2(b.y - ancla.y, b.x - ancla.x);
    return angA - angB;
  });

  const hull = [ancla, sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    while (hull.length > 1) {
      const o = hull[hull.length - 2];
      const a = hull[hull.length - 1];
      const b = sorted[i];
      const cross = (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
      if (cross <= 0) hull.pop();
      else break;
    }
    hull.push(sorted[i]);
  }
  return hull;
}

// =============================================
// ESTIMACION DE FORMA GEOMETRICA
// =============================================
function estimarForma(pixeles, bbox, W, H) {
  const densidad = pixeles / (W * H);
  const bw = bbox.maxX - bbox.minX;
  const bh = bbox.maxY - bbox.minY;
  const aspect = bw > 0 && bh > 0 ? bw / bh : 1;

  if (densidad < 0.02) return "Pequeno";
  if (densidad > 0.70) return "Superficie";

  // Aspect ratio para distinguir formas
  if (aspect > 2.5)  return "Horizontal";
  if (aspect < 0.4)  return "Vertical";
  if (densidad > 0.35) return "Grande";
  if (densidad > 0.12) return "Mediano";
  return "Objeto";
}

// =============================================
// RENDERIZAR ETIQUETAS DE COLOR
// =============================================
function renderizarEtiquetas(contenedor, coloresActivos) {
  // Solo re-renderizar si cambiaron los colores
  const actual = Array.from(contenedor.querySelectorAll('.color-tag'))
    .map(el => el.dataset.color).join(',');
  const nuevo = coloresActivos.join(',');
  if (actual === nuevo) return;

  contenedor.innerHTML = "";
  coloresActivos.forEach(color => {
    const tag = document.createElement("span");
    tag.className = "color-tag tag-" + color;
    tag.dataset.color = color;

    const dot = document.createElement("span");
    dot.className = "dot";

    const txt = document.createTextNode(color);
    tag.appendChild(dot);
    tag.appendChild(txt);
    contenedor.appendChild(tag);
  });
}

// =============================================
// DIBUJAR CONTORNO SUAVIZADO (curva de Bezier)
// Funciona sobre cualquier contexto 2D
// =============================================
function dibujarContornoSuave(context, puntos, color, lineaAncho, blur) {
  if (puntos.length < 3) return;

  context.save();
  context.strokeStyle = color;
  context.lineWidth   = lineaAncho;
  context.shadowColor = color;
  context.shadowBlur  = blur;
  context.lineJoin    = "round";
  context.lineCap     = "round";

  context.beginPath();
  context.moveTo(
    (puntos[0].x + puntos[puntos.length - 1].x) / 2,
    (puntos[0].y + puntos[puntos.length - 1].y) / 2
  );

  for (let k = 0; k < puntos.length; k++) {
    const curr = puntos[k];
    const next = puntos[(k + 1) % puntos.length];
    const mx   = (curr.x + next.x) / 2;
    const my   = (curr.y + next.y) / 2;
    context.quadraticCurveTo(curr.x, curr.y, mx, my);
  }

  context.closePath();
  context.stroke();
  context.restore();
}

// =============================================
// DIBUJAR ESQUINAS DEL BOUNDING BOX
// =============================================
function dibujarEsquinas(context, b, color) {
  const bw  = b.maxX - b.minX;
  const bh  = b.maxY - b.minY;
  const esq = Math.min(20, bw * 0.18, bh * 0.18);

  context.save();
  context.strokeStyle = color;
  context.lineWidth   = 2;
  context.globalAlpha = 0.9;
  context.shadowColor = color;
  context.shadowBlur  = 5;
  context.lineCap     = "round";

  // Superior izquierda
  context.beginPath();
  context.moveTo(b.minX, b.minY + esq);
  context.lineTo(b.minX, b.minY);
  context.lineTo(b.minX + esq, b.minY);
  context.stroke();

  // Superior derecha
  context.beginPath();
  context.moveTo(b.maxX - esq, b.minY);
  context.lineTo(b.maxX, b.minY);
  context.lineTo(b.maxX, b.minY + esq);
  context.stroke();

  // Inferior izquierda
  context.beginPath();
  context.moveTo(b.minX, b.maxY - esq);
  context.lineTo(b.minX, b.maxY);
  context.lineTo(b.minX + esq, b.maxY);
  context.stroke();

  // Inferior derecha
  context.beginPath();
  context.moveTo(b.maxX - esq, b.maxY);
  context.lineTo(b.maxX, b.maxY);
  context.lineTo(b.maxX, b.maxY - esq);
  context.stroke();

  context.restore();
}

// =============================================
// FUNCION PRINCIPAL — ejecutada cada frame
// =============================================
function detectarColor() {

  const W = canvas.width;
  const H = canvas.height;

  // --------------------------------------------------
  // CANVAS 1: Imagen original sin procesar
  // --------------------------------------------------
  ctxRaw.drawImage(video, 0, 0, W, H);

  // --------------------------------------------------
  // CANVAS 2: Leer frame para analisis
  // --------------------------------------------------
  ctx.drawImage(video, 0, 0, W, H);
  const frame = ctx.getImageData(0, 0, W, H);
  const data  = frame.data;

  // --------------------------------------------------
  // Estructuras de analisis
  // --------------------------------------------------
  const mascaraColor = new Array(W * H);   // nombre del color por pixel
  const conteo       = {};                  // { "Rojo": N, ... }
  const bbox         = {};                  // bounding box por color

  // Recorrer cada pixel y clasificar
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i     = (y * W + x) * 4;
      const color = clasificarColor(data[i], data[i + 1], data[i + 2]);

      if (color) {
        const idx           = y * W + x;
        mascaraColor[idx]   = color;
        conteo[color]       = (conteo[color] || 0) + 1;

        if (!bbox[color]) bbox[color] = { minX: W, minY: H, maxX: 0, maxY: 0 };
        if (x < bbox[color].minX) bbox[color].minX = x;
        if (y < bbox[color].minY) bbox[color].minY = y;
        if (x > bbox[color].maxX) bbox[color].maxX = x;
        if (y > bbox[color].maxY) bbox[color].maxY = y;
      }
    }
  }

  // Colores activos (por encima del umbral minimo de ruido)
  const UMBRAL = 600;
  const coloresActivos = Object.keys(conteo).filter(c => conteo[c] >= UMBRAL);

  // Color predominante
  let colorPred = null, maxPix = 0;
  coloresActivos.forEach(c => {
    if (conteo[c] > maxPix) { maxPix = conteo[c]; colorPred = c; }
  });

  // --------------------------------------------------
  // CANVAS 3: Imagen de segmentacion por color
  // --------------------------------------------------
  ctxSeg.fillStyle = "#07090f";
  ctxSeg.fillRect(0, 0, W, H);
  const imgSeg = ctxSeg.createImageData(W, H);

  for (let i = 0; i < W * H; i++) {
    const i4 = i * 4;
    const c  = mascaraColor[i];
    if (c && estilos[c]) {
      const m           = estilos[c].mascara;
      imgSeg.data[i4]     = m[0];
      imgSeg.data[i4 + 1] = m[1];
      imgSeg.data[i4 + 2] = m[2];
      imgSeg.data[i4 + 3] = 235;
    } else {
      imgSeg.data[i4]     = 7;
      imgSeg.data[i4 + 1] = 9;
      imgSeg.data[i4 + 2] = 15;
      imgSeg.data[i4 + 3] = 255;
    }
  }
  ctxSeg.putImageData(imgSeg, 0, 0);

  // --------------------------------------------------
  // Por cada color activo: contorno + bbox + etiqueta
  // --------------------------------------------------
  coloresActivos.forEach(color => {
    const b  = bbox[color];
    const bw = b.maxX - b.minX;
    const bh = b.maxY - b.minY;
    if (bw < 12 || bh < 12) return;

    const cLinea = estilos[color].contorno;
    const forma  = estimarForma(conteo[color], b, W, H);

    // Mascara local de este color
    const mascaraLocal = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      if (mascaraColor[i] === color) mascaraLocal[i] = 1;
    }

    // Obtener puntos de borde
    const puntosBorde = calcularContorno(mascaraLocal, W, H, 2);

    if (puntosBorde.length > 8) {
      // Aplicar convex hull para contorno limpio y adaptable
      const hullPuntos = convexHull(puntosBorde);

      // Dibujar en Canvas 2 (contorno sobre imagen real)
      dibujarContornoSuave(ctx, hullPuntos, cLinea, 2.5, 8);

      // Dibujar en Canvas 3 (contorno sobre segmentacion)
      dibujarContornoSuave(ctxSeg, hullPuntos, cLinea, 2.5, 10);
    }

    // Esquinas bounding box en Canvas 2
    dibujarEsquinas(ctx, b, cLinea);

    // Etiqueta flotante en Canvas 2
    const etq = color.toUpperCase() + "  " + forma;
    const tw  = etq.length * 8 + 16;
    const ty  = b.minY > 28 ? b.minY - 26 : b.maxY + 6;

    ctx.save();
    ctx.font      = "bold 12px 'Courier New', monospace";
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(b.minX - 1, ty, tw, 20);
    ctx.strokeStyle = cLinea;
    ctx.lineWidth   = 1;
    ctx.strokeRect(b.minX - 1, ty, tw, 20);
    ctx.fillStyle = cLinea;
    ctx.fillText(etq, b.minX + 6, ty + 14);
    ctx.restore();

    // Etiqueta en Canvas 3 (segmentacion)
    ctxSeg.save();
    ctxSeg.font      = "bold 12px 'Courier New', monospace";
    ctxSeg.fillStyle = "rgba(0,0,0,0.75)";
    ctxSeg.fillRect(b.minX - 1, ty, tw, 20);
    ctxSeg.strokeStyle = cLinea;
    ctxSeg.lineWidth   = 1;
    ctxSeg.strokeRect(b.minX - 1, ty, tw, 20);
    ctxSeg.fillStyle = cLinea;
    ctxSeg.fillText(etq, b.minX + 6, ty + 14);
    ctxSeg.restore();

    // Esquinas en Canvas 3 tambien
    dibujarEsquinas(ctxSeg, b, cLinea);
  });

  // --------------------------------------------------
  // Actualizar etiquetas de los tres paneles
  // --------------------------------------------------
  renderizarEtiquetas(tagsRaw,    coloresActivos);
  renderizarEtiquetas(tagsCanvas, coloresActivos);
  renderizarEtiquetas(tagsSeg,    coloresActivos);

  // --------------------------------------------------
  // Panel de informacion tecnica
  // --------------------------------------------------
  if (coloresActivos.length > 0) {
    const resumen = coloresActivos
      .map(c => c + "(" + conteo[c] + "px)")
      .join("  |  ");
    info.textContent = "Detectado: " + resumen;
  } else {
    info.textContent = "Sin objeto detectado — acerca un objeto de color";
  }

  // Siguiente frame
  requestAnimationFrame(detectarColor);
}

// Iniciar procesamiento cuando el video arranque
video.addEventListener('play', () => {
  detectarColor();
});