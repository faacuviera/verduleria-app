/** JEEO - Cuentas (PWA)
 *  - Guardado local en IndexedDB
 *  - Plantillas (meses) con tablas: ingresos, gastos, cxc, cxp, inventario
 */
import {
  money,
  todayISO,
  monthISO,
  uid,
  csvEscape,
  toCSV,
  download,
  parseCSV
} from "./utils.js";
import {
  validateDateInput,
  validatePositiveAmount,
  validateRequiredText
} from "./validation.js";
import { supabaseClient } from "./supabase.js";

const $ = (id)=>document.getElementById(id);
/* ---------- Logging & non-fatal notifications ---------- */
function createLogger(scope) {
  const prefix = `[${scope}]`;
  const emit = (level, ...args) => {
    const fn = console[level] || console.log;
    fn.call(console, prefix, ...args);
  };
  return {
    info: (...args) => emit("info", ...args),
    warn: (...args) => emit("warn", ...args),
    error: (...args) => emit("error", ...args)
  };
}

const log = createLogger("XA");
const storageStats = { failures: 0 };
const CLOUD_SAVE_DEBOUNCE_MS = 1500;
let supabaseSession = null;
let supabaseUser = null;
let realtimeChannel = null;
let isApplyingRemoteUpdate = false;
let cloudSaveTimer = null;
let appStarted = false;
let currentUserId = null;
let visibilityHandlersBound = false;

function showSoftBanner(message) {
  const host = document.getElementById("appAlerts");
  if (!host || !message) return;

  const el = document.createElement("div");
  el.className = "app-alert";
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("visible"));
  setTimeout(() => {
    el.classList.remove("visible");
    setTimeout(() => el.remove(), 200);
  }, 5200);
}

function announceLive(message, { toast = false } = {}) {
  const host = document.getElementById("appAlerts");
  if (!host || !message) return;

  const sr = document.createElement("div");
  sr.className = "sr-only";
  sr.textContent = message;
  host.appendChild(sr);
  setTimeout(() => sr.remove(), 1200);

  if (toast) {
    showSoftBanner(message);
  }
}

function recordStorageFailure(context, err) {
  storageStats.failures += 1;
  log.warn(`Fallo de almacenamiento (#${storageStats.failures}) en ${context}`, err);
  showSoftBanner("⚠️ Problema guardando datos locales. Revisá tu navegador.");
}

function setSyncBannerVisible(visible) {
  const banner = $("syncBanner");
  if (!banner) return;
  banner.hidden = !visible;
}

function updateAuthStatus(message) {
  const status = $("authStatus");
  if (status && message) status.textContent = message;
}

function updateAuthUserLabel() {
  const label = $("authUserLabel");
  if (!label) return;
  label.textContent = supabaseUser?.email ? `Sesión: ${supabaseUser.email}` : "Sesión no iniciada";
}

// Gate de auth: controla qué se muestra antes/después de iniciar sesión.
function updateAuthUI(session) {
  const loginModal = $("authOverlay");
  const appRoot = $("financePanel");
  const header = document.querySelector("header");
  const footer = document.querySelector("footer");

  if (session) {
    supabaseSession = session;
    supabaseUser = session.user || null;
    if (currentUserId && currentUserId !== supabaseUser?.id) {
      stopRealtimeSubscription();
      appStarted = false;
    }
    currentUserId = supabaseUser?.id || null;

    if (loginModal) {
      loginModal.hidden = true;
      loginModal.style.display = "none";
    }
    if (appRoot) appRoot.style.display = "block";
    if (header) header.style.display = "block";
    if (footer) footer.style.display = "block";
    document.body.classList.remove("auth-locked");

    updateAuthUserLabel();
    updateAuthStatus("Sesión activa.");
    if (!appStarted) {
      initAppAfterLogin();
    }
    return;
  }

  supabaseSession = null;
  supabaseUser = null;
  currentUserId = null;
  appStarted = false;
  stopRealtimeSubscription();

  if (loginModal) {
    loginModal.hidden = false;
    loginModal.style.display = "flex";
  }
  if (appRoot) appRoot.style.display = "none";
  if (header) header.style.display = "none";
  if (footer) footer.style.display = "none";
  document.body.classList.add("auth-locked");

  updateAuthUserLabel();
  updateAuthStatus("Ingresá con tu cuenta para continuar.");
}

// 🔎 DEBUG: mostrar errores en pantalla (iPhone friendly) sin bloquear la UI
window.addEventListener("error", (e) => {
  const msg = "JS ERROR: " + (e.message || e.type) + " " + (e.filename || "") + ":" + (e.lineno || "");
  log.error(msg, e.error || e);
  showSoftBanner(msg);
});
window.addEventListener("unhandledrejection", (e) => {
  const msg = "PROMISE ERROR: " + (e.reason?.message || JSON.stringify(e.reason) || String(e.reason) || "unknown");
  log.error(msg, e.reason || e);
  showSoftBanner(msg);
});

// ===== MODO EDICIÓN (GLOBAL) =====
let editMode = {
  section: null, // "alumnos" | "cxc" | "ingresos" | "gastos" | "cxp"
  id: null
};

// ===== Active data (GLOBAL) =====
const XA_STORE_KEY = "xa_store_v1";
const XA_ACTIVE_KEY = "xa_active_v1";
const LOCAL_STORAGE_BUDGET = 4.5 * 1024 * 1024; // ~4.5MB

function safeSetItem(key, value) {
  const isString = typeof value === "string";
  const payload = isString ? value : JSON.stringify(value || {});
  if (payload.length > LOCAL_STORAGE_BUDGET) {
    recordStorageFailure(`escritura localStorage (${key})`, new Error("Payload demasiado grande para localStorage"));
    return;
  }
  try {
    localStorage.setItem(key, payload);
    return;
  } catch (err) {
    log.warn("Primer intento de guardado falló, reintentando con limpieza", { key, err });
  }

  try {
    localStorage.removeItem(key);
    localStorage.setItem(key, payload);
  } catch (err2) {
    recordStorageFailure(`escritura localStorage (${key})`, err2);
  }
}

function xaLoad() {
  try { return JSON.parse(localStorage.getItem(XA_STORE_KEY)) || {}; }
  catch (err) {
    recordStorageFailure("lectura localStorage", err);
    return {};
  }
}

function xaSave(store) {
  safeSetItem(XA_STORE_KEY, store || {});
}

function getActiveId() {
  return localStorage.getItem(XA_ACTIVE_KEY) || "default";
}

function setActiveId(id) {
  safeSetItem(XA_ACTIVE_KEY, id);
}

function getActive() {
  const store = xaLoad();
  const id = getActiveId();

  store[id] ??= {
    alumnos: [],
    ingresos: [],
    gastos: [],
    pagos: [],
    asistencia: [],
    cxc: [],
    cxp: [],
    inventario: []
  };

  const tplName = getTemplateName(state?.templates?.find((t) => t.id === id)) || store[id].name || id;
  if (tplName) {
    store[id].name = tplName;
  }

  // 🔥 MIGRACIÓN: datos viejos con Cxc → cxc
  if (store[id].Cxc && !store[id].cxc) {
    store[id].cxc = store[id].Cxc;
    delete store[id].Cxc;
  }

  // asegurar arrays
  store[id].cxc ??= [];
  store[id].cxp ??= [];
  store[id].ingresos ??= [];
  store[id].gastos ??= [];
  store[id].pagos ??= [];
  store[id].asistencia ??= [];
  store[id].alumnos ??= [];
  store[id].inventario ??= [];

  ensureAlumnoIds(store[id]);

  xaSave(store);
  return store[id];
}

function setActive(active) {
  const store = xaLoad();
  const id = getActiveId();

  store[id] = active;

  // asegurar arrays por las dudas (mismo criterio que getActive)
  store[id].cxc ??= [];
  store[id].cxp ??= [];
  store[id].ingresos ??= [];
  store[id].gastos ??= [];
  store[id].pagos ??= [];
  store[id].asistencia ??= [];
  store[id].alumnos ??= [];
  store[id].inventario ??= [];

  xaSave(store);
}

function generateAlumnoId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return String(Date.now()) + Math.random().toString(16).slice(2);
}

function ensureAlumnoIds(active) {
  if (!active || !Array.isArray(active.alumnos)) return false;
  let changed = false;
  active.alumnos = active.alumnos.map((alumno) => {
    if (alumno?.id) return alumno;
    changed = true;
    return { ...alumno, id: generateAlumnoId() };
  });
  return changed;
}

function ensurecxc(active){
  if (!Array.isArray(active.cxc)) active.cxc = [];
}

function addCuotaPendiente(active, alumno) {
  if (!active || !alumno) return;

  active.cxc ??= [];
  const templateId = state.activeTemplateId || getActiveId();
  const mes = getActiveTemplateName();
  const cuotaConcepto = String(alumno?.cuotaNombre || alumno?.conceptoCuota || "Cuota").trim() || "Cuota";
  const estado = String(alumno.estado || "Activo").trim().toLowerCase();
  const isPendingStatus = (value) => {
    const status = String(value || "").trim().toLowerCase();
    return status === "pendiente" || status === "vencido";
  };

  if (estado !== "activo") {
    active.cxc = active.cxc.filter(c =>
      String(c.alumnoId || "") !== String(alumno.id) ||
      !isPendingStatus(c.estado)
    );
    return;
  }

  let pendingSeen = false;
  active.cxc = active.cxc.reduce((acc, c) => {
    const isAlumno = String(c.alumnoId || "") === String(alumno.id);
    const isPending = isPendingStatus(c.estado);
    if (!isAlumno || !isPending) {
      acc.push(c);
      return acc;
    }
    if (pendingSeen) return acc;
    pendingSeen = true;
    acc.push({
      ...c,
      nombre: alumno.nombre || "",
      alumnoNombre: alumno.nombre || "",
      monto: Number(alumno.cuota || 0),
      alumnoId: alumno.id,
      templateId,
      mes,
      tipo: "Cuota",
      categoria: "Cuota",
      concepto: c.concepto || cuotaConcepto
    });
    return acc;
  }, []);

  if (pendingSeen) return;

  // evitar duplicar cuotas pendientes para el mismo alumno
  const existe = active.cxc.some(c =>
    String(c.alumnoId || "") === String(alumno.id) &&
    String(c.estado || "").toLowerCase() !== "pagado"
  );

  if (existe) return;

  active.cxc.push({
    id: "cxc_" + uid(),
    vence: venceDia10ISO(),
    nombre: alumno.nombre || "",
    alumnoNombre: alumno.nombre || "",
    concepto: cuotaConcepto,
    monto: Number(alumno.cuota || 0),
    estado: "Pendiente",
    notas: "",
    alumnoId: alumno.id,
    templateId,
    mes,
    tipo: "Cuota",
    categoria: "Cuota"
  });
}


/* ---------- IndexedDB minimal wrapper ---------- */
const DB_NAME = "xtremeCuentasDB";
const DB_VER = 2;

function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = () => {
      const db = req.result;

      // Crear store si no existe
      let templates;
      if (!db.objectStoreNames.contains("templates")) {
        templates = db.createObjectStore("templates", { keyPath: "id" });
      } else {
        templates = req.transaction.objectStore("templates");
      }

      // ✅ Asegurar que byName NO sea único (porque podés tener nombres repetidos)
      if (templates.indexNames.contains("byName")) {
        templates.deleteIndex("byName");
      }
      templates.createIndex("byName", "name", { unique: false });
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      recordStorageFailure("apertura IndexedDB", req.error);
      reject(req.error);
    };
  });
}

async function dbGetAll(store){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,"readonly");
    const st=tx.objectStore(store);
    const req=st.getAll();
    req.onsuccess=()=>resolve(req.result||[]);
    req.onerror=()=>reject(req.error);
  });
}
async function dbPut(store, value){
  const db = await openDB();

  if (value && (value.id === undefined || value.id === null || value.id === "")) {
    value.id = uid();
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    const req = os.put(value);

    req.onerror = () => reject(req.error || tx.error || new Error("dbPut request failed"));
    tx.onerror  = () => reject(tx.error || new Error("dbPut tx failed"));
    tx.onabort  = () => reject(tx.error || new Error("dbPut aborted"));
    tx.oncomplete = () => resolve(true);
  });
}


async function dbDelete(store, key){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,"readwrite");
    tx.oncomplete=()=>resolve(true);
    tx.onerror=()=>reject(tx.error);
    tx.objectStore(store).delete(key);
  });
}

/* ---------- State ---------- */
let state = {
  templates: [],
  activeTemplateId: null,
  active: null, // current template object
  filters: { month: monthISO(), search: "", alumnosStatus: "activos", cxcStatus: "pendientes", cxpStatus: "pendientes" },
  selectedAlumno: null
};

function getTemplateName(tpl) {
  return String(tpl?.name || tpl?.nombre || "").trim();
}

function sortTemplates(list) {
  return (list || []).sort((a, b) => getTemplateName(a).localeCompare(getTemplateName(b)));
}

function getActiveTemplateName() {
  const tpl = state.templates?.find((t) => t.id === state.activeTemplateId) || state.active;
  return getTemplateName(tpl) || tpl?.name || state.activeTemplateId || "";
}

function emptyTemplate(name){
  return {
    id: uid(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ingresos: [],
    gastos: [],
    cxc: [],
    cxp: [],
    inventario: [],
    alumnos: []
  };
}

function cloneTemplate(fromTpl, name){
  const t = emptyTemplate(name);
  // Carry over inventario + cuentas by default; ingresos/gastos are per month
  t.inventario = (fromTpl.inventario||[]).map(x=>({...x, id: uid()}));
  t.alumnos = (fromTpl.alumnos||[]).map(a => ({ ...a, id: uid() }));
  t.cxc = (fromTpl.cxc||[]).map(x=>({...x, id: uid()}));
  t.cxp = (fromTpl.cxp||[]).map(x=>({...x, id: uid()}));
  return t;
}

/* ---------- Supabase Sync ---------- */
async function loadTemplateFromCloud(name) {
  if (!supabaseClient || !supabaseUser || !name) return null;

  const { data, error } = await supabaseClient
    .from("templates")
    .select("data")
    .eq("owner_id", supabaseUser.id)
    .eq("name", name)
    .maybeSingle();

  if (error) {
    log.warn("Error cargando template desde Supabase", error);
    setSyncBannerVisible(true);
    return null;
  }

  setSyncBannerVisible(false);
  return data?.data || null;
}

async function saveTemplateToCloud(name, data) {
  if (!supabaseClient || !supabaseUser || !name || !data) return false;

  const payload = {
    owner_id: supabaseUser.id,
    name,
    data,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabaseClient
    .from("templates")
    .upsert(payload, { onConflict: "owner_id,name" });

  if (error) {
    log.warn("Error guardando template en Supabase", error);
    setSyncBannerVisible(true);
    return false;
  }

  setSyncBannerVisible(false);
  return true;
}

async function deleteTemplateFromCloud(name) {
  if (!supabaseClient || !supabaseUser || !name) return false;

  const { error } = await supabaseClient
    .from("templates")
    .delete()
    .eq("owner_id", supabaseUser.id)
    .eq("name", name);

  if (error) {
    log.warn("Error borrando template en Supabase", error);
    setSyncBannerVisible(true);
    return false;
  }

  setSyncBannerVisible(false);
  return true;
}
async function applyRemoteTemplateData(remoteData) {
  if (!remoteData) return;
  isApplyingRemoteUpdate = true;
  try {
    const activeId = state.activeTemplateId || getActiveId();
    const activeName = getActiveTemplateName();
    const normalized = {
      ...remoteData,
      id: activeId,
      name: activeName || remoteData?.name || remoteData?.nombre || activeId
    };

    state.active = normalized;
    saveActiveData(normalized);
    await dbPut("templates", normalized);
    state.templates = sortTemplates(await dbGetAll("templates"));
    refreshTemplateSelectors();
    renderAll();
  } finally {
    isApplyingRemoteUpdate = false;
  }
}

async function syncActiveTemplateWithCloud() {
  if (!supabaseClient || !supabaseUser) return;
  const activeName = getActiveTemplateName();
  if (!activeName) return;

  try {
    const remoteData = await loadTemplateFromCloud(activeName);
    if (remoteData) {
      await applyRemoteTemplateData(remoteData);
    } else if (state.active) {
      await saveTemplateToCloud(activeName, state.active);
    }
  } catch (err) {
    log.warn("Error sincronizando plantilla activa", err);
    setSyncBannerVisible(true);
  }
}

function getTemplateUpdatedAt(tpl) {
  const raw = tpl?.updatedAt || tpl?.updated_at || tpl?.updatedAtISO || tpl?.updated;
  const parsed = typeof raw === "string" ? Date.parse(raw) : Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function chooseLatestTemplate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return getTemplateUpdatedAt(b) >= getTemplateUpdatedAt(a) ? b : a;
}

async function fetchTemplates({ reason = "manual" } = {}) {
  if (!supabaseClient || !supabaseUser) return [];

  log.info("🔄 Refrescando plantillas desde Supabase", { reason });
  const { data, error } = await supabaseClient
    .from("templates")
    .select("id,name,data,updated_at")
    .eq("owner_id", supabaseUser.id);

  if (error) {
    log.warn("Error cargando plantillas desde Supabase", error);
    setSyncBannerVisible(true);
    return [];
  }

  setSyncBannerVisible(false);

  const rawTemplates = (data || []).map((row) => {
    const payload = row?.data || {};
    const id = payload.id || row.id || uid();
    const name = getTemplateName(payload) || row.name || payload.name || payload.nombre || id;
    return {
      ...payload,
      id,
      name,
      updatedAt: payload.updatedAt || payload.updated_at || row.updated_at || payload.updatedAt
    };
  });

  const byId = new Map();
  rawTemplates.forEach((tpl) => {
    const existing = byId.get(tpl.id);
    byId.set(tpl.id, chooseLatestTemplate(existing, tpl));
  });

  const byName = new Map();
  Array.from(byId.values()).forEach((tpl) => {
    const nameKey = getTemplateName(tpl).toLowerCase();
    if (!nameKey) {
      byName.set(`__${tpl.id}`, tpl);
      return;
    }
    const existing = byName.get(nameKey);
    byName.set(nameKey, chooseLatestTemplate(existing, tpl));
  });

  let normalized = sortTemplates(Array.from(byName.values()));

  if (!normalized.length) {
    const name = monthISO();
    const fallback = emptyTemplate(name);
    await saveTemplateToCloud(name, fallback);
    await dbPut("templates", fallback);
    normalized = [fallback];
  }

  const localTemplates = await dbGetAll("templates");
  const remoteIds = new Set(normalized.map((tpl) => tpl.id));
  for (const tpl of localTemplates) {
    if (!remoteIds.has(tpl.id)) {
      await dbDelete("templates", tpl.id);
    }
  }

  for (const tpl of normalized) {
    await dbPut("templates", tpl);
  }

  state.templates = normalized;

  const activeId = state.activeTemplateId || getActiveId();
  if (!state.templates.some((tpl) => tpl.id === activeId)) {
    const next = state.templates[state.templates.length - 1];
    if (next) {
      state.activeTemplateId = next.id;
      setActiveId(next.id);
      safeSetItem("xt_active_template", next.id);
      state.active = getActive();
    }
  }

  refreshTemplateSelectors();
  renderAll();
  return normalized;
}

function shouldApplyRealtimePayload(payload) {
  const activeName = getActiveTemplateName();
  const payloadName = payload?.new?.name || payload?.old?.name || payload?.new?.data?.name || "";
  const payloadId = payload?.new?.data?.id || payload?.old?.data?.id || payload?.new?.id || payload?.old?.id;
  const activeId = state.activeTemplateId || getActiveId();

  if (payloadId && String(payloadId) === String(activeId)) return true;
  if (payloadName && activeName && payloadName === activeName) return true;
  return false;
}

async function initAppAfterLogin() {
  if (!supabaseClient || !supabaseUser || appStarted) return;
  appStarted = true;
  await fetchTemplates({ reason: "login" });
  await syncActiveTemplateWithCloud();
  await startRealtimeSubscription();
}

function scheduleCloudSave(active) {
  if (!supabaseClient || !supabaseUser || isApplyingRemoteUpdate) return;
  const name = getActiveTemplateName();
  if (!name) return;

  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => {
    saveTemplateToCloud(name, active || state.active).catch((err) => {
      log.warn("Error guardando template (debounce)", err);
      setSyncBannerVisible(true);
    });
  }, CLOUD_SAVE_DEBOUNCE_MS);
}

async function startRealtimeSubscription() {
  if (!supabaseClient || !supabaseUser) return;
  stopRealtimeSubscription();

  realtimeChannel = supabaseClient
    .channel(`templates-${supabaseUser.id}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "templates", filter: `owner_id=eq.${supabaseUser.id}` },
      async (payload) => {
        log.info("📡 Realtime templates event recibido", {
          event: payload?.eventType,
          schema: payload?.schema,
          table: payload?.table
        });
        console.log("[Realtime][templates]", payload);

        await fetchTemplates({ reason: `realtime:${payload?.eventType || "unknown"}` });

        if (!payload?.new?.data || isApplyingRemoteUpdate) return;
        if (!shouldApplyRealtimePayload(payload)) return;
        await applyRemoteTemplateData(payload.new.data);
      }
    );

  realtimeChannel.subscribe((status) => {
    if (status === "CHANNEL_ERROR") {
      log.warn("Error suscribiendo realtime");
    }
  });
}

function stopRealtimeSubscription() {
  if (realtimeChannel) {
    realtimeChannel.unsubscribe();
    realtimeChannel = null;
  }
}

function setupTemplateRefreshFallback() {
  if (visibilityHandlersBound) return;
  visibilityHandlersBound = true;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      fetchTemplates({ reason: "visibilitychange" });
    }
  });

  window.addEventListener("focus", () => {
    fetchTemplates({ reason: "focus" });
  });

  window.addEventListener("pagehide", () => {
    stopRealtimeSubscription();
  });
}

async function setupAuthUI() {
  if (!supabaseClient) {
    log.warn("Supabase no configurado: revisá APP_CONFIG.");
    updateAuthStatus("Falta configurar Supabase. Revisá config.js.");
    updateAuthUI(null);
    updateAuthUserLabel();
    return;
  }

  updateAuthStatus("Verificando sesión...");

  const emailInput = $("authEmail");
  const passwordInput = $("authPassword");
  const signInBtn = $("authSignInBtn");
  const signOutButtons = [$("authSignOutBtn"), $("authSignOutHeaderBtn")].filter(Boolean);

  const setBusy = (busy) => {
    [signInBtn, ...signOutButtons].forEach((btn) => {
      if (btn) btn.disabled = busy;
    });
  };

  async function handleSession(session) {
    updateAuthUI(session);
    signOutButtons.forEach((btn) => {
      if (btn) btn.disabled = !session;
    });
  }

  signInBtn?.addEventListener("click", async () => {
    const email = emailInput?.value?.trim();
    const password = passwordInput?.value || "";
    if (!email || !password) {
      updateAuthStatus("Ingresá email y contraseña.");
      return;
    }
    setBusy(true);
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      updateAuthStatus(`No se pudo iniciar sesión: ${error.message}`);
      return;
    }
    updateAuthUI(data?.session || null);
  });

  signOutButtons.forEach((btn) => {
    btn?.addEventListener("click", async () => {
      setBusy(true);
      const { error } = await supabaseClient.auth.signOut();
      setBusy(false);
      if (error) {
        updateAuthStatus(`No se pudo cerrar sesión: ${error.message}`);
      } else {
        updateAuthStatus("Sesión cerrada.");
      }
    });
  });

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    handleSession(session);
  });

  const { data } = await supabaseClient.auth.getSession();
  handleSession(data?.session || null);
}

/* ---------- Bootstrap ---------- */
async function init(){
  // Default dates
  ["inFecha","gaFecha","cxcvence","cxpvence"].forEach(id=>{
    if($(id)) $(id).value = todayISO();
  });
  $("monthFilter").value = state.filters.month;

  // Load templates
  const templates = await dbGetAll("templates");
  state.templates = sortTemplates(templates);

  // Create first template if none
  if (state.templates.length === 0) {
    const name = monthISO();
    const t = emptyTemplate(name);
    t.name = name;
    await dbPut("templates", t);
    state.templates = [t];
  }

  // Determine active template
  const savedActive = localStorage.getItem("xt_active_template");
  const tpl =
    state.templates.find(x => x.id === savedActive) ||
    state.templates[state.templates.length - 1];

  safeSetItem("xt_active_template", tpl.id);
  state.activeTemplateId = tpl.id;
  setActiveId(tpl.id);

  // Load active data
  state.active = getActive();

  // asegurar arrays
  state.active.cxc ??= [];
  state.active.ingresos ??= [];
  state.active.gastos ??= [];
  state.active.pagos ??= [];
  state.active.asistencia ??= [];
  state.active.alumnos ??= [];

  // UI wiring
  wireTabs();
  wireActions();
  setupInlineEditHotkeys();
  initStudentModal();
  initStudentPaymentsModal();
  initAddAlumnoModal();
  initAddIngresoModal();
  initAddGastoModal();
  initAddInventarioModal();
  initAddCxcModal();
  initAddCxpModal();
  updateTabHero(document.querySelector(".nav button.active")?.dataset.tab || "dashboard");

  // Render
  refreshTemplateSelectors();
  renderAll();
  setupTemplateRefreshFallback();
  await setupAuthUI();
}


function saveActive(){
  safeSetItem("xt_active_template", state.activeTemplateId);
}

function saveActiveData(active) {
  const store = xaLoad();
  const id = getActiveId();

  // ✅ aseguramos que cxc se guarde siempre
  active.cxc = active.cxc || [];

  store[id] = active;
  xaSave(store);
  scheduleCloudSave(active);
}


function setActiveTemplate(id){
  const t = state.templates.find(x=>x.id===id);
  if(!t) return;

  state.activeTemplateId = id;

  // ✅ cambia el "store" activo a esta plantilla
  setActiveId(id);

  // ✅ carga datos de esa plantilla
  state.active = getActive();

  saveActive(); // esto guarda xt_active_template (selector)
  renderAll();
  if (supabaseSession) {
    syncActiveTemplateWithCloud();
  }
}

/* ---------- Tabs ---------- */
function updateTabHero(tab){
  const hero = $("tabHero");
  if (!hero) return;

  const visual = TAB_VISUALS[tab] || TAB_VISUALS.dashboard;
  hero.style.setProperty("--hero-image", `url("${visual.src}")`);
}

function wireTabs(){
  const tabButtons = Array.from(document.querySelectorAll('.nav button[data-tab]'));
  if (!tabButtons.length) return;

  const panels = Array.from(document.querySelectorAll(".tab"));

  tabButtons.forEach((btn) => {
    const tab = btn.dataset.tab;
    const panelId = `tab-${tab}`;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-controls", panelId);
    btn.id ||= `tab-btn-${tab}`;
    const panel = document.getElementById(panelId);
    if (panel) {
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", btn.id);
    }
  });

  function activateTab(btn, { announce = true } = {}) {
    const tab = btn?.dataset.tab;
    if (!tab) return;

    tabButtons.forEach((b) => {
      const isActive = b === btn;
      b.classList.toggle("active", isActive);
      b.setAttribute("aria-selected", isActive ? "true" : "false");
      b.tabIndex = isActive ? 0 : -1;
    });

    panels.forEach((panel) => {
      const matches = panel.id === `tab-${tab}`;
      panel.hidden = !matches;
      panel.setAttribute("aria-hidden", matches ? "false" : "true");
    });

    updateTabHero(tab);
    if (announce) {
      const label = (btn.textContent || tab || "").trim();
      announceLive(`Pestaña “${label}” abierta.`);
    }
  }

  function focusTabAt(index) {
    const nextBtn = tabButtons[index];
    if (!nextBtn) return;
    activateTab(nextBtn);
    nextBtn.focus();
  }

  function moveFocus(fromIndex, delta) {
    const total = tabButtons.length;
    const nextIndex = (fromIndex + delta + total) % total;
    focusTabAt(nextIndex);
  }

  const initialActive = tabButtons.find((b) => b.classList.contains("active")) || tabButtons[0];
  activateTab(initialActive, { announce: false });

  tabButtons.forEach((btn, index) => {
    btn.addEventListener("click", () => activateTab(btn));
    btn.addEventListener("keydown", (event) => {
      if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) {
        event.preventDefault();
      } else {
        return;
      }

      if (event.key === "ArrowRight") moveFocus(index, 1);
      if (event.key === "ArrowLeft") moveFocus(index, -1);
      if (event.key === "Home") focusTabAt(0);
      if (event.key === "End") focusTabAt(tabButtons.length - 1);
    });
  });
}

/* ---------- Helpers ---------- */
function venceDia10ISO() {
  const tpl = state.templates?.find(t => t.id === state.activeTemplateId);
  const name = (tpl?.name || "").trim();

  const m = name.match(/(\d{4})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-10`;

  const today = todayISO();
  return `${today.slice(0, 7)}-10`;
}

function persistActive(activeParam){
  const active = activeParam || state.active || getActive();

  // ✅ clave: persistir SIEMPRE con el id de la plantilla activa
  const id = getActiveId();
  active.id = id;

  // nombre por si falta
  active.name ||= monthISO();

  active.updatedAt = Date.now();
  state.active = active;

  // ✅ guardar también en localStorage para que el store activo quede en sync
  saveActiveData(active);

  return dbPut("templates", active).then(async () => {
    state.templates = sortTemplates(await dbGetAll("templates"));

    refreshTemplateSelectors();
  });
}


function inMonth(dateISO, monthYYYYMM){
  if(!dateISO) return false;
  return String(dateISO).slice(0,7)===monthYYYYMM;
}

function textMatch(obj, q){
  if(!q) return true;
  const s = JSON.stringify(obj).toLowerCase();
  return s.includes(q.toLowerCase());
}

function collectGlobalSearchHits(query){
  const term = (query || "").trim();
  if (!term) return [];

  const templates = state.templates?.length ? state.templates : [];
  const tplList = templates.length ? templates : [];
  const ensureArray = (arr) => Array.isArray(arr) ? arr : [];

  const sections = [
    {
      key: "ingresos",
      label: "Ingreso",
      dateKey: "fecha",
      amountKey: "monto",
      title: (r) => r.nombre || r.concepto || "Ingreso",
      subtitle: (r) => r.concepto || r.medio || ""
    },
    {
      key: "gastos",
      label: "Egreso",
      dateKey: "fecha",
      amountKey: "monto",
      title: (r) => r.concepto || "Egreso",
      subtitle: (r) => r.categoria || ""
    },
    {
      key: "cxc",
      label: "Por cobrar",
      dateKey: "vence",
      amountKey: "monto",
      title: (r) => r.nombre || r.concepto || "Por cobrar",
      subtitle: (r) => r.concepto || ""
    },
    {
      key: "cxp",
      label: "Por pagar",
      dateKey: "vence",
      amountKey: "monto",
      title: (r) => r.proveedor || r.concepto || "Por pagar",
      subtitle: (r) => r.concepto || ""
    },
    {
      key: "inventario",
      label: "Inventario",
      dateKey: "",
      amountKey: null,
      title: (r) => r.producto || r.categoria || "Inventario",
      subtitle: (r) => {
        const stock = r.stock ?? "";
        const min = r.minimo ?? "";
        if (stock === "" && min === "") return "";
        return `Stock: ${stock}${min !== "" ? ` (mín ${min})` : ""}`;
      }
    },
    {
      key: "alumnos",
      label: "Alumno",
      dateKey: "",
      amountKey: null,
      title: (r) => r.nombre || "Alumno",
      subtitle: (r) => r.programa || (r.cuota ? `Cuota: ${money(Number(r.cuota) || 0)}` : "")
    }
  ];

  const hits = [];

  for (const tpl of tplList) {
    const tplData = store?.[tpl.id] || tpl || {};
    const tplName = getTemplateName(tpl) || tplData.name || tpl.id || "Plantilla";

    for (const section of sections) {
      const rows = ensureArray(tplData[section.key]);
      for (const row of rows) {
        const searchable = { ...row, plantilla: tplName };
        if (!textMatch(searchable, term)) continue;

        const amount = section.amountKey !== null && section.amountKey !== undefined
          ? Number(row?.[section.amountKey])
          : null;

        hits.push({
          tplId: tpl.id,
          tplName,
          section: section.label,
          date: section.dateKey ? (row?.[section.dateKey] || "") : "",
          title: section.title(row),
          subtitle: section.subtitle ? section.subtitle(row) : "",
          amount: Number.isFinite(amount) ? amount : null,
          estado: row?.estado || ""
        });
      }
    }
  }

  return hits;
}

function noteHtml(txt){
  const note = (txt || "").trim();
  if (!note) return `<span class="note-empty">—</span>`;
  return `<div class="note-text">${escAttr(note)}</div>`;
}

function requireDateValue(value, contextLabel){
  const v = (value || "").trim();
  if (!v) {
    alert(`Ingresá la fecha de ${contextLabel}; no puede quedar vacía.`);
    return null;
  }
  return v;
}

function requireMontoValue(value, contextLabel){
  const res = validatePositiveAmount(value, contextLabel);
  if (res.error) {
    alert(res.error);
    return null;
  }
  return res.amount;
}

/* ---------- Inline form validation helpers ---------- */
const FINANCE_FIELD_RULES = {
  ingresos: {
    submitId: "addIngresoBtn",
    fields: [
      { id: "inConcepto", key: "concepto", kind: "text", label: "el ingreso" },
      { id: "inFecha", key: "fecha", kind: "date", label: "este ingreso" },
      { id: "inMonto", key: "monto", kind: "amount", label: "este ingreso" }
    ]
  },
  gastos: {
    submitId: "addGastoBtn",
    fields: [
      { id: "gaConcepto", key: "concepto", kind: "text", label: "qué pagaste" },
      { id: "gaFecha", key: "fecha", kind: "date", label: "este egreso" },
      { id: "gaMonto", key: "monto", kind: "amount", label: "este egreso" }
    ]
  },
  cxc: {
    submitId: "addCxcBtn",
    fields: [
      { id: "cxcnombre", key: "nombre", kind: "text", label: "el alumno o cliente" },
      { id: "cxcvence", key: "vence", kind: "date", label: "esta cuenta por cobrar" },
      { id: "cxcconcepto", key: "concepto", kind: "text", label: "el concepto" },
      { id: "cxcmonto", key: "monto", kind: "amount", label: "esta cuenta por cobrar" }
    ]
  },
  cxp: {
    submitId: "addCxpBtn",
    fields: [
      { id: "cxpproveedor", key: "proveedor", kind: "text", label: "el proveedor o servicio" },
      { id: "cxpvence", key: "vence", kind: "date", label: "esta cuenta por pagar" },
      { id: "cxpconcepto", key: "concepto", kind: "text", label: "el concepto" },
      { id: "cxpmonto", key: "monto", kind: "amount", label: "esta cuenta por pagar" }
    ]
  }
};

function ensureFieldMessage(input) {
  if (!input) return null;
  const parent = input.parentElement || input.closest("div") || input;
  let msg = parent.querySelector(`[data-field-msg-for="${input.id}"]`);
  if (msg) return msg;

  msg = document.createElement("p");
  msg.className = "field-message";
  msg.dataset.fieldMsgFor = input.id;
  msg.setAttribute("aria-live", "polite");
  msg.setAttribute("role", "status");
  msg.hidden = true;

  input.insertAdjacentElement("afterend", msg);
  return msg;
}

function renderFieldFeedback(input, result, options = {}) {
  const msg = ensureFieldMessage(input);
  if (!msg) return;

  const showHint = options.showHint && !result.error && result.normalized;
  msg.textContent = result.error || (showHint ? `Se guardará como ${result.normalized}` : "");
  msg.hidden = !(result.error || showHint);

  msg.classList.toggle("field-message--error", Boolean(result.error));
  msg.classList.toggle("field-message--hint", Boolean(showHint));
  input?.classList?.toggle("input-error", Boolean(result.error));
}

function runFinanceValidation(section) {
  const config = FINANCE_FIELD_RULES[section];
  if (!config) return { hasError: false, values: {} };

  const values = {};
  let hasError = false;

  for (const field of config.fields) {
    const input = $(field.id);
    const raw = input?.value ?? "";
    let res;
    if (field.kind === "amount") res = validatePositiveAmount(raw, field.label);
    else if (field.kind === "date") res = validateDateInput(raw, field.label);
    else res = validateRequiredText(raw, field.label);

    renderFieldFeedback(input, res, { showHint: field.kind === "amount" });

    if (res.error) hasError = true;
    values[field.key] = field.kind === "amount" ? res.amount : res.value;
  }

  const submit = $(config.submitId);
  if (submit) submit.disabled = hasError;

  return { hasError, values };
}

function setupFinanceValidationListeners() {
  Object.keys(FINANCE_FIELD_RULES).forEach((section) => {
    const config = FINANCE_FIELD_RULES[section];
    config.fields.forEach((field) => {
      const input = $(field.id);
      if (!input) return;
      const handler = () => runFinanceValidation(section);
      input.addEventListener("input", handler);
      input.addEventListener("change", handler);
      input.addEventListener("blur", handler);
    });
    runFinanceValidation(section);
  });
}

/* ---------- Rendering ---------- */
function render(){
  renderAll();
}

function updateAlumnoFilterButtons() {
  const activosBtn = $("alFilterActivos");
  const inactivosBtn = $("alFilterInactivos");
  if (!activosBtn || !inactivosBtn) return;

  const status = state.filters.alumnosStatus || "activos";
  const isActivos = status === "activos";

  activosBtn.classList.toggle("active", isActivos);
  activosBtn.setAttribute("aria-pressed", isActivos ? "true" : "false");
  inactivosBtn.classList.toggle("active", !isActivos);
  inactivosBtn.setAttribute("aria-pressed", !isActivos ? "true" : "false");
}

function setAlumnoStatusFilter(status) {
  state.filters.alumnosStatus = status;
  updateAlumnoFilterButtons();
  renderAlumnos();
}

function updateCxcFilterButtons() {
  const pendientesBtn = $("cxcFilterPendientes");
  const pagosBtn = $("cxcFilterPagos");
  if (!pendientesBtn || !pagosBtn) return;

  const status = state.filters.cxcStatus || "pendientes";
  const isPendientes = status === "pendientes";

  pendientesBtn.classList.toggle("active", isPendientes);
  pendientesBtn.setAttribute("aria-pressed", isPendientes ? "true" : "false");
  pagosBtn.classList.toggle("active", !isPendientes);
  pagosBtn.setAttribute("aria-pressed", !isPendientes ? "true" : "false");
}

function setCxcStatusFilter(status) {
  state.filters.cxcStatus = status;
  updateCxcFilterButtons();
  rendercxc();
}

function updateCxpFilterButtons() {
  const pendientesBtn = $("cxpFilterPendientes");
  const pagosBtn = $("cxpFilterPagos");
  if (!pendientesBtn || !pagosBtn) return;

  const status = state.filters.cxpStatus || "pendientes";
  const isPendientes = status === "pendientes";

  pendientesBtn.classList.toggle("active", isPendientes);
  pendientesBtn.setAttribute("aria-pressed", isPendientes ? "true" : "false");
  pagosBtn.classList.toggle("active", !isPendientes);
  pagosBtn.setAttribute("aria-pressed", !isPendientes ? "true" : "false");
}

function setCxpStatusFilter(status) {
  state.filters.cxpStatus = status;
  updateCxpFilterButtons();
  renderCxp();
}


function renderAll(){
  state.active = getActive();

  state.active.cxc ??= [];
  state.active.cxp ??= [];
  state.active.ingresos ??= [];
  state.active.gastos ??= [];
  state.active.pagos ??= [];
  state.active.asistencia ??= [];
  state.active.alumnos ??= [];
  state.active.inventario ??= [];
  $("activeTemplateLabel").textContent = "Plantilla: " + state.active.name;
  $("monthFilter").value = state.filters.month;

  renderDashboard();
  renderIngresos();
  renderGastos();
  rendercxc();
  renderCxp();
  renderInventario();
  renderAlumnos();
}

function renderDashboard(){
  const m = state.filters.month;
  const q = state.filters.search;

  const ing = (state.active.ingresos||[]).filter(x=>inMonth(x.fecha,m) && textMatch(x,q));
  const gas = (state.active.gastos||[]).filter(x=>inMonth(x.fecha,m) && textMatch(x,q));

  const sumIng = ing.reduce((a,b)=>a+Number(b.monto||0),0);
  const sumGas = gas.reduce((a,b)=>a+Number(b.monto||0),0);
  const bal = sumIng - sumGas;

  $("kpiIngresos").textContent = money(sumIng);
  $("kpiGastos").textContent = money(sumGas);
  $("kpiBalance").textContent = money(bal);
  $("kpiHint").textContent = bal>=0 ? "Vas arriba 💪" : "Ojo: estás en negativo";

  // Set badge hints for overdue payables/receivables (not shown in KPI)

  renderSearchResultsAcrossTemplates(q);
}

function renderSearchResultsAcrossTemplates(query){
  const wrap = $("searchResults");
  const list = $("searchResultsList");
  const count = $("searchResultsCount");
  if (!wrap || !list || !count) return;

  const term = (query || "").trim();
  if (!term) {
    count.textContent = "Buscá por nombre, concepto o proveedor.";
    list.innerHTML = `<div class="empty">Escribí algo en “Búsqueda rápida” para ver coincidencias.</div>`;
    return;
  }

  const hits = collectGlobalSearchHits(term);
  const maxToShow = 80;
  const plural = hits.length === 1 ? "" : "s";
  count.textContent = hits.length
    ? `${hits.length} coincidencia${plural} en tus plantillas`
    : "Sin coincidencias en tus plantillas.";

  list.innerHTML = "";

  if (!hits.length) {
    list.innerHTML = `<div class="empty">Probá con otro término o revisá si está en otro mes.</div>`;
    return;
  }

  hits.slice(0, maxToShow).forEach((hit) => {
    const metaParts = [];
    if (hit.date) metaParts.push(hit.date);
    if (hit.estado) metaParts.push(hit.estado);

    const row = document.createElement("div");
    row.className = "search-hit";
    row.innerHTML = `
      <div class="search-hit__main">
        <div class="search-hit__label">${escAttr(hit.section)} · ${escAttr(hit.tplName)}</div>
        <div class="search-hit__title">${escAttr(hit.title)}</div>
        ${hit.subtitle ? `<div class="search-hit__subtitle">${escAttr(hit.subtitle)}</div>` : ""}
        ${metaParts.length ? `<div class="search-hit__meta">${escAttr(metaParts.join(" • "))}</div>` : ""}
      </div>
      ${hit.amount !== null ? `<div class="search-hit__amount">${money(hit.amount)}</div>` : ""}
    `;
    list.appendChild(row);
  });

  if (hits.length > maxToShow) {
    const more = document.createElement("div");
    more.className = "small";
    more.textContent = `Mostrando ${maxToShow} de ${hits.length} coincidencias. Refiná la búsqueda para acotar el resultado.`;
    list.appendChild(more);
  }
}

function renderIngresos(){
  const q = $("ingSearch").value || "";
  const rows = (state.active.ingresos || [])
    .filter(x => textMatch(x, q))
    .sort((a,b) => (b.fecha || "").localeCompare(a.fecha || ""));

  $("ingCount").textContent = String(rows.length);

  const tbody = $("ingTbody");
  tbody.innerHTML = "";

  for (const r of rows){
    const editing = (editMode.section === "ingresos" && editMode.id === r.id);
    const tr = document.createElement("tr");

    if (editing) tr.classList.add("editing-row");

    if (!editing) {
      tr.innerHTML = `
        <th scope="row">${escAttr(r.fecha||"")}</th>
        <td>${escAttr(r.concepto||"")}</td>
        <td>${money(r.monto||0)}</td>
        <td>${escAttr(r.medio||"")}</td>
        <td class="note-cell">${noteHtml(r.notas)}</td>
        <td class="actions-cell">
          <button class="ghost" data-act="edit" data-id="${r.id}" aria-label="Editar ingreso ${escAttr(r.concepto||"")}">Editar</button>
          <button class="ghost danger" data-act="del" data-id="${r.id}" aria-label="Borrar ingreso ${escAttr(r.concepto||"")}">Borrar</button>
        </td>
      `;
    } else {
      tr.innerHTML = `
        <td><input id="ed_ing_fecha_${r.id}" type="date" value="${escAttr(r.fecha||"")}" /></td>
        <td><input id="ed_ing_concepto_${r.id}" value="${escAttr(r.concepto||"")}" /></td>
        <td><input id="ed_ing_monto_${r.id}" type="number" min="0" step="1" value="${escAttr(r.monto ?? 0)}" /></td>
        <td><input id="ed_ing_medio_${r.id}" value="${escAttr(r.medio||"")}" /></td>
        <td><textarea id="ed_ing_notas_${r.id}">${escAttr(r.notas||"")}</textarea></td>
        <td class="actions-cell">
          <button class="ghost" data-act="save" data-id="${r.id}">Guardar</button>
          <button class="ghost" data-act="cancel">Cancelar</button>
        </td>
      `;
    }

    tbody.appendChild(tr);
  }

  // Delegación (como CxC)
  tbody.onclick = (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;

    const act = btn.dataset.act;
    const id = btn.dataset.id;

    if (act === "del") delRow("ingresos", id);
    else if (act === "edit") editIngreso(id);
    else if (act === "save") saveIngreso(id);
    else if (act === "cancel") cancelEdit();
  };
}

function renderGastos(){
  const q = $("gasSearch").value || "";
  const rows = (state.active.gastos || [])
    .filter(x => textMatch(x, q))
    .sort((a,b)=> String(b.fecha||"").localeCompare(String(a.fecha||"")));

  $("gasCount").textContent = String(rows.length);

  const tbody = $("gasTbody");
  tbody.innerHTML = "";

  for(const r of rows){
    const editing = (editMode.section === "gastos" && editMode.id === r.id);
    const tr = document.createElement("tr");

    if (editing) tr.classList.add("editing-row");

    if (!editing) {
      tr.innerHTML = `
        <th scope="row">${escAttr(r.fecha||"")}</th>
        <td>${escAttr(r.concepto||"")}</td>
        <td>${escAttr(r.categoria||"")}</td>
        <td>${money(r.monto||0)}</td>
        <td class="note-cell">${noteHtml(r.notas)}</td>
        <td class="actions-cell">
          <button class="ghost" data-act="edit" data-id="${r.id}" aria-label="Editar egreso ${escAttr(r.concepto||"")} del ${escAttr(r.fecha||"")}">Editar</button>
          <button class="ghost danger" data-act="del" data-id="${r.id}" aria-label="Borrar egreso ${escAttr(r.concepto||"")} del ${escAttr(r.fecha||"")}">Borrar</button>
        </td>`;
    } else {
      tr.innerHTML = `
        <td><input id="ed_gas_fecha_${r.id}" type="date" value="${escAttr(r.fecha||"")}" /></td>
        <td><input id="ed_gas_concepto_${r.id}" value="${escAttr(r.concepto||"")}" /></td>
        <td><input id="ed_gas_categoria_${r.id}" value="${escAttr(r.categoria||"")}" /></td>
        <td><input id="ed_gas_monto_${r.id}" type="number" min="0" step="1" value="${escAttr(r.monto ?? 0)}" /></td>
        <td><textarea id="ed_gas_notas_${r.id}">${escAttr(r.notas||"")}</textarea></td>
        <td class="actions-cell">
          <button class="ghost" data-act="save" data-id="${r.id}">Guardar</button>
          <button class="ghost" data-act="cancel">Cancelar</button>
        </td>`;
    }
    tbody.appendChild(tr);
  }

  tbody.onclick = (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;

    const act = btn.dataset.act;
    const id = btn.dataset.id;

    if (act === "del") delRow("gastos", id);
    else if (act === "edit") editGasto(id);
    else if (act === "save") saveGasto(id);
    else if (act === "cancel") cancelEdit();
  };
}


function Paid(id){
  const store = xaLoad();
  const aid = getActiveId();
  const active = store[aid];
  if (!active) return;

  active.cxc ??= [];

  const cxc = active.cxc.find(c => c.id === id);
  if (!cxc) return;

  // marcar pagado
  cxc.estado = "Pagado";
  cxc.pagadoEn = todayISO();

  // crear pago
  active.pagos ??= [];
  active.pagos.push({
    id: "pay_" + uid(),
    fecha: todayISO(),
    concepto: cxc.concepto || "Cuota",
    nombre: cxc.nombre,
    monto: Number(cxc.monto || 0),
    origen: "CXC",
    refId: cxc.id
  });

  // guardar store
  store[aid] = active;
  xaSave(store);

  state.active = active;

  // refrescar UI
  rendercxc();
  renderIngresos?.();
  renderResumen?.();
}

function editCxc(id) {
  startEdit("cxc", id);
}

function saveCxc(id) {
  const venceRaw = document.getElementById(`ed_cxc_vence_${id}`)?.value || "";
  const nombre   = document.getElementById(`ed_cxc_nombre_${id}`)?.value.trim() || "";
  const concepto = document.getElementById(`ed_cxc_concepto_${id}`)?.value.trim() || "";
  const montoStr = document.getElementById(`ed_cxc_monto_${id}`)?.value || "0";
  const estado   = document.getElementById(`ed_cxc_estado_${id}`)?.value || "";
  const notas    = document.getElementById(`ed_cxc_notas_${id}`)?.value || "";

  const vence = requireDateValue(venceRaw, "esta cuenta por cobrar");
  if (!vence) return;
  const monto = requireMontoValue(montoStr, "esta cuenta por cobrar");
  if (monto === null) return;
  if (!nombre) return alert("El nombre no puede quedar vacío.");
  if (!concepto) return alert("El concepto no puede quedar vacío.");

  const active = getActive();
  const arr = active.cxc || [];

  active.cxc = arr.map(r => {
    if (r.id !== id) return r;
    return { ...r, vence, nombre, concepto, monto, estado, notas };
  });

  setActive(active);
  persistActive(active);
  editMode = { section: null, id: null };
  render();
}

window.editCxc = editCxc;
window.saveCxc = saveCxc;

// ===== INGRESOS: acciones =====
function editIngreso(id){
  startEdit("ingresos", id);
}

function saveIngreso(id){
  const fecha    = requireDateValue(document.getElementById(`ed_ing_fecha_${id}`)?.value, "este ingreso");
  const concepto = document.getElementById(`ed_ing_concepto_${id}`)?.value.trim() || "";
  const montoStr = document.getElementById(`ed_ing_monto_${id}`)?.value || "0";
  const medio    = document.getElementById(`ed_ing_medio_${id}`)?.value.trim() || "";
  const notas    = document.getElementById(`ed_ing_notas_${id}`)?.value || "";

  if (!fecha) return;
  const monto = requireMontoValue(montoStr, "este ingreso");
  if (monto === null) return;

  const active = getActive();
  active.ingresos = (active.ingresos || []).map(r =>
    r.id === id ? {
      ...r,
      fecha,
      concepto,
      monto,
      medio,
      notas
    } : r
  );

  setActive(active);
  persistActive(active);
  editMode = { section: null, id: null };
  render(); // tu wrapper -> renderAll()
}

window.editIngreso = editIngreso;
window.saveIngreso = saveIngreso;

// ===== GASTOS: acciones =====
function editGasto(id) {
  startEdit("gastos", id);
}

function saveGasto(id) {
  const fecha    = requireDateValue(document.getElementById(`ed_gas_fecha_${id}`)?.value, "este egreso");
  const concepto = document.getElementById(`ed_gas_concepto_${id}`)?.value.trim() || "";
  const categoria= document.getElementById(`ed_gas_categoria_${id}`)?.value.trim() || "";
  const montoStr = document.getElementById(`ed_gas_monto_${id}`)?.value || "0";
  const notas    = document.getElementById(`ed_gas_notas_${id}`)?.value || "";

  if (!fecha) return;
  const monto = requireMontoValue(montoStr, "este egreso");
  if (!concepto) return alert("El concepto no puede quedar vacío.");
  if (monto === null) return;

  const active = getActive();
  active.gastos = (active.gastos || []).map(r =>
    r.id === id ? { ...r, fecha, concepto, categoria, monto, notas } : r
  );

  setActive(active);
  persistActive(active);
  editMode = { section: null, id: null };
  render();
}

window.editGasto = editGasto;
window.saveGasto = saveGasto;


function rendercxc(){
  const q = ($("cxcSearch").value || "").trim();
  const active = state.active ?? getActive();
  const statusFilter = state.filters.cxcStatus || "pendientes";
  updateCxcFilterButtons();

  const rows = (active.cxc || [])
    .filter(x => !q || textMatch(x, q))
    .filter((r) => {
      const isPaid = String(r.estado || "").toLowerCase() === "pagado";
      if (statusFilter === "pagos") return isPaid;
      if (statusFilter === "pendientes") return !isPaid;
      return true;
    })
    .sort((a,b)=>(a.vence||"").localeCompare(b.vence||""));

  $("cxcCount").textContent = String(rows.length);

  const tbody = $("cxcTbody");
  tbody.innerHTML = "";

  const now = todayISO();

  for(const r of rows){
    const isPaid = String(r.estado || "").toLowerCase() === "pagado";
    const overdue = !isPaid && r.vence && r.vence < now;
    const badgeClass = isPaid ? "ok" : (overdue ? "due" : "");
    const displayName = getRecordAlumnoName(r);

    const editing = (editMode.section === "cxc" && editMode.id === r.id);

    const tr = document.createElement("tr");

    if (editing) tr.classList.add("editing-row");

    if (!editing) {
      tr.innerHTML = `
        <th scope="row">${escAttr(displayName||"")}</th>
        <td>${escAttr(r.concepto||"")}</td>
        <td>${money(r.monto||0)}</td>
        <td>${escAttr(r.vence||"")}</td>
        <td><span class="badge ${badgeClass}">${overdue ? "Vencido" : (r.estado||"")}</span></td>
        <td class="note-cell">${noteHtml(r.notas)}</td>
        <td class="actions-cell">
          ${
  String(r.estado || "").toLowerCase() !== "pagado"
    ? `<button class="ghost" data-act="pay" data-id="${r.id}" aria-label="Marcar pagado ${escAttr(r.concepto||"")} de ${escAttr(displayName||"")}">Marcar pagado</button>`
    : ""
}
          <button class="ghost" data-act="edit" data-id="${r.id}" aria-label="Editar CxC ${escAttr(r.concepto||"")} de ${escAttr(displayName||"")}">Editar</button>
          <button class="ghost danger" data-act="del" data-id="${r.id}" aria-label="Borrar CxC ${escAttr(r.concepto||"")} de ${escAttr(displayName||"")}">Borrar</button>
        </td>
      `;
    } else {
      tr.innerHTML = `
        <td><input id="ed_cxc_nombre_${r.id}" value="${escAttr(r.nombre||"")}" /></td>
        <td><input id="ed_cxc_concepto_${r.id}" value="${escAttr(r.concepto||"")}" /></td>
        <td><input id="ed_cxc_monto_${r.id}" type="number" min="0" step="1" value="${escAttr(r.monto ?? 0)}" /></td>
        <td><input id="ed_cxc_vence_${r.id}" type="date" value="${escAttr(r.vence||"")}" /></td>
        <td>
          <select id="ed_cxc_estado_${r.id}">
            <option value="" ${!r.estado ? "selected" : ""}></option>
            <option value="Pendiente" ${r.estado==="Pendiente" ? "selected" : ""}>Pendiente</option>
            <option value="Pagado" ${r.estado==="Pagado" ? "selected" : ""}>Pagado</option>
          </select>
        </td>
        <td><textarea id="ed_cxc_notas_${r.id}">${escAttr(r.notas||"")}</textarea></td>
        <td class="actions-cell">
          <button class="ghost" data-act="save" data-id="${r.id}">Guardar</button>
          <button class="ghost" data-act="cancel">Cancelar</button>
        </td>
      `;
    }

    tbody.appendChild(tr);
  }

  tbody.onclick = (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;

  const act = btn.dataset.act;
  const id = btn.dataset.id;

  if (act === "del") delRow("cxc", id);
  else if (act === "edit") editCxc(id);
  else if (act === "save") saveCxc(id);
  else if (act === "cancel") cancelEdit();
  else if (act === "pay") window.markCxcPaid(id);
};

}


function renderCxp(){
  const q = ($("cxpSearch").value || "").trim();
  const statusFilter = state.filters.cxpStatus || "pendientes";
  updateCxpFilterButtons();

  const rows = (state.active.cxp||[])
    .filter(x=>textMatch(x,q))
    .filter((r) => {
      const isPaid = String(r.estado || "").toLowerCase() === "pagado";
      if (statusFilter === "pagos") return isPaid;
      if (statusFilter === "pendientes") return !isPaid;
      return true;
    })
    .sort((a,b)=>(a.vence||"").localeCompare(b.vence||""));

  $("cxpCount").textContent = String(rows.length);
  const tbody = $("cxpTbody");
  tbody.innerHTML="";
  const now = todayISO();
  for(const r of rows){
    const editing = (editMode.section === "cxp" && editMode.id === r.id);
    const isPaid = String(r.estado || "").toLowerCase() === "pagado";
    const overdue = !isPaid && r.vence && r.vence < now;
    const badgeClass = isPaid ? "ok" : (overdue ? "due" : "");
    const tr=document.createElement("tr");

    if (editing) tr.classList.add("editing-row");

    if (!editing) {
      tr.innerHTML = `
        <th scope="row">${escAttr(r.vence||"")}</th>
        <td>${r.proveedor||""}</td>
        <td>${r.concepto||""}</td>
        <td>${money(r.monto||0)}</td>
        <td><span class="badge ${badgeClass}">${overdue ? "Vencido" : (r.estado||"")}</span></td>
        <td class="note-cell">${noteHtml(r.notas)}</td>
        <td class="actions-cell">
          ${
  !isPaid
    ? `<button class="ghost" data-act="pay" data-id="${r.id}" aria-label="Marcar pagado ${escAttr(r.concepto||"")} de ${escAttr(r.proveedor||"")}">Marcar pagado</button>`
    : ""
}
          <button class="ghost" data-act="edit" data-id="${r.id}" aria-label="Editar CxP ${escAttr(r.concepto||"")} de ${escAttr(r.proveedor||"")}">Editar</button>
          <button class="ghost danger" data-act="del" data-id="${r.id}" aria-label="Borrar CxP ${escAttr(r.concepto||"")} de ${escAttr(r.proveedor||"")}">Borrar</button>
        </td>`;
    } else {
      tr.innerHTML = `
        <td><input id="ed_cxp_vence_${r.id}" type="date" value="${escAttr(r.vence||"")}" /></td>
        <td><input id="ed_cxp_proveedor_${r.id}" value="${escAttr(r.proveedor||"")}" /></td>
        <td><input id="ed_cxp_concepto_${r.id}" value="${escAttr(r.concepto||"")}" /></td>
        <td><input id="ed_cxp_monto_${r.id}" type="number" min="0" step="1" value="${escAttr(r.monto ?? 0)}" /></td>
        <td>
          <select id="ed_cxp_estado_${r.id}">
            <option value="Pendiente" ${r.estado==="Pendiente" ? "selected" : ""}>Pendiente</option>
            <option value="Pagado" ${r.estado==="Pagado" ? "selected" : ""}>Pagado</option>
          </select>
        </td>
        <td><textarea id="ed_cxp_notas_${r.id}">${escAttr(r.notas||"")}</textarea></td>
        <td class="actions-cell">
          <button class="ghost" data-act="save" data-id="${r.id}">Guardar</button>
          <button class="ghost" data-act="cancel">Cancelar</button>
        </td>`;
    }
    tbody.appendChild(tr);
  }
  tbody.onclick = (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;

    const id = btn.dataset.id;
    const act = btn.dataset.act;

    if (act === "del") delRow("cxp", id);
    else if (act === "edit") editCxp(id);
    else if (act === "save") saveCxp(id);
    else if (act === "cancel") cancelEdit();
    else if (act === "pay") window.markCxpPaid(id);
  };
}

function renderInventario(){
  const q = $("invSearch").value || "";
  const rows = (state.active.inventario||[])
    .filter(x=>textMatch(x,q))
    .sort((a,b)=>(a.categoria||"").localeCompare(b.categoria||"") || (a.producto||"").localeCompare(b.producto||""));

  $("invCount").textContent = String(rows.length);
  const tbody = $("invTbody");
  tbody.innerHTML="";
  for(const r of rows){
    const low = Number(r.stock||0) <= Number(r.minimo||0);
    const tr=document.createElement("tr");
    const editing = isEditing("inventario", r.id);
    if (!editing) {
      tr.innerHTML = `
        <th scope="row">${r.categoria||""}</th>
        <td>${r.producto||""}</td>
        <td>${Number(r.stock||0)}</td>
        <td>${Number(r.minimo||0)}</td>
        <td>${r.costo? money(r.costo): ""}</td>
        <td><span class="badge ${low?"due":"ok"}">${low?"Bajo stock":"OK"}</span></td>
        <td>
          <button class="ghost" data-act="edit" data-id="${r.id}" aria-label="Editar inventario ${escAttr(r.producto||"")} en ${escAttr(r.categoria||"")}">Editar</button>
          <button class="ghost danger" data-act="del" data-id="${r.id}" aria-label="Borrar inventario ${escAttr(r.producto||"")} en ${escAttr(r.categoria||"")}">Borrar</button>
        </td>`;
    } else {
      tr.innerHTML = `
        <td><input id="ed_inv_categoria_${r.id}" value="${escAttr(r.categoria||"")}" /></td>
        <td><input id="ed_inv_producto_${r.id}" value="${escAttr(r.producto||"")}" /></td>
        <td><input id="ed_inv_stock_${r.id}" type="number" min="0" step="1" value="${escAttr(r.stock ?? 0)}" /></td>
        <td><input id="ed_inv_minimo_${r.id}" type="number" min="0" step="1" value="${escAttr(r.minimo ?? 0)}" /></td>
        <td><input id="ed_inv_costo_${r.id}" type="number" min="0" step="0.01" value="${r.costo ?? ""}" /></td>
        <td><span class="badge ${low?"due":"ok"}">${low?"Bajo stock":"OK"}</span></td>
        <td>
          <button class="ghost" data-act="save" data-id="${r.id}">Guardar</button>
          <button class="ghost" data-act="cancel">Cancelar</button>
        </td>`;
    }
    tbody.appendChild(tr);
  }
  tbody.onclick = (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;

    const { act, id } = btn.dataset;
    if (act === "del") delRow("inventario", id);
    else if (act === "edit") editInventario(id);
    else if (act === "save") saveInventario(id);
    else if (act === "cancel") cancelEdit();
  };
}

/* ---------- CRUD helpers ---------- */
function loadStore() {
  return JSON.parse(localStorage.getItem("xa_store_v1") || "{}");
}

function saveStore(store) {
  safeSetItem("xa_store_v1", store || {});
}

async function delRow(listName, id) {
  if (!confirm("¿Borrar este registro?")) return;

  const active = getActive();
  active[listName] ??= [];

  // borrar por id
  active[listName] = active[listName].filter(x => x.id !== id);

  // guardar y refrescar UI (esto recalcula el resumen)
  saveActiveData(active);
  state.active = active;
  renderAll();
}


function loadIngreso(id){
  const r=(state.active.ingresos||[]).find(x=>x.id===id); if(!r) return;
  $("inFecha").value=r.fecha||todayISO();
  $("inConcepto").value=r.concepto||"";
  $("inMonto").value=r.monto||"";
  $("inMedio").value=r.medio||"Efectivo";
  $("inNotas").value=r.notas||"";
  $("addIngresoBtn").dataset.editId=id;
  $("addIngresoBtn").textContent="Actualizar ingreso";
  runFinanceValidation("ingresos");
}
function clearIngresoForm(){
  ["inConcepto","inMonto","inNotas"].forEach((id) => {
    const el = $(id);
    if (el) el.value = "";
  });
  const fecha = $("inFecha");
  if (fecha) fecha.value = todayISO();
  const medio = $("inMedio");
  if (medio) medio.value = "Efectivo";
  const btn = $("addIngresoBtn");
  if (btn) {
    delete btn.dataset.editId;
    btn.textContent = "Guardar ingreso";
  }
  runFinanceValidation("ingresos");
}
function loadGasto(id){
  const r = (state.active.gastos || []).find(x => x.id === id);
  if(!r) return;

  $("gaConcepto").value  = r.concepto || "";
  $("gaFecha").value     = r.fecha || "";        // 👈 no uses todayISO acá
  $("gaMonto").value     = String(r.monto ?? "");
  $("gaCategoria").value = r.categoria || "";
  $("gaNotas").value     = r.notas || "";

  $("addGastoBtn").dataset.editId = id;
  $("addGastoBtn").textContent = "Actualizar egreso";
  runFinanceValidation("gastos");

}

function clearGastoForm(){
  ["gaConcepto","gaMonto","gaCategoria","gaNotas"].forEach(id=>$(id).value="");
  $("gaFecha").value=todayISO();
  delete $("addGastoBtn").dataset.editId;
  $("addGastoBtn").textContent="Guardar egreso";
  runFinanceValidation("gastos");
}
function loadCxc(id){
  const r=(state.active.cxc||[]).find(x=>x.id===id); if(!r) return;
  $("cxcnombre").value=r.nombre||"";
  $("cxcvence").value=r.vence||todayISO();
  $("cxcconcepto").value=r.concepto||"";
  $("cxcmonto").value=r.monto||"";
  $("cxcestado").value=r.estado||"Pendiente";
  $("cxcnotas").value=r.notas||"";
  $("addCxcBtn").dataset.editId=id;
  $("addCxcBtn").textContent="Actualizar";
  runFinanceValidation("cxc");
}
function clearCxcForm(){
  ["cxcnombre","cxcconcepto","cxcmonto","cxcnotas"].forEach(id=>$(id).value="");
  $("cxcvence").value=todayISO();
  $("cxcestado").value="Pendiente";
  delete $("addCxcBtn").dataset.editId;
  $("addCxcBtn").textContent="Guardar";
  runFinanceValidation("cxc");
}
function loadCxp(id){
  const r=(state.active.cxp||[]).find(x=>x.id===id); if(!r) return;
  $("cxpproveedor").value=r.proveedor||"";
  $("cxpvence").value=r.vence||todayISO();
  $("cxpconcepto").value=r.concepto||"";
  $("cxpmonto").value=r.monto||"";
  $("cxpestado").value=r.estado||"Pendiente";
  $("cxpnotas").value=r.notas||"";
  $("addCxpBtn").dataset.editId=id;
  $("addCxpBtn").textContent="Actualizar";
  runFinanceValidation("cxp");
}
function clearCxpForm(){
  ["cxpproveedor","cxpconcepto","cxpmonto","cxpnotas"].forEach(id=>$(id).value="");
  $("cxpvence").value=todayISO();
  $("cxpestado").value="Pendiente";
  delete $("addCxpBtn").dataset.editId;
  $("addCxpBtn").textContent="Guardar";
  runFinanceValidation("cxp");
}
function editCxp(id) {
  startEdit("cxp", id);
}
function saveCxp(id) {
  const proveedor = document.getElementById(`ed_cxp_proveedor_${id}`)?.value.trim() || "";
  const venceRaw  = document.getElementById(`ed_cxp_vence_${id}`)?.value || "";
  const concepto  = document.getElementById(`ed_cxp_concepto_${id}`)?.value.trim() || "";
  const montoStr  = document.getElementById(`ed_cxp_monto_${id}`)?.value || "0";
  const estado    = document.getElementById(`ed_cxp_estado_${id}`)?.value || "Pendiente";
  const notas     = document.getElementById(`ed_cxp_notas_${id}`)?.value || "";
  const isPaid    = String(estado || "").toLowerCase() === "pagado";

  const vence = requireDateValue(venceRaw, "esta cuenta por pagar");
  if (!vence) return;
  const monto = requireMontoValue(montoStr, "esta cuenta por pagar");
  if (monto === null) return;
  if (!proveedor) return alert("El proveedor es obligatorio.");
  if (!concepto) return alert("El concepto no puede quedar vacío.");

  const active = getActive();
  active.cxp = (active.cxp || []).map(c => {
    if (c.id !== id) return c;
    const next = { ...c, proveedor, vence, concepto, monto, estado, notas };
    if (isPaid) next.pagadoEn = c.pagadoEn || todayISO();
    else delete next.pagadoEn;
    return next;
  });

  const updated = (active.cxp || []).find(c => c.id === id);
  syncCxpExpense(active, updated);

  setActive(active);
  persistActive(active);
  editMode = { section: null, id: null };
  render();
  showSoftBanner("✅ Cuenta agregada");
}
window.editCxp = editCxp;
window.saveCxp = saveCxp;
function loadInv(id){
  const r=(state.active.inventario||[]).find(x=>x.id===id); if(!r) return;
  $("invCategoria").value=r.categoria||"";
  $("invProducto").value=r.producto||"";
  $("invStock").value=r.stock??"";
  $("invMin").value=r.minimo??"";
  $("invCosto").value=r.costo??"";
  $("saveInvBtn").dataset.editId=id;
  $("saveInvBtn").textContent="Actualizar";
}
function clearInvForm(){
  ["invCategoria","invProducto","invStock","invMin","invCosto"].forEach(id=>$(id).value="");
  delete $("saveInvBtn").dataset.editId;
  $("saveInvBtn").textContent="Guardar";
}
function editInventario(id) {
  startEdit("inventario", id);
}
function saveInventario(id) {
  const categoria = document.getElementById(`ed_inv_categoria_${id}`)?.value.trim() || "";
  const producto  = document.getElementById(`ed_inv_producto_${id}`)?.value.trim() || "";
  const stockStr  = document.getElementById(`ed_inv_stock_${id}`)?.value || "0";
  const minimoStr = document.getElementById(`ed_inv_minimo_${id}`)?.value || "0";
  const costoStr  = document.getElementById(`ed_inv_costo_${id}`)?.value ?? "";

  const stock = Number(stockStr);
  const minimo = Number(minimoStr);
  const costo = costoStr === "" ? null : Number(costoStr);

  if (!categoria || !producto) return alert("Poné categoría y producto.");
  if (Number.isNaN(stock) || stock < 0) return alert("El stock tiene que ser un número válido.");
  if (Number.isNaN(minimo) || minimo < 0) return alert("El mínimo tiene que ser un número válido.");
  if (costo !== null && (Number.isNaN(costo) || costo < 0)) return alert("El costo tiene que ser un número válido.");

  const active = getActive();
  active.inventario = (active.inventario || []).map(item =>
    item.id === id ? { ...item, categoria, producto, stock, minimo, costo } : item
  );

  setActive(active);
  persistActive(active);
  editMode = { section: null, id: null };
  render();
  showSoftBanner("✅ Producto guardado");
}
window.editInventario = editInventario;
window.saveInventario = saveInventario;
function markCxcPaid(id) {
  log.info("🔥 markCxcPaid ejecutándose", { id });

  const active = getActive();

  // asegurar arrays
  active.cxc ??= [];
  active.ingresos ??= [];

  const idx = active.cxc.findIndex(c => c.id === id);
  if (idx < 0) {
    log.warn("❌ No se encontró la CxC", { id });
    return;
  }

  // confirmación CORRECTA
  const ok = confirm("Marcar como pagado y crear ingreso automáticamente?");
  log.info("Confirmación de pago de CxC", { ok });
  if (!ok) return;

  // marcar como pagado
  const cxc = active.cxc[idx];
  cxc.estado = "Pagado";
  cxc.pagadoEn = todayISO();

  // crear ingreso automático
  const hasIngreso = (active.ingresos || []).some((ingreso) =>
    (String(ingreso.source || "").toLowerCase() === "cxc" && ingreso.sourceId === cxc.id)
    || (ingreso.origen === "CXC" && ingreso.refId === cxc.id)
  );

  if (!hasIngreso) {
    const templateId = state.activeTemplateId || getActiveId();
    const mes = getActiveTemplateName();
    const alumnoNombre = cxc.alumnoNombre || cxc.nombre || "";
    active.ingresos.push({
      id: "ing_" + uid(),
      fecha: todayISO(),
      concepto: cxc.concepto || "Cuota",
      nombre: alumnoNombre,
      alumnoId: cxc.alumnoId || "",
      alumnoNombre,
      tipo: "Cuota",
      categoria: "Cuota",
      monto: Number(cxc.monto || 0),
      medio: "Efectivo",
      estado: "Pagado",
      origen: "CXC",
      refId: cxc.id,
      source: "cxc",
      sourceId: cxc.id,
      templateId,
      mes
    });
  }

  // persistir y refrescar UI
  saveActiveData(active);
  state.active = active;

  // refrescar todo
  renderAll();

  log.info("✅ CxC marcada como pagada correctamente", { id });
}

window.markCxcPaid = markCxcPaid;

function syncCxpExpense(active, cxp) {
  if (!active || !cxp) return;

  active.gastos ??= [];
  const idx = active.gastos.findIndex(g => g.origen === "CXP" && g.refId === cxp.id);
  const isPaid = String(cxp.estado || "").toLowerCase() === "pagado";

  if (!isPaid) {
    if (idx >= 0) active.gastos.splice(idx, 1);
    return;
  }

  const payload = {
    id: idx >= 0 ? active.gastos[idx].id : "gas_" + uid(),
    fecha: cxp.pagadoEn || todayISO(),
    concepto: cxp.concepto || cxp.proveedor || "Pago de CxP",
    categoria: cxp.proveedor || "",
    monto: Number(cxp.monto || 0),
    notas: cxp.notas || "",
    origen: "CXP",
    refId: cxp.id
  };

  if (idx >= 0) active.gastos[idx] = { ...active.gastos[idx], ...payload };
  else active.gastos.push(payload);
}

function markCxpPaid(id) {
  log.info("🔥 markCxpPaid ejecutándose", { id });

  const active = getActive();
  active.cxp ??= [];

  const idx = active.cxp.findIndex(c => c.id === id);
  if (idx < 0) {
    log.warn("❌ No se encontró la CxP", { id });
    return;
  }

  const ok = confirm("Marcar como pagado y crear egreso automáticamente?");
  log.info("Confirmación de pago de CxP", { ok });
  if (!ok) return;

  const cxp = active.cxp[idx];
  active.cxp[idx] = { ...cxp, estado: "Pagado", pagadoEn: todayISO() };

  syncCxpExpense(active, active.cxp[idx]);

  saveActiveData(active);
  state.active = active;
  renderAll();

  log.info("✅ CxP marcada como pagada correctamente", { id });
}

window.markCxpPaid = markCxpPaid;



function renderResumen() {
  const active = getActive?.() || state?.active;
  if (!active) return;

  const ingresos = (active.ingresos || []).filter(i => {
    const estado = String(i.estado || "").toLowerCase();
    return !estado || estado === "pagado";
  });
  const egresos  = (active.egresos  || []).filter(e => (e.estado || "pagado").toLowerCase() === "pagado");

  const totalIngresos = ingresos.reduce((a, i) => a + Number(i.monto || 0), 0);
  const totalEgresos  = egresos.reduce((a, e) => a + Number(e.monto || 0), 0);
  const balance = totalIngresos - totalEgresos;

  // Intento de actualizar elementos comunes (si existen)
  const setMoney = (sel, val) => {
    const el = document.querySelector(sel);
    if (el) el.textContent = "$ " + val.toLocaleString("es-UY");
  };

  setMoney("#kpiIngresos", totalIngresos);
  setMoney("#kpiEgresos", totalEgresos);
  setMoney("#kpiBalance", balance);


  // Por si tus IDs son otros, también prueba por data-attrs comunes:
  setMoney('[data-kpi="ingresos"]', totalIngresos);
  setMoney('[data-kpi="egresos"]', totalEgresos);
  setMoney('[data-kpi="balance"]', balance);
}

window.renderResumen = renderResumen;

/* ---------- Actions / Events ---------- */
function wireActions(){
  try {
    setupFinanceValidationListeners();

    // Global filters
    $("monthFilter").addEventListener("change", (e) => {
      state.filters.month = e.target.value || monthISO();
      renderDashboard();
    });
    $("searchAll").addEventListener("input", (e) => {
      state.filters.search = e.target.value || "";
      renderDashboard();
    });

    // Searches
    $("ingSearch").addEventListener("input", renderIngresos);
    $("gasSearch").addEventListener("input", renderGastos);
    $("cxcSearch").addEventListener("input", rendercxc);
    $("cxpSearch").addEventListener("input", renderCxp);
    $("invSearch").addEventListener("input", renderInventario);

    // Add / update
    $("addIngresoBtn").addEventListener("click", async()=>{
      const { hasError, values } = runFinanceValidation("ingresos");
      if (hasError) return;
      const active = getActive();
      const templateId = state.activeTemplateId || getActiveId();
      const mes = getActiveTemplateName();

      const data={
        id: $("addIngresoBtn").dataset.editId || uid(),
        fecha: values.fecha || todayISO(),
        concepto: values.concepto || $("inConcepto").value.trim(),
        monto: values.monto ?? 0,
        medio: $("inMedio").value,
        notas: $("inNotas").value.trim(),
        templateId,
        mes
      };
      upsert("ingresos", data, $("addIngresoBtn").dataset.editId);
      await persistActive();
      clearIngresoForm();
      closeAddIngresoModal();
      renderAll();
    });
    $("clearIngresoBtn").addEventListener("click", clearIngresoForm);

    $("addGastoBtn").addEventListener("click", async () => {
      const categoria = $("gaCategoria").value.trim();
      const notas     = $("gaNotas").value.trim();
      const { hasError, values } = runFinanceValidation("gastos");
      if (hasError) return;

      const btn = $("addGastoBtn");
      const editId = btn.dataset.editId || null;

      const active = getActive();
      active.gastos ??= [];
      const prev = editId ? active.gastos.find(g => g.id === editId) : null;

      const payload = {
        concepto: values.concepto || "",
        fecha: values.fecha || todayISO(),
        monto: values.monto ?? 0,
        categoria,
        notas
      };

      if (editId) {
        if (!prev) return alert("No encontré ese egreso para editar.");

        active.gastos = active.gastos.map(g => (g.id === editId ? { ...g, ...payload } : g));

        // salir del modo edición
        delete btn.dataset.editId;
        btn.textContent = "Agregar egreso";

      } else {
        active.gastos.push({ id: uid(), ...payload });
      }

      setActive(active);
      state.active = active;
      await persistActive(active);

      clearGastoForm();
      closeAddGastoModal();
      renderAll();
    });

    const btnClearGasto = $("clearGastoBtn");
    if (btnClearGasto) btnClearGasto.addEventListener("click", clearGastoForm);

    const btnClearCxc = $("clearCxcBtn");
    if (btnClearCxc) btnClearCxc.addEventListener("click", clearCxcForm);

    const btnAddCxc = $("addCxcBtn");
    if (btnAddCxc) btnAddCxc.addEventListener("click", async () => {
      const { hasError, values } = runFinanceValidation("cxc");
      if (hasError) return;

      const data = {
        id: btnAddCxc.dataset.editId || uid(),
        nombre: values.nombre || "",
        vence: values.vence || todayISO(),
        concepto: values.concepto || "",
        monto: values.monto ?? 0,
        estado: $("cxcestado").value || "Pendiente",
        notas: $("cxcnotas").value.trim()
      };

      upsert("cxc", data, btnAddCxc.dataset.editId);
      await persistActive();
      clearCxcForm();
      renderAll();
      showSoftBanner("✅ Cuenta agregada");
      closeAddCxcModal();
    });

    const btnAddCxp = $("addCxpBtn");
    if (btnAddCxp) btnAddCxp.addEventListener("click", async()=>{ 
      const { hasError, values } = runFinanceValidation("cxp");
      if (hasError) return;

      const data={
        id: $("addCxpBtn").dataset.editId || uid(),
        proveedor: values.proveedor || "",
        vence: values.vence || todayISO(),
        concepto: values.concepto || "",
        monto: values.monto ?? 0,
        estado: $("cxpestado").value,
        notas: $("cxpnotas").value.trim()
      };
      const isPaid = String(data.estado || "").toLowerCase() === "pagado";
      if (isPaid) data.pagadoEn = data.pagadoEn || todayISO();
      upsert("cxp", data, $("addCxpBtn").dataset.editId);
      const active = state.active || getActive();
      const saved = (active.cxp || []).find(c => c.id === data.id);
      syncCxpExpense(active, saved);
      state.active = active;
      await persistActive(active); clearCxpForm(); renderAll();
      showSoftBanner("✅ Cuenta agregada");
      closeAddCxpModal();
    });
    $("clearCxpBtn").addEventListener("click", clearCxpForm);

    $("saveInvBtn").addEventListener("click", async()=>{
      const data={
        id: $("saveInvBtn").dataset.editId || uid(),
        categoria: $("invCategoria").value.trim(),
        producto: $("invProducto").value.trim(),
        stock: Number($("invStock").value||0),
        minimo: Number($("invMin").value||0),
        costo: $("invCosto").value ? Number($("invCosto").value) : null
      };
      if(!data.categoria || !data.producto){ alert("Poné categoría y producto."); return; }
      upsert("inventario", data, $("saveInvBtn").dataset.editId);
      await persistActive();
      clearInvForm();
      closeAddInventarioModal();
      renderAll();
      showSoftBanner("✅ Producto guardado");
    });
    $("clearInvBtn").addEventListener("click", clearInvForm);

    // Plantillas
    $("createTplBtn").addEventListener("click", async()=>{
      const name = $("tplName").value.trim() || monthISO();
      if(state.templates.some(t=>t.name===name)){ alert("Ya existe una plantilla con ese nombre."); return; }
      const t=emptyTemplate(name);
      await dbPut("templates", t);
      state.templates = sortTemplates(await dbGetAll("templates"));
      await saveTemplateToCloud(name, t);
      setActiveTemplate(t.id);
      $("tplName").value="";
      refreshTemplateSelectors();
    });
    $("cloneTplBtn").addEventListener("click", async () => {
      const fromId = $("tplCloneFrom").value;
      const name = $("tplName").value.trim() || monthISO();

      if (!fromId) { alert("Elegí una plantilla para copiar."); return; }
      if (state.templates.some(t => t.name === name)) { alert("Ya existe ese nombre."); return; }

      // 1) crear nueva plantilla (solo meta) en IndexedDB
      const newTpl = emptyTemplate(name);
      await dbPut("templates", newTpl);

      // 2) leer datos reales de la plantilla origen (desde xa_store_v1 usando el ID)
      setActiveId(fromId);
      const baseData = getActive();

      // 3) armar data del nuevo mes
      const monthData = {
        alumnos: (baseData.alumnos || []).map(a => ({ ...a })),          // copiamos alumnos
        inventario: (baseData.inventario || []).map(i => ({ ...i })),   // opcional (dejalo si querés)
        ingresos: [],
        gastos: [],
        pagos: [],
        asistencia: [],
        cxc: [],
        cxp: [] // si querés arrancar el mes con cxp vacío, dejalo así
      };

      // 4) generar CxC nuevas para TODOS los alumnos
      for (const a of monthData.alumnos) {
        addCuotaPendiente(monthData, a);
      }

      // 5) guardar data del nuevo mes en xa_store_v1 bajo el id de la NUEVA plantilla
      setActiveId(newTpl.id);
      saveActiveData(monthData);
      await saveTemplateToCloud(name, { ...monthData, id: newTpl.id, name });

      // 6) recargar lista de plantillas y activar la nueva
      state.templates = sortTemplates(await dbGetAll("templates"));
      refreshTemplateSelectors();
      setActiveTemplate(newTpl.id);

      $("tplName").value = "";
    });

    $("tplActive").addEventListener("change",(e)=>setActiveTemplate(e.target.value));

    $("deleteTplBtn").addEventListener("click", async()=>{
      if(state.templates.length<=1){ alert("Tenés que dejar al menos una plantilla."); return; }
      const activeId = state.activeTemplateId;
      const tplMeta = state.templates.find(t => t.id === activeId) || state.active;
      const tplName = tplMeta?.name || "esta plantilla";

      if(!confirm(`¿Borrar la plantilla "${tplName}"? (No se puede deshacer)`)) return;

      await dbDelete("templates", activeId);
      await deleteTemplateFromCloud(tplName);

      // limpiar datos locales asociados en localStorage
      const store = xaLoad();
      if (store && Object.prototype.hasOwnProperty.call(store, activeId)) {
        delete store[activeId];
        xaSave(store);
      }

      state.templates = sortTemplates(await dbGetAll("templates"));
      const next = state.templates[state.templates.length-1];
      if (next) setActiveTemplate(next.id);
    });

    // Export/Import backups
    $("exportBackupBtn").addEventListener("click", exportBackup);
    const exportBackupTplBtn = $("exportBackupTplBtn");
    if (exportBackupTplBtn) exportBackupTplBtn.addEventListener("click", exportBackup);
    $("importBackupBtn").addEventListener("click", ()=> $("filePicker").click());
    $("filePicker").addEventListener("change", importBackup);

    // CSV export (todas las plantillas)
    const b6 = $("exportCsvAllBtn");      if (b6) b6.addEventListener("click", exportAllZip);

    // ===== ALUMNOS =====
    const btnAddA = $("addAlumnoBtn");
    if (btnAddA) btnAddA.addEventListener("click", addOrUpdateAlumno);

    const btnClrA = $("clearAlumnoBtn");
    if (btnClrA) btnClrA.addEventListener("click", clearAlumnoForm);

    const openAddAlumnoModalBtn = $("openAddAlumnoModalBtn");
    if (openAddAlumnoModalBtn) {
      openAddAlumnoModalBtn.addEventListener("click", () => {
        clearAlumnoForm();
        openAddAlumnoModal({ title: "Agregar alumno" });
      });
    }

    const openAddIngresoModalBtn = $("openAddIngresoModalBtn");
    if (openAddIngresoModalBtn) {
      openAddIngresoModalBtn.addEventListener("click", () => {
        openAddIngresoModal({ title: "Agregar ingreso" });
        clearIngresoForm();
      });
    }

    const openAddGastoModalBtn = $("openAddGastoModalBtn");
    if (openAddGastoModalBtn) {
      openAddGastoModalBtn.addEventListener("click", () => {
        clearGastoForm();
        openAddGastoModal({ title: "Agregar egreso" });
      });
    }

    const openAddInventarioModalBtn = $("openAddInventarioModalBtn");
    if (openAddInventarioModalBtn) {
      openAddInventarioModalBtn.addEventListener("click", () => {
        clearInvForm();
        openAddInventarioModal({ title: "Agregar producto" });
      });
    }

    const openAddCxcModalBtn = $("openAddCxcModalBtn");
    if (openAddCxcModalBtn) {
      openAddCxcModalBtn.addEventListener("click", () => {
        clearCxcForm();
        openAddCxcModal({ title: "Agregar cuenta por cobrar" });
      });
    }

    const openAddCxpModalBtn = $("openAddCxpModalBtn");
    if (openAddCxpModalBtn) {
      openAddCxpModalBtn.addEventListener("click", () => {
        clearCxpForm();
        openAddCxpModal({ title: "Agregar cuenta por pagar" });
      });
    }

    const sA = $("alSearch");
    if (sA) sA.addEventListener("input", renderAlumnos);

    const filterActivos = $("alFilterActivos");
    if (filterActivos) filterActivos.addEventListener("click", () => setAlumnoStatusFilter("activos"));

    const filterInactivos = $("alFilterInactivos");
    if (filterInactivos) filterInactivos.addEventListener("click", () => setAlumnoStatusFilter("inactivos"));

    const cxcFilterPendientes = $("cxcFilterPendientes");
    if (cxcFilterPendientes) cxcFilterPendientes.addEventListener("click", () => setCxcStatusFilter("pendientes"));

    const cxcFilterPagos = $("cxcFilterPagos");
    if (cxcFilterPagos) cxcFilterPagos.addEventListener("click", () => setCxcStatusFilter("pagos"));

    const cxpFilterPendientes = $("cxpFilterPendientes");
    if (cxpFilterPendientes) cxpFilterPendientes.addEventListener("click", () => setCxpStatusFilter("pendientes"));

    const cxpFilterPagos = $("cxpFilterPagos");
    if (cxpFilterPagos) cxpFilterPagos.addEventListener("click", () => setCxpStatusFilter("pagos"));

    const nac = $("alNacimiento");
    if (nac) {
      nac.addEventListener("change", ()=>{
        const edad = $("alEdad");
        if (edad) edad.value = calcAge(nac.value);
      });
    }
  } catch (err) {
    log.error("wireActions error:", err);
    alert("Error interno en la app. Revisá consola.");
  }
}

function upsert(listName, data, editId){
  const arr = state.active[listName]||[];
  if(editId){
    const i=arr.findIndex(x=>x.id===editId);
    if(i>=0) arr[i]=data;
  }else{
    arr.push(data);
  }
  state.active[listName]=arr;
}

function refreshTemplateSelectors(){
  const activeSel = $("tplActive");
  const cloneSel = $("tplCloneFrom");
  activeSel.innerHTML=""; cloneSel.innerHTML="";
  for(const t of state.templates){
    const o1=document.createElement("option");
    o1.value=t.id; o1.textContent=t.name;
    if(t.id===state.activeTemplateId) o1.selected=true;
    activeSel.appendChild(o1);

    const o2=document.createElement("option");
    o2.value=t.id; o2.textContent=t.name;
    if(t.id===state.activeTemplateId) o2.selected=true;
    cloneSel.appendChild(o2);
  }
}

/* ---------- Backup & Export ---------- */
function buildBackupTemplates() {
  const store = xaLoad() || {};
  const templatesById = new Map(state.templates.map((tpl) => [tpl.id, { ...tpl }]));

  for (const [id, data] of Object.entries(store)) {
    if (!templatesById.has(id)) {
      templatesById.set(id, {
        ...data,
        id,
        name: getTemplateName(data) || data.name || id,
        createdAt: data.createdAt || Date.now(),
        updatedAt: data.updatedAt || Date.now()
      });
      continue;
    }

    const base = templatesById.get(id);
    templatesById.set(id, {
      ...base,
      ...data,
      id: base.id,
      name: getTemplateName(base) || getTemplateName(data) || base.name || data.name || id
    });
  }

  return Array.from(templatesById.values());
}

function exportBackup(){
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    templates: buildBackupTemplates()
  };
  const blob = new Blob([JSON.stringify(payload,null,2)], {type:"application/json"});
  download(`xtreme-backup-${monthISO()}.json`, blob);
}

async function importBackup(e){
  const file = e.target.files && e.target.files[0];
  if(!file) return;
  try{
    const txt = await file.text();
    const payload = JSON.parse(txt);
    if(!payload.templates || !Array.isArray(payload.templates)) throw new Error("Formato inválido");

    const version = Number(payload.version || 0);
    if (version && version !== 1) {
      const ok = confirm(`El respaldo es de versión ${version} y la app espera v1. ¿Intentar importarlo igual?`);
      if (!ok) return;
    }

    const summaryLines = payload.templates.map(t => {
      const name = t.name || "(sin nombre)";
      const ing = (t.ingresos||[]).length;
      const gas = (t.gastos||[]).length;
      const cxc = (t.cxc||[]).length;
      const cxp = (t.cxp||[]).length;
      const inv = (t.inventario||[]).length;
      const alumnos = (t.alumnos||[]).length;
      return `- ${name} (ing:${ing} gas:${gas} cxc:${cxc} cxp:${cxp} inv:${inv} alumnos:${alumnos})`;
    }).join("\n");

    const filterName = prompt(
      `Plantillas encontradas (${payload.templates.length}):\n${summaryLines}\n\nEscribí el nombre que querés importar o dejá vacío para importar todas.`
    )?.trim();

    const selected = filterName
      ? payload.templates.filter(t => String(t.name || "").trim() === filterName)
      : payload.templates;

    if (filterName && selected.length === 0) {
      alert("No encontré esa plantilla en el respaldo.");
      return;
    }

    if(!confirm(`¿Importar ${selected.length} plantilla(s)? Esto reemplaza/mezcla plantillas existentes por nombre.`)) return;

    // Merge by name (unique)
    const existing = await dbGetAll("templates");
    const byName = new Map(existing.map(t=>[t.name,t]));
    for(const t of selected){
      // Normalize
      if(!t.id) t.id=uid();
      t.updatedAt=Date.now();
      byName.set(t.name, t);
    }
    const store = xaLoad() || {};
    for(const t of byName.values()){
      await dbPut("templates", t);
      store[t.id] = t;
    }
    xaSave(store);
    state.templates = sortTemplates(await dbGetAll("templates"));
    // Keep current active if possible
    const still = state.templates.find(t=>t.id===state.activeTemplateId) || state.templates[state.templates.length-1];
    setActiveTemplate(still.id);
    alert("Respaldo importado.");
  }catch(err){
    alert("No pude importar: " + (err.message||err));
  }finally{
    e.target.value="";
  }
}

const CSV_IMPORT_HEADERS = {
  ingresos: ["fecha", "concepto", "monto", "medio", "notas"],
  gastos: ["fecha", "concepto", "categoria", "monto", "notas"],
  cxc: ["vence", "nombre", "concepto", "monto", "estado", "notas"],
  cxp: ["vence", "proveedor", "concepto", "monto", "estado", "notas"],
  inventario: ["categoria", "producto", "stock", "minimo", "costo"]
};

function normalizeCsvHeader(value) {
  return String(value ?? "").trim().toLowerCase();
}

function parseCsvNumber(value) {
  const raw = String(value ?? "").replace(",", ".").trim();
  const amount = Number(raw);
  return Number.isFinite(amount) ? amount : 0;
}

function parseCsvObjects(text, listName) {
  const rows = parseCSV(text || "");
  if (!rows.length) return [];

  const expected = CSV_IMPORT_HEADERS[listName] || [];
  const normalizedExpected = expected.map(normalizeCsvHeader);
  const firstRow = rows[0].map(normalizeCsvHeader);
  const hasHeader = firstRow.some((cell) => normalizedExpected.includes(cell));
  const headers = hasHeader ? firstRow : normalizedExpected;
  const startIndex = hasHeader ? 1 : 0;

  const objects = [];
  for (let i = startIndex; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || !row.some((cell) => String(cell ?? "").trim() !== "")) continue;
    const obj = {};
    headers.forEach((header, index) => {
      if (!header) return;
      obj[header] = row[index] ?? "";
    });
    objects.push(obj);
  }

  return objects;
}

function buildCsvRecord(listName, raw) {
  const value = (key) => String(raw?.[key] ?? "").trim();

  if (listName === "ingresos") {
    const fecha = value("fecha");
    const concepto = value("concepto");
    if (!fecha || !concepto) return null;
    return {
      id: uid(),
      fecha,
      concepto,
      monto: parseCsvNumber(raw.monto),
      medio: value("medio"),
      notas: value("notas")
    };
  }

  if (listName === "gastos") {
    const fecha = value("fecha");
    const concepto = value("concepto");
    if (!fecha || !concepto) return null;
    return {
      id: uid(),
      fecha,
      concepto,
      categoria: value("categoria"),
      monto: parseCsvNumber(raw.monto),
      notas: value("notas")
    };
  }

  if (listName === "cxc") {
    const vence = value("vence");
    const nombre = value("nombre");
    const concepto = value("concepto");
    if (!vence || !nombre || !concepto) return null;
    return {
      id: uid(),
      vence,
      nombre,
      concepto,
      monto: parseCsvNumber(raw.monto),
      estado: value("estado") || "Pendiente",
      notas: value("notas")
    };
  }

  if (listName === "cxp") {
    const vence = value("vence");
    const proveedor = value("proveedor");
    const concepto = value("concepto");
    if (!vence || !proveedor || !concepto) return null;
    return {
      id: uid(),
      vence,
      proveedor,
      concepto,
      monto: parseCsvNumber(raw.monto),
      estado: value("estado") || "Pendiente",
      notas: value("notas")
    };
  }

  if (listName === "inventario") {
    const producto = value("producto");
    if (!producto) return null;
    return {
      id: uid(),
      categoria: value("categoria"),
      producto,
      stock: parseCsvNumber(raw.stock),
      minimo: parseCsvNumber(raw.minimo),
      costo: parseCsvNumber(raw.costo)
    };
  }

  return null;
}

async function importCSV(event) {
  const input = event.target;
  const file = input?.files?.[0];
  const listName = input?.dataset?.target || "";
  if (!file || !CSV_IMPORT_HEADERS[listName]) return;

  try {
    const text = await file.text();
    const rawRows = parseCsvObjects(text, listName);
    if (!rawRows.length) {
      alert("No encontré filas para importar en el CSV.");
      return;
    }

    const imported = [];
    let skipped = 0;
    rawRows.forEach((raw) => {
      const record = buildCsvRecord(listName, raw);
      if (record) imported.push(record);
      else skipped += 1;
    });

    if (!imported.length) {
      alert("No se pudo importar ninguna fila. Revisá los datos requeridos.");
      return;
    }

    const active = getActive();
    active[listName] = [...(active[listName] || []), ...imported];
    setActive(active);
    await persistActive(active);
    renderAll();

    alert(`Importados ${imported.length} registros. Se omitieron ${skipped}.`);
  } catch (err) {
    alert("No pude importar el CSV: " + (err.message || err));
  } finally {
    input.value = "";
    delete input.dataset.target;
  }
}

function exportCSV(listName){
  const t = state.active;
  const rows = (t[listName]||[]);
  let headers=[];
  if(listName==="ingresos") headers=["fecha","concepto","monto","medio","notas"];
  if(listName==="gastos") headers=["fecha","concepto","categoria","monto","notas"];
  if(listName==="cxc") headers=["vence","nombre","concepto","monto","estado","notas"];
  if(listName==="cxp") headers=["vence","proveedor","concepto","monto","estado","notas"];
  if(listName==="inventario") headers=["categoria","producto","stock","minimo","costo"];
  const csv = toCSV(rows, headers);
  download(`xtreme-${t.name}-${listName}.csv`, new Blob([csv],{type:"text/csv"}));
}

async function exportAllZip(){
  // Build a zip in-browser using CompressionStream if available; fallback to multiple downloads.
  const t = state.active;
  const files = [
    {name:`ingresos.csv`, data: toCSV(t.ingresos||[], ["fecha","concepto","monto","medio","notas"])},
    {name:`egresos.csv`, data: toCSV(t.gastos||[], ["fecha","concepto","categoria","monto","notas"])},
    {name:`cxc.csv`, data: toCSV(t.cxc||[], ["vence","nombre","concepto","monto","estado","notas"])},
    {name:`cxp.csv`, data: toCSV(t.cxp||[], ["vence","proveedor","concepto","monto","estado","notas"])},
    {name:`inventario.csv`, data: toCSV(t.inventario||[], ["categoria","producto","stock","minimo","costo"])},
  ];
  // Minimal ZIP (store) builder
  const enc = new TextEncoder();
  const chunks=[];
  let offset=0;
  const central=[];
  function u16(n){ return new Uint8Array([n&255,(n>>8)&255]); }
  function u32(n){ return new Uint8Array([n&255,(n>>8)&255,(n>>16)&255,(n>>24)&255]); }
  function crc32(buf){
    let c=~0; for(let i=0;i<buf.length;i++){ c=(c>>>8) ^ table[(c ^ buf[i]) & 0xff]; } return ~c>>>0;
  }
  // CRC table
  const table = (()=>{ let t=new Uint32Array(256); for(let i=0;i<256;i++){ let c=i; for(let k=0;k<8;k++) c = (c&1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1); t[i]=c>>>0; } return t; })();

  for(const f of files){
    const data = enc.encode(f.data);
    const crc = crc32(data);
    const nameBytes = enc.encode(f.name);

    // Local file header
    const lf = [];
    lf.push(u32(0x04034b50)); // signature
    lf.push(u16(20)); // version
    lf.push(u16(0)); // flags
    lf.push(u16(0)); // method store
    lf.push(u16(0)); // time
    lf.push(u16(0)); // date
    lf.push(u32(crc));
    lf.push(u32(data.length));
    lf.push(u32(data.length));
    lf.push(u16(nameBytes.length));
    lf.push(u16(0)); // extra
    const header = concat(lf);
    chunks.push(header, nameBytes, data);

    // Central directory header
    const cd=[];
    cd.push(u32(0x02014b50));
    cd.push(u16(20)); // made by
    cd.push(u16(20)); // version needed
    cd.push(u16(0));  // flags
    cd.push(u16(0));  // method
    cd.push(u16(0)); cd.push(u16(0)); // time/date
    cd.push(u32(crc));
    cd.push(u32(data.length));
    cd.push(u32(data.length));
    cd.push(u16(nameBytes.length));
    cd.push(u16(0)); // extra
    cd.push(u16(0)); // comment
    cd.push(u16(0)); // disk
    cd.push(u16(0)); // int attr
    cd.push(u32(0)); // ext attr
    cd.push(u32(offset));
    const cdrec = concat(cd);
    central.push(cdrec, nameBytes);

    offset += header.length + nameBytes.length + data.length;
  }

  const centralStart = offset;
  const centralBlob = concat(central);
  offset += centralBlob.length;

  const eocd = concat([
    u32(0x06054b50),
    u16(0),u16(0),
    u16(files.length),u16(files.length),
    u32(centralBlob.length),
    u32(centralStart),
    u16(0)
  ]);

  const zipBlob = new Blob([...chunks, centralBlob, eocd], {type:"application/zip"});
  download(`xtreme-${t.name}-csv.zip`, zipBlob);

  function concat(arr){
    // arr: (Uint8Array)[]
    const total = arr.reduce((a,b)=>a+b.length,0);
    const out = new Uint8Array(total);
    let p=0;
    for(const a of arr){ out.set(a,p); p+=a.length; }
    return out;
  }
}

/* ---------- Start ---------- */
init();

/* ========= ALUMNOS ========= */

function calcAge(birthISO){
  if(!birthISO) return "";
  const b = new Date(birthISO + "T00:00:00");
  const t = new Date();
  let age = t.getFullYear() - b.getFullYear();
  const m = t.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < b.getDate())) age--;
  return age < 0 ? "" : age;
}

function isEditing(section, id) {
  return editMode.section === section && editMode.id === id;
}

function startEdit(section, id) {
  editMode = { section, id };
  render();
}

function cancelEdit() {
  editMode = { section: null, id: null };
  render();
}

function setupInlineEditHotkeys() {
  const saveHandlers = {
    ingresos: saveIngreso,
    gastos: saveGasto,
    cxc: saveCxc,
    cxp: saveCxp,
    inventario: saveInventario,
    alumnos: saveAlumno
  };

  document.addEventListener("keydown", (event) => {
    if (!editMode.section || !editMode.id) return;
    if (!event.target || typeof event.target.closest !== "function") return;

    const editingRow = event.target.closest(".editing-row");
    if (!editingRow) return;

    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
      return;
    }

    if (event.key === "Enter") {
      const tag = String(event.target.tagName || "").toLowerCase();
      if (tag === "textarea" && !(event.ctrlKey || event.metaKey)) return;

      const handler = saveHandlers[editMode.section];
      if (typeof handler === "function") {
        event.preventDefault();
        handler(editMode.id);
      }
    }
  });
}

// Tu botón actual llama editAlumno(id)
// Para no romper HTML con comillas, etc.
function escAttr(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

let studentModalState = {
  supported: false,
  dialog: null,
  overlay: null,
  container: null,
  titleEl: null,
  bodyEl: null,
  closeBtn: null,
  handleEscape: null
};

let studentPaymentsModalState = {
  supported: false,
  dialog: null,
  overlay: null,
  container: null,
  titleEl: null,
  bodyEl: null,
  totalPaidEl: null,
  totalDueEl: null,
  closeBtn: null,
  handleEscape: null
};

let addAlumnoModalState = {
  supported: false,
  dialog: null,
  overlay: null,
  container: null,
  titleEl: null,
  closeBtn: null,
  handleEscape: null
};

let addCxcModalState = {
  supported: false,
  dialog: null,
  overlay: null,
  container: null,
  titleEl: null,
  closeBtn: null,
  handleEscape: null
};

let addCxpModalState = {
  supported: false,
  dialog: null,
  overlay: null,
  container: null,
  titleEl: null,
  closeBtn: null,
  handleEscape: null
};

let addIngresoModalState = {
  supported: false,
  dialog: null,
  overlay: null,
  container: null,
  titleEl: null,
  closeBtn: null,
  handleEscape: null
};

let addGastoModalState = {
  supported: false,
  dialog: null,
  overlay: null,
  container: null,
  titleEl: null,
  closeBtn: null,
  handleEscape: null
};

let addInventarioModalState = {
  supported: false,
  dialog: null,
  overlay: null,
  container: null,
  titleEl: null,
  closeBtn: null,
  handleEscape: null
};

function initStudentModal() {
  const dialog = document.getElementById("studentModal");
  if (!dialog) return;

  const supportsDialog = typeof HTMLDialogElement === "function" && typeof dialog.showModal === "function";
  let container = dialog;
  let overlay = null;

  if (!supportsDialog) {
    overlay = document.createElement("div");
    overlay.className = "student-modal-overlay";
    overlay.hidden = true;

    const fallback = document.createElement("div");
    fallback.className = "student-modal student-modal--fallback";
    fallback.setAttribute("role", "dialog");
    fallback.setAttribute("aria-modal", "true");

    while (dialog.firstChild) {
      fallback.appendChild(dialog.firstChild);
    }

    overlay.appendChild(fallback);
    dialog.replaceWith(overlay);

    container = fallback;
  }

  const titleEl = container.querySelector("[data-student-title]");
  const bodyEl = container.querySelector("[data-student-body]");
  const closeBtn = container.querySelector("[data-student-close]");
  const paymentsBtn = container.querySelector("[data-student-payments]");

  studentModalState = {
    supported: supportsDialog,
    dialog,
    overlay,
    container,
    titleEl,
    bodyEl,
    closeBtn,
    handleEscape: null
  };

  const handleEscape = (event) => {
    if (event.key === "Escape") closeStudentModal();
  };

  studentModalState.handleEscape = handleEscape;

  closeBtn?.addEventListener("click", closeStudentModal);
  paymentsBtn?.addEventListener("click", () => {
    if (!state.selectedAlumno) return;
    openStudentPaymentsModal(state.selectedAlumno);
  });

  if (supportsDialog) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeStudentModal();
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeStudentModal();
    });
  } else if (overlay) {
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeStudentModal();
    });
  }
}

function initAddAlumnoModal() {
  const dialog = document.getElementById("addAlumnoModal");
  if (!dialog) return;

  const supportsDialog = typeof HTMLDialogElement === "function" && typeof dialog.showModal === "function";
  let container = dialog;
  let overlay = null;

  if (!supportsDialog) {
    overlay = document.createElement("div");
    overlay.className = "student-modal-overlay";
    overlay.hidden = true;

    const fallback = document.createElement("div");
    fallback.className = "student-modal student-modal--fallback";
    fallback.setAttribute("role", "dialog");
    fallback.setAttribute("aria-modal", "true");

    while (dialog.firstChild) {
      fallback.appendChild(dialog.firstChild);
    }

    overlay.appendChild(fallback);
    dialog.replaceWith(overlay);
    container = fallback;
  }

  const titleEl = container.querySelector("[data-add-alumno-title]");
  const closeBtn = container.querySelector("[data-add-alumno-close]");

  addAlumnoModalState = {
    supported: supportsDialog,
    dialog,
    overlay,
    container,
    titleEl,
    closeBtn,
    handleEscape: null
  };

  const handleEscape = (event) => {
    if (event.key === "Escape") closeAddAlumnoModal();
  };

  addAlumnoModalState.handleEscape = handleEscape;

  closeBtn?.addEventListener("click", closeAddAlumnoModal);

  if (supportsDialog) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeAddAlumnoModal();
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeAddAlumnoModal();
    });
  } else if (overlay) {
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeAddAlumnoModal();
    });
  }
}

function setAddAlumnoModalTitle(title) {
  if (!addAlumnoModalState?.titleEl) return;
  addAlumnoModalState.titleEl.textContent = title || "Agregar alumno";
}

function openAddAlumnoModal({ title } = {}) {
  if (!addAlumnoModalState?.container) return;

  setAddAlumnoModalTitle(title);

  if (addAlumnoModalState.supported) {
    if (!addAlumnoModalState.dialog.open) addAlumnoModalState.dialog.showModal();
    return;
  }

  if (addAlumnoModalState.overlay) {
    addAlumnoModalState.overlay.hidden = false;
    document.body.classList.add("modal-open");
    document.addEventListener("keydown", addAlumnoModalState.handleEscape);
  }
}

function closeAddAlumnoModal() {
  if (!addAlumnoModalState?.container) return;

  if (addAlumnoModalState.supported && addAlumnoModalState.dialog?.open) {
    addAlumnoModalState.dialog.close();
  } else if (addAlumnoModalState.overlay) {
    addAlumnoModalState.overlay.hidden = true;
    document.body.classList.remove("modal-open");
    document.removeEventListener("keydown", addAlumnoModalState.handleEscape);
  }
}

function initAddIngresoModal() {
  const dialog = document.getElementById("addIngresoModal");
  if (!dialog) return;

  const supportsDialog = typeof HTMLDialogElement === "function" && typeof dialog.showModal === "function";
  let container = dialog;
  let overlay = null;

  if (!supportsDialog) {
    overlay = document.createElement("div");
    overlay.className = "student-modal-overlay";
    overlay.hidden = true;

    const fallback = document.createElement("div");
    fallback.className = "student-modal student-modal--fallback";
    fallback.setAttribute("role", "dialog");
    fallback.setAttribute("aria-modal", "true");

    while (dialog.firstChild) {
      fallback.appendChild(dialog.firstChild);
    }

    overlay.appendChild(fallback);
    dialog.replaceWith(overlay);
    container = fallback;
  }

  const titleEl = container.querySelector("[data-add-ingreso-title]");
  const closeBtn = container.querySelector("[data-add-ingreso-close]");

  addIngresoModalState = {
    supported: supportsDialog,
    dialog,
    overlay,
    container,
    titleEl,
    closeBtn,
    handleEscape: null
  };

  const handleEscape = (event) => {
    if (event.key === "Escape") closeAddIngresoModal();
  };

  addIngresoModalState.handleEscape = handleEscape;

  closeBtn?.addEventListener("click", closeAddIngresoModal);

  if (supportsDialog) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeAddIngresoModal();
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeAddIngresoModal();
    });
  } else if (overlay) {
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeAddIngresoModal();
    });
  }
}

function setAddIngresoModalTitle(title) {
  if (!addIngresoModalState?.titleEl) return;
  addIngresoModalState.titleEl.textContent = title || "Agregar ingreso";
}

function openAddIngresoModal({ title } = {}) {
  if (!addIngresoModalState?.container) return;

  setAddIngresoModalTitle(title);

  if (addIngresoModalState.supported) {
    if (!addIngresoModalState.dialog.open) addIngresoModalState.dialog.showModal();
    return;
  }

  if (addIngresoModalState.overlay) {
    addIngresoModalState.overlay.hidden = false;
    document.body.classList.add("modal-open");
    document.addEventListener("keydown", addIngresoModalState.handleEscape);
  }
}

function closeAddIngresoModal() {
  if (!addIngresoModalState?.container) return;

  if (addIngresoModalState.supported && addIngresoModalState.dialog?.open) {
    addIngresoModalState.dialog.close();
  } else if (addIngresoModalState.overlay) {
    addIngresoModalState.overlay.hidden = true;
    document.body.classList.remove("modal-open");
    document.removeEventListener("keydown", addIngresoModalState.handleEscape);
  }
}

function initAddGastoModal() {
  const dialog = document.getElementById("addGastoModal");
  if (!dialog) return;

  const supportsDialog = typeof HTMLDialogElement === "function" && typeof dialog.showModal === "function";
  let container = dialog;
  let overlay = null;

  if (!supportsDialog) {
    overlay = document.createElement("div");
    overlay.className = "student-modal-overlay";
    overlay.hidden = true;

    const fallback = document.createElement("div");
    fallback.className = "student-modal student-modal--fallback";
    fallback.setAttribute("role", "dialog");
    fallback.setAttribute("aria-modal", "true");

    while (dialog.firstChild) {
      fallback.appendChild(dialog.firstChild);
    }

    overlay.appendChild(fallback);
    dialog.replaceWith(overlay);
    container = fallback;
  }

  const titleEl = container.querySelector("[data-add-gasto-title]");
  const closeBtn = container.querySelector("[data-add-gasto-close]");

  addGastoModalState = {
    supported: supportsDialog,
    dialog,
    overlay,
    container,
    titleEl,
    closeBtn,
    handleEscape: null
  };

  const handleEscape = (event) => {
    if (event.key === "Escape") closeAddGastoModal();
  };

  addGastoModalState.handleEscape = handleEscape;

  closeBtn?.addEventListener("click", closeAddGastoModal);

  if (supportsDialog) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeAddGastoModal();
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeAddGastoModal();
    });
  } else if (overlay) {
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeAddGastoModal();
    });
  }
}

function setAddGastoModalTitle(title) {
  if (!addGastoModalState?.titleEl) return;
  addGastoModalState.titleEl.textContent = title || "Agregar egreso";
}

function openAddGastoModal({ title } = {}) {
  if (!addGastoModalState?.container) return;

  setAddGastoModalTitle(title);

  if (addGastoModalState.supported) {
    if (!addGastoModalState.dialog.open) addGastoModalState.dialog.showModal();
    return;
  }

  if (addGastoModalState.overlay) {
    addGastoModalState.overlay.hidden = false;
    document.body.classList.add("modal-open");
    document.addEventListener("keydown", addGastoModalState.handleEscape);
  }
}

function closeAddGastoModal() {
  if (!addGastoModalState?.container) return;

  if (addGastoModalState.supported && addGastoModalState.dialog?.open) {
    addGastoModalState.dialog.close();
  } else if (addGastoModalState.overlay) {
    addGastoModalState.overlay.hidden = true;
    document.body.classList.remove("modal-open");
    document.removeEventListener("keydown", addGastoModalState.handleEscape);
  }
}

function initAddInventarioModal() {
  const dialog = document.getElementById("addInventarioModal");
  if (!dialog) return;

  const supportsDialog = typeof HTMLDialogElement === "function" && typeof dialog.showModal === "function";
  let container = dialog;
  let overlay = null;

  if (!supportsDialog) {
    overlay = document.createElement("div");
    overlay.className = "student-modal-overlay";
    overlay.hidden = true;

    const fallback = document.createElement("div");
    fallback.className = "student-modal student-modal--fallback";
    fallback.setAttribute("role", "dialog");
    fallback.setAttribute("aria-modal", "true");

    while (dialog.firstChild) {
      fallback.appendChild(dialog.firstChild);
    }

    overlay.appendChild(fallback);
    dialog.replaceWith(overlay);
    container = fallback;
  }

  const titleEl = container.querySelector("[data-add-inventario-title]");
  const closeBtn = container.querySelector("[data-add-inventario-close]");

  addInventarioModalState = {
    supported: supportsDialog,
    dialog,
    overlay,
    container,
    titleEl,
    closeBtn,
    handleEscape: null
  };

  const handleEscape = (event) => {
    if (event.key === "Escape") closeAddInventarioModal();
  };

  addInventarioModalState.handleEscape = handleEscape;

  closeBtn?.addEventListener("click", closeAddInventarioModal);

  if (supportsDialog) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeAddInventarioModal();
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeAddInventarioModal();
    });
  } else if (overlay) {
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeAddInventarioModal();
    });
  }
}

function setAddInventarioModalTitle(title) {
  if (!addInventarioModalState?.titleEl) return;
  addInventarioModalState.titleEl.textContent = title || "Agregar producto";
}

function openAddInventarioModal({ title } = {}) {
  if (!addInventarioModalState?.container) return;

  setAddInventarioModalTitle(title);

  if (addInventarioModalState.supported) {
    if (!addInventarioModalState.dialog.open) addInventarioModalState.dialog.showModal();
    return;
  }

  if (addInventarioModalState.overlay) {
    addInventarioModalState.overlay.hidden = false;
    document.body.classList.add("modal-open");
    document.addEventListener("keydown", addInventarioModalState.handleEscape);
  }
}

function closeAddInventarioModal() {
  if (!addInventarioModalState?.container) return;

  if (addInventarioModalState.supported && addInventarioModalState.dialog?.open) {
    addInventarioModalState.dialog.close();
  } else if (addInventarioModalState.overlay) {
    addInventarioModalState.overlay.hidden = true;
    document.body.classList.remove("modal-open");
    document.removeEventListener("keydown", addInventarioModalState.handleEscape);
  }
}

function initAddCxcModal() {
  const dialog = document.getElementById("addCxcModal");
  if (!dialog) return;

  const supportsDialog = typeof HTMLDialogElement === "function" && typeof dialog.showModal === "function";
  let container = dialog;
  let overlay = null;

  if (!supportsDialog) {
    overlay = document.createElement("div");
    overlay.className = "student-modal-overlay";
    overlay.hidden = true;

    const fallback = document.createElement("div");
    fallback.className = "student-modal student-modal--fallback";
    fallback.setAttribute("role", "dialog");
    fallback.setAttribute("aria-modal", "true");

    while (dialog.firstChild) {
      fallback.appendChild(dialog.firstChild);
    }

    overlay.appendChild(fallback);
    dialog.replaceWith(overlay);
    container = fallback;
  }

  const titleEl = container.querySelector("[data-add-cxc-title]");
  const closeBtn = container.querySelector("[data-add-cxc-close]");

  addCxcModalState = {
    supported: supportsDialog,
    dialog,
    overlay,
    container,
    titleEl,
    closeBtn,
    handleEscape: null
  };

  const handleEscape = (event) => {
    if (event.key === "Escape") closeAddCxcModal();
  };

  addCxcModalState.handleEscape = handleEscape;

  closeBtn?.addEventListener("click", closeAddCxcModal);

  if (supportsDialog) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeAddCxcModal();
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeAddCxcModal();
    });
  } else if (overlay) {
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeAddCxcModal();
    });
  }
}

function setAddCxcModalTitle(title) {
  if (!addCxcModalState?.titleEl) return;
  addCxcModalState.titleEl.textContent = title || "Agregar cuenta por cobrar";
}

function openAddCxcModal({ title } = {}) {
  if (!addCxcModalState?.container) return;

  setAddCxcModalTitle(title);

  if (addCxcModalState.supported) {
    if (!addCxcModalState.dialog.open) addCxcModalState.dialog.showModal();
    return;
  }

  if (addCxcModalState.overlay) {
    addCxcModalState.overlay.hidden = false;
    document.body.classList.add("modal-open");
    document.addEventListener("keydown", addCxcModalState.handleEscape);
  }
}

function closeAddCxcModal() {
  if (!addCxcModalState?.container) return;

  if (addCxcModalState.supported && addCxcModalState.dialog?.open) {
    addCxcModalState.dialog.close();
  } else if (addCxcModalState.overlay) {
    addCxcModalState.overlay.hidden = true;
    document.body.classList.remove("modal-open");
    document.removeEventListener("keydown", addCxcModalState.handleEscape);
  }
}

function initAddCxpModal() {
  const dialog = document.getElementById("addCxpModal");
  if (!dialog) return;

  const supportsDialog = typeof HTMLDialogElement === "function" && typeof dialog.showModal === "function";
  let container = dialog;
  let overlay = null;

  if (!supportsDialog) {
    overlay = document.createElement("div");
    overlay.className = "student-modal-overlay";
    overlay.hidden = true;

    const fallback = document.createElement("div");
    fallback.className = "student-modal student-modal--fallback";
    fallback.setAttribute("role", "dialog");
    fallback.setAttribute("aria-modal", "true");

    while (dialog.firstChild) {
      fallback.appendChild(dialog.firstChild);
    }

    overlay.appendChild(fallback);
    dialog.replaceWith(overlay);
    container = fallback;
  }

  const titleEl = container.querySelector("[data-add-cxp-title]");
  const closeBtn = container.querySelector("[data-add-cxp-close]");

  addCxpModalState = {
    supported: supportsDialog,
    dialog,
    overlay,
    container,
    titleEl,
    closeBtn,
    handleEscape: null
  };

  const handleEscape = (event) => {
    if (event.key === "Escape") closeAddCxpModal();
  };

  addCxpModalState.handleEscape = handleEscape;

  closeBtn?.addEventListener("click", closeAddCxpModal);

  if (supportsDialog) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeAddCxpModal();
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeAddCxpModal();
    });
  } else if (overlay) {
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeAddCxpModal();
    });
  }
}

function setAddCxpModalTitle(title) {
  if (!addCxpModalState?.titleEl) return;
  addCxpModalState.titleEl.textContent = title || "Agregar cuenta por pagar";
}

function openAddCxpModal({ title } = {}) {
  if (!addCxpModalState?.container) return;

  setAddCxpModalTitle(title);

  if (addCxpModalState.supported) {
    if (!addCxpModalState.dialog.open) addCxpModalState.dialog.showModal();
    return;
  }

  if (addCxpModalState.overlay) {
    addCxpModalState.overlay.hidden = false;
    document.body.classList.add("modal-open");
    document.addEventListener("keydown", addCxpModalState.handleEscape);
  }
}

function closeAddCxpModal() {
  if (!addCxpModalState?.container) return;

  if (addCxpModalState.supported && addCxpModalState.dialog?.open) {
    addCxpModalState.dialog.close();
  } else if (addCxpModalState.overlay) {
    addCxpModalState.overlay.hidden = true;
    document.body.classList.remove("modal-open");
    document.removeEventListener("keydown", addCxpModalState.handleEscape);
  }
}

function formatDateDMY(value) {
  if (value === null || value === undefined || value === "") return value;
  const asString = String(value);
  const match = asString.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function getRecordAlumnoName(record) {
  return String(record?.alumnoNombre || record?.nombre || record?.cliente || record?.alumno || "").trim();
}

function getRecordAlumnoId(record) {
  return String(record?.alumnoId || record?.clienteId || record?.refAlumnoId || "").trim();
}

function findAlumnoIdByName(name, alumnos) {
  const target = normalizeName(name);
  if (!target) return "";
  const match = (alumnos || []).find((alumno) => normalizeName(alumno?.nombre) === target);
  return match?.id || "";
}

function recordMatchesAlumno(record, alumno) {
  const alumnoId = String(alumno?.id || "").trim();
  const recordId = getRecordAlumnoId(record);
  if (alumnoId && recordId && alumnoId === recordId) return true;
  const alumnoName = normalizeName(alumno?.nombre);
  const recordName = normalizeName(getRecordAlumnoName(record));
  return Boolean(alumnoName && recordName && alumnoName === recordName);
}

function isRecordInTemplate(record, templateId) {
  const recordTemplateId = String(record?.templateId || "").trim();
  if (!recordTemplateId) return true;
  return recordTemplateId === String(templateId);
}

function isIngresoFromCxc(ingreso) {
  return String(ingreso?.source || "").toLowerCase() === "cxc"
    || Boolean(ingreso?.sourceId)
    || ingreso?.origen === "CXC"
    || Boolean(ingreso?.refId);
}

function formatStudentValue(key, value, alumno) {
  if (key === "edad") {
    const age = calcAge(alumno?.nacimiento);
    return age === "" ? "—" : age;
  }
  if (key === "nacimiento" || key === "ingreso") {
    if (value === null || value === undefined || value === "") return "—";
    return formatDateDMY(value);
  }
  if (key === "cuota") {
    if (value === null || value === undefined || value === "") return "—";
    return money(value);
  }
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function labelizeKey(key) {
  return String(key || "")
    .replaceAll("_", " ")
    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function renderStudentModal(alumno) {
  if (!studentModalState?.bodyEl || !studentModalState?.titleEl) return;

  const fullName = String(alumno?.nombre || "").trim();
  studentModalState.titleEl.textContent = fullName
    ? `Ficha del alumno: ${fullName}`
    : "Ficha del alumno";

  const fields = [
    { key: "nombre", label: "Nombre completo", value: alumno?.nombre },
    { key: "nacimiento", label: "Fecha de nacimiento", value: alumno?.nacimiento },
    { key: "edad", label: "Edad", value: alumno?.nacimiento },
    { key: "telefono", label: "Teléfono", value: alumno?.telefono ?? alumno?.numero },
    { key: "direccion", label: "Dirección", value: alumno?.direccion },
    { key: "email", label: "Email", value: alumno?.email },
    { key: "ingreso", label: "Fecha de ingreso", value: alumno?.ingreso },
    { key: "rango", label: "Rango", value: alumno?.rango },
    { key: "ata", label: "Número ATA", value: alumno?.ata },
    { key: "programa", label: "Programa", value: alumno?.programa },
    { key: "cuota", label: "Cuota", value: alumno?.cuota },
    { key: "estado", label: "Estado", value: alumno?.estado },
    { key: "notas", label: "Notas", value: alumno?.notas }
  ];

  const knownKeys = new Set([...fields.map((field) => field.key), "numero", "tutor", "id"]);
  const extraKeys = Object.keys(alumno || {})
    .filter((key) => !knownKeys.has(key))
    .sort((a, b) => a.localeCompare(b));

  extraKeys.forEach((key) => {
    fields.push({
      key,
      label: labelizeKey(key),
      value: alumno?.[key]
    });
  });

  studentModalState.bodyEl.innerHTML = "";
  fields.forEach((field) => {
    const dt = document.createElement("dt");
    dt.textContent = field.label;

    const dd = document.createElement("dd");
    dd.textContent = formatStudentValue(field.key, field.value, alumno);

    studentModalState.bodyEl.appendChild(dt);
    studentModalState.bodyEl.appendChild(dd);
  });
}

function openStudentModal(id) {
  const alumno = (getActive().alumnos || []).find((item) => item.id === id);
  if (!alumno || !studentModalState?.container) return;

  state.selectedAlumno = alumno;
  renderStudentModal(alumno);

  if (studentModalState.supported) {
    if (!studentModalState.dialog.open) studentModalState.dialog.showModal();
    return;
  }

  if (studentModalState.overlay) {
    studentModalState.overlay.hidden = false;
    document.body.classList.add("modal-open");
    document.addEventListener("keydown", studentModalState.handleEscape);
  }
}

function closeStudentModal() {
  if (!studentModalState?.container) return;

  if (studentModalState.supported && studentModalState.dialog?.open) {
    studentModalState.dialog.close();
  } else if (studentModalState.overlay) {
    studentModalState.overlay.hidden = true;
    document.body.classList.remove("modal-open");
    document.removeEventListener("keydown", studentModalState.handleEscape);
  }

  state.selectedAlumno = null;
}

function initStudentPaymentsModal() {
  const dialog = document.getElementById("studentPaymentsModal");
  if (!dialog) return;

  const supportsDialog = typeof HTMLDialogElement === "function" && typeof dialog.showModal === "function";
  let container = dialog;
  let overlay = null;

  if (!supportsDialog) {
    overlay = document.createElement("div");
    overlay.className = "student-modal-overlay";
    overlay.hidden = true;

    const fallback = document.createElement("div");
    fallback.className = "student-modal student-modal--wide student-modal--fallback";
    fallback.setAttribute("role", "dialog");
    fallback.setAttribute("aria-modal", "true");

    while (dialog.firstChild) {
      fallback.appendChild(dialog.firstChild);
    }

    overlay.appendChild(fallback);
    dialog.replaceWith(overlay);
    container = fallback;
  }

  const titleEl = container.querySelector("[data-student-payments-title]");
  const bodyEl = container.querySelector("[data-student-payments-body]");
  const totalPaidEl = container.querySelector("[data-student-payments-total-paid]");
  const totalDueEl = container.querySelector("[data-student-payments-total-due]");
  const closeBtn = container.querySelector("[data-student-payments-close]");

  studentPaymentsModalState = {
    supported: supportsDialog,
    dialog,
    overlay,
    container,
    titleEl,
    bodyEl,
    totalPaidEl,
    totalDueEl,
    closeBtn,
    handleEscape: null
  };

  const handleEscape = (event) => {
    if (event.key === "Escape") closeStudentPaymentsModal();
  };

  studentPaymentsModalState.handleEscape = handleEscape;

  closeBtn?.addEventListener("click", closeStudentPaymentsModal);

  if (supportsDialog) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeStudentPaymentsModal();
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeStudentPaymentsModal();
    });
  } else if (overlay) {
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeStudentPaymentsModal();
    });
  }
}

function renderStudentPaymentsModal(alumno) {
  if (!studentPaymentsModalState?.bodyEl || !studentPaymentsModalState?.titleEl) return;

  const templateId = state.activeTemplateId || getActiveId();
  const templateName = getActiveTemplateName() || "Plantilla activa";
  const alumnoName = alumno?.nombre || "";

  studentPaymentsModalState.titleEl.textContent = `Pagos del mes — ${templateName}`;

  const active = state.active ?? getActive();
  const cxc = (active?.cxc || [])
    .filter((item) => isRecordInTemplate(item, templateId))
    .filter((item) => recordMatchesAlumno(item, alumno));

  const ingresos = (active?.ingresos || [])
    .filter((item) => isRecordInTemplate(item, templateId))
    .filter((item) => recordMatchesAlumno(item, alumno))
    .filter((item) => !isIngresoFromCxc(item));

  const entries = [];

  cxc.forEach((item) => {
    entries.push({
      id: item.id,
      tipo: "Cuota",
      concepto: item.concepto || "Cuota",
      monto: Number(item.monto || 0),
      estado: item.estado || "Pendiente",
      fecha: item.pagadoEn || "",
      sortDate: item.pagadoEn || item.vence || ""
    });
  });

  ingresos.forEach((item) => {
    entries.push({
      id: item.id,
      tipo: item.tipo || item.categoria || "Otro",
      concepto: item.concepto || "",
      monto: Number(item.monto || 0),
      estado: item.estado || "Pagado",
      fecha: item.fecha || "",
      sortDate: item.fecha || ""
    });
  });

  const sortByDateDesc = (a, b) => String(b.sortDate || "").localeCompare(String(a.sortDate || ""));

  entries.sort(sortByDateDesc);

  const totals = entries.reduce(
    (acc, entry) => {
      const status = String(entry.estado || "").toLowerCase();
      if (status === "pendiente") acc.pendiente += entry.monto;
      else acc.pagado += entry.monto;
      return acc;
    },
    { pagado: 0, pendiente: 0 }
  );

  if (studentPaymentsModalState.totalPaidEl) {
    studentPaymentsModalState.totalPaidEl.textContent = money(totals.pagado);
  }
  if (studentPaymentsModalState.totalDueEl) {
    studentPaymentsModalState.totalDueEl.textContent = money(totals.pendiente);
  }

  if (!entries.length) {
    studentPaymentsModalState.bodyEl.innerHTML = `
      <tr>
        <td colspan="5" class="note-cell">No hay movimientos para ${escAttr(alumnoName || "este alumno")} en esta plantilla.</td>
      </tr>
    `;
    return;
  }

  const pendingEntries = entries.filter((entry) => String(entry.estado || "").toLowerCase() === "pendiente");
  const paidEntries = entries.filter((entry) => String(entry.estado || "").toLowerCase() !== "pendiente");

  pendingEntries.sort(sortByDateDesc);
  paidEntries.sort(sortByDateDesc);

  const renderEntry = (entry) => {
    const status = String(entry.estado || "");
    const isPaid = status.toLowerCase() === "pagado";
    const statusBadge = status
      ? `<span class="badge ${isPaid ? "ok" : "due"}">${escAttr(status)}</span>`
      : "—";
    const fechaLabel = entry.fecha ? formatDateDMY(entry.fecha) : "—";
    return `
      <tr>
        <td>${escAttr(entry.tipo)}</td>
        <td>${escAttr(entry.concepto || "—")}</td>
        <td class="amount">${money(entry.monto || 0)}</td>
        <td class="status">${statusBadge}</td>
        <td class="date">${escAttr(fechaLabel)}</td>
      </tr>
    `;
  };

  const renderSection = (label, sectionEntries, emptyLabel) => {
    const rows = sectionEntries.length
      ? sectionEntries.map(renderEntry).join("")
      : `
        <tr class="student-payments-section-empty">
          <td colspan="5">${escAttr(emptyLabel)}</td>
        </tr>
      `;

    return `
      <tr class="student-payments-section">
        <td colspan="5">${escAttr(label)}</td>
      </tr>
      ${rows}
    `;
  };

  studentPaymentsModalState.bodyEl.innerHTML = `
    ${renderSection("Pendientes", pendingEntries, "No hay pagos pendientes en este mes.")}
    ${renderSection("Pagos", paidEntries, "No hay pagos registrados en este mes.")}
  `;
}

function openStudentPaymentsModal(alumno) {
  if (!studentPaymentsModalState?.container) return;
  if (!alumno) return;

  renderStudentPaymentsModal(alumno);

  if (studentPaymentsModalState.supported) {
    if (!studentPaymentsModalState.dialog.open) studentPaymentsModalState.dialog.showModal();
    return;
  }

  if (studentPaymentsModalState.overlay) {
    studentPaymentsModalState.overlay.hidden = false;
    document.body.classList.add("modal-open");
    document.addEventListener("keydown", studentPaymentsModalState.handleEscape);
  }
}

function closeStudentPaymentsModal() {
  if (!studentPaymentsModalState?.container) return;

  if (studentPaymentsModalState.supported && studentPaymentsModalState.dialog?.open) {
    studentPaymentsModalState.dialog.close();
  } else if (studentPaymentsModalState.overlay) {
    studentPaymentsModalState.overlay.hidden = true;
    document.body.classList.remove("modal-open");
    document.removeEventListener("keydown", studentPaymentsModalState.handleEscape);
  }
}

function saveAlumno(id) {
  const nombre     = document.getElementById(`ed_nombre_${id}`)?.value.trim() || "";
  const nacimiento = document.getElementById(`ed_nacimiento_${id}`)?.value || "";
  const numero     = document.getElementById(`ed_numero_${id}`)?.value.trim() || "";
  const ingreso    = document.getElementById(`ed_ingreso_${id}`)?.value || "";
  const programa   = document.getElementById(`ed_programa_${id}`)?.value.trim() || "";
  const cuotaStr   = document.getElementById(`ed_cuota_${id}`)?.value || "0";
  const ata         = document.getElementById(`ed_at_${id}`)?.value.trim() || "";
  const rango       = document.getElementById(`ed_rango_${id}`)?.value.trim() || "";
  const estado      = document.getElementById(`ed_estado_${id}`)?.value || "Activo";

  const cuota = requireMontoValue(cuotaStr, "la cuota del alumno");
  if (cuota === null) return;
  if (!nombre) return alert("El nombre no puede quedar vacío.");

  const active = getActive();
  const arr = active.alumnos || [];

  active.alumnos = arr.map(a => {
    if (a.id !== id) return a;
    return { ...a, nombre, nacimiento, numero, ingreso, programa, cuota, ata, rango, estado };
  });

  const updatedAlumno = active.alumnos.find(a => a.id === id);
  if (updatedAlumno) addCuotaPendiente(active, updatedAlumno);

  // ⚠️ IMPORTANTE:
  
  setActive(active);

  editMode = { section: null, id: null };
  render();
  showSoftBanner("✅ Alumno guardado");
}

// Si usás onclick="..." en HTML, esto asegura que existan
window.editAlumno = editAlumno;
window.saveAlumno = saveAlumno;
window.cancelEdit = cancelEdit;


function renderAlumnos(){
  if(!$("alTbody")) return;


  const q = $("alSearch").value || "";
  const statusFilter = state.filters.alumnosStatus || "activos";
  updateAlumnoFilterButtons();
  const rows = (getActive().alumnos || [])
    .filter(a => {
      const estado = String(a.estado || "Activo").trim().toLowerCase();
      if (statusFilter === "activos") return estado === "activo";
      if (statusFilter === "inactivos") return estado === "inactivo";
      return true;
    })
    .filter(x => textMatch(x, q))
    .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || ""));

  $("alCount").textContent = rows.length;
  $("alTbody").innerHTML = "";

  rows.forEach(a=>{
    const tr = document.createElement("tr");
    const editing = (editMode.section === "alumnos" && editMode.id === a.id);

    const estado = a.estado || "Activo";
    const estadoClass = estado === "Activo" ? "badge ok" : "badge due";

    if (!editing) {
      tr.classList.add("student-row");
      tr.innerHTML = `
        <td>${escAttr(a.nombre)}</td>
        <td>${escAttr(calcAge(a.nacimiento))}</td>
        <td>${money(a.cuota||0)}</td>
        <td>${escAttr(a.ata||"")}</td>
        <td>${escAttr(a.rango||"")}</td>
        <td><span class="${estadoClass}">${escAttr(estado)}</span></td>
        <td class="actions-cell">
          <button class="ghost" type="button" onclick="editAlumno('${a.id}')">Editar</button>
          <button class="ghost danger" type="button" onclick="deleteAlumno('${a.id}')">Borrar</button>
        </td>`;
    } else {
      tr.innerHTML = `
        <td>
          <input id="ed_nombre_${a.id}" value="${escAttr(a.nombre)}" />
          <input id="ed_nacimiento_${a.id}" type="hidden" value="${escAttr(a.nacimiento||"")}" />
          <input id="ed_numero_${a.id}" type="hidden" value="${escAttr(a.numero||"")}" />
          <input id="ed_ingreso_${a.id}" type="hidden" value="${escAttr(a.ingreso||"")}" />
          <input id="ed_programa_${a.id}" type="hidden" value="${escAttr(a.programa||"")}" />
        </td>
        <td>${escAttr(calcAge(a.nacimiento))}</td>
        <td><input id="ed_cuota_${a.id}" type="number" min="0" step="1" value="${escAttr(a.cuota ?? 0)}" /></td>
        <td><input id="ed_at_${a.id}" value="${escAttr(a.ata||"")}" /></td>
        <td><input id="ed_rango_${a.id}" value="${escAttr(a.rango||"")}" /></td>
        <td>
          <select id="ed_estado_${a.id}">
            <option value="Activo"${estado === "Activo" ? " selected" : ""}>Activo</option>
            <option value="Inactivo"${estado === "Inactivo" ? " selected" : ""}>Inactivo</option>
          </select>
        </td>
        <td class="actions-cell">
          <button class="ghost" onclick="saveAlumno('${a.id}')">Guardar</button>
          <button class="ghost" onclick="cancelEdit()">Cancelar</button>
      </td>`;
    }

    $("alTbody").appendChild(tr);

    if (!editing) {
      tr.addEventListener("click", (event) => {
        if (event.target.closest("button, a, input, select, textarea, label")) return;
        openStudentModal(a.id);
      });
    }
  });
}

function addOrUpdateAlumno(){
  const active = getActive();
  const id = $("addAlumnoBtn").dataset.editId || generateAlumnoId();
  const cuota = requireMontoValue($("alCuota").value, "la cuota del alumno");
  if (cuota === null) return;

  const alumno = {
    id,
    nombre: $("alNombre").value.trim(),
    nacimiento: $("alNacimiento").value,
    numero: $("alNumero").value,
    ingreso: $("alIngreso").value || todayISO(),
    programa: $("alPrograma").value,
    rango: $("alRango").value,
    cuota,
    ata: $("alAta").value,
    estado: $("alEstado").value || "Activo",
    email: $("alEmail").value.trim(),
    direccion: $("alDireccion").value.trim(),
    notas: $("alNotas").value.trim()
  };

  if(!alumno.nombre){
    alert("El nombre es obligatorio");
    return;
  }

 const idx = active.alumnos.findIndex(a => a.id === id);
// ... donde ya guardás alumno ...
if (idx >= 0) active.alumnos[idx] = alumno;
else active.alumnos.push(alumno);

addCuotaPendiente(active, alumno);


log.info("CxC en memoria (active.cxc)", { cantidad: active.cxc?.length });

saveActiveData(active);

const fresh = getActive();
log.info("CxC leída desde getActive()", { cantidad: fresh.cxc ? fresh.cxc.length : 0 });

state.active = active;

const cxcSearch = $("cxcSearch");
if (cxcSearch) cxcSearch.value = "";

if (typeof rendercxc === "function") rendercxc();
if (typeof renderResumen === "function") renderResumen();

clearAlumnoForm();
renderAlumnos();
showSoftBanner("✅ Alumno guardado");
closeAddAlumnoModal();


}

function editAlumno(id){
  const a = getActive().alumnos.find(x=>x.id===id);
  if(!a) return;

  $("alNombre").value = a.nombre;
  $("alNacimiento").value = a.nacimiento;
  $("alEdad").value = calcAge(a.nacimiento);
  $("alNumero").value = a.numero;
  $("alIngreso").value = a.ingreso;
  $("alPrograma").value = a.programa;
  $("alRango").value = a.rango || "";
  $("alCuota").value = a.cuota;
  $("alAta").value = a.ata;
  $("alEstado").value = a.estado || "Activo";
  $("alEmail").value = a.email || "";
  $("alDireccion").value = a.direccion || "";
  $("alNotas").value = a.notas || "";

  $("addAlumnoBtn").dataset.editId = id;
  $("addAlumnoBtn").textContent = "Actualizar alumno";
  openAddAlumnoModal({ title: "Actualizar alumno" });
}

const deleteAlumnoImpl = (id) => {
  if(!confirm("¿Borrar alumno? Esto también elimina sus cuentas por cobrar.")) return;

  const active = getActive?.() || state?.active;
  if (!active) return;

  const alumnoId = String(id).trim();
  const alumno = (active.alumnos || []).find(a => String(a.id).trim() === alumnoId);

  const nombre = String(alumno?.nombre || "").trim().toLowerCase();
  const numero = String(alumno?.numero || "").trim();
  const ata    = String(alumno?.ata || "").trim();

  // 1) borrar alumno
  active.alumnos = (active.alumnos || []).filter(a => String(a.id).trim() !== alumnoId);

  // 2) borrar CxC asociadas (probamos varios campos comunes)
  const before = (active.cxc || []).length;

  active.cxc = (active.cxc || []).filter(c => {
    const cNombre = String(c.nombre || c.cliente || c.alumno || "").trim().toLowerCase();
    const cAlumnoId = String(c.alumnoId || c.clienteId || c.refAlumnoId || "").trim();
    const cNumero = String(c.numero || c.doc || "").trim();
    const cAta    = String(c.ata || "").trim();

    const matchById = cAlumnoId && cAlumnoId === alumnoId;
    const matchByNombre = nombre && cNombre === nombre;
    const matchByNumero = numero && cNumero === numero;
    const matchByAta = ata && cAta === ata;

    // si matchea por cualquiera → se elimina (o sea, NO se conserva)
    return !(matchById || matchByNombre || matchByNumero || matchByAta);
  });

  const after = (active.cxc || []).length;
  log.info("CxC borradas junto con alumno", { eliminadas: before - after });

  saveActiveData(active);
  state.active = active;

  if (typeof renderAlumnos === "function") renderAlumnos();
  if (typeof rendercxc === "function") rendercxc();
  if (typeof renderResumen === "function") renderResumen();
};
window.deleteAlumno = deleteAlumnoImpl;





function clearAlumnoForm(){
  ["alNombre","alNacimiento","alEdad","alNumero","alCuota","alAta","alEmail","alDireccion","alNotas","alRango"]
    .forEach(id => $(id).value = "");

  $("alIngreso").value = todayISO();
  $("alPrograma").value = "BASICO";
  $("alEstado").value = "Activo";
  $("addAlumnoBtn").textContent = "Guardar alumno";
  delete $("addAlumnoBtn").dataset.editId;
}
  
