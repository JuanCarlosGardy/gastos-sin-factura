// app.js (ESM module)

// =============================
// 0) IMPORTS FIREBASE (CDN)
// =============================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, collection, addDoc,
  query, where, orderBy, getDocs, serverTimestamp, runTransaction, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

// =============================
// 1) PEGA AQUÍ TU firebaseConfig
// =============================
const firebaseConfig = {

    apiKey: "AIzaSyDR6n5YnteZ7irdx4FgXH-cfiyQ_6Us7ZM",

    authDomain: "gastos-sin-factura.firebaseapp.com",

    projectId: "gastos-sin-factura",

    storageBucket: "gastos-sin-factura.firebasestorage.app",

    messagingSenderId: "312830875431",

    appId: "1:312830875431:web:b92f3475b591e9d12efb02"

  };

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// =============================
// 2) HELPERS UI
// =============================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function setMsg(el, text, type){
  el.textContent = text || "";
  el.className = "msg" + (type ? " " + type : "");
}

function euro(n){
  const x = Number(n || 0);
  return x.toLocaleString("es-ES", { style:"currency", currency:"EUR" });
}

function ymd(d){
  const dt = d instanceof Date ? d : new Date(d);
  const mm = String(dt.getMonth()+1).padStart(2,"0");
  const dd = String(dt.getDate()).padStart(2,"0");
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

function currentYear(){ return new Date().getFullYear(); }
function currentMonth(){ return new Date().getMonth()+1; }

function startEndOfMonth(year, month){
  const start = new Date(year, month-1, 1);
  const end = new Date(year, month, 1);
  return { start, end };
}

function startEndOfQuarter(year, q){
  const startMonth = (q-1)*3 + 1;
  const start = new Date(year, startMonth-1, 1);
  const end = new Date(year, startMonth-1 + 3, 1);
  return { start, end };
}

function csvEscape(v){
  const s = String(v ?? "");
  if (/[",\n;]/.test(s)) return `"${s.replaceAll('"','""')}"`;
  return s;
}

function downloadText(filename, content){
  const blob = new Blob([content], { type:"text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

// =============================
// 3) MODELO DE CATEGORÍAS
// =============================
const CATEGORIES = [
  "Mantenimiento",
  "Servicios",
  "Alimentación",
  "Bebidas",
  "Sueldos",
  "Suministros",
  "Gastos varios"
];

// =============================
// 4) STATE
// =============================
let uid = null;
let providersCache = []; // {id, name, categories[] ...}
let lastReportRows = []; // para export CSV
let editingExpenseId = null;

// =============================
// 5) AUTH UI
// =============================
$("#btnLogin").addEventListener("click", async ()=>{
  setMsg($("#loginMsg"), "", "");
  const email = $("#loginEmail").value.trim();
  const pass = $("#loginPass").value.trim();
  if(!email || !pass) return setMsg($("#loginMsg"), "Indica email y contraseña.", "err");
  try{
    await signInWithEmailAndPassword(auth, email, pass);
  }catch(e){
    setMsg($("#loginMsg"), "No se pudo entrar. Revisa credenciales.", "err");
  }
});

$("#btnCreateUser").addEventListener("click", async ()=>{
  setMsg($("#loginMsg"), "", "");
  const email = $("#loginEmail").value.trim();
  const pass = $("#loginPass").value.trim();
  if(!email || !pass) return setMsg($("#loginMsg"), "Indica email y contraseña.", "err");
  try{
    await createUserWithEmailAndPassword(auth, email, pass);
    setMsg($("#loginMsg"), "Usuario creado. Ya puedes entrar siempre con estas credenciales.", "ok");
  }catch(e){
    setMsg($("#loginMsg"), "No se pudo crear el usuario. Puede que ya exista o la contraseña sea débil.", "err");
  }
});

$("#btnLogout").addEventListener("click", async ()=>{
  await signOut(auth);
});

$("#btnPrint").addEventListener("click", ()=>{
  window.print();
});

// =============================
// 6) TABS
// =============================
function showTab(tab){
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $("#tabProviders").classList.toggle("hidden", tab !== "providers");
  $("#tabExpenses").classList.toggle("hidden", tab !== "expenses");
  $("#tabReports").classList.toggle("hidden", tab !== "reports");
}

$$(".tab").forEach(btn=>{
  btn.addEventListener("click", ()=> showTab(btn.dataset.tab));
});

// =============================
// 7) FIRESTORE PATHS (por usuario)
// =============================
function colProviders(){ return collection(db, "users", uid, "providers"); }
function colExpenses(){ return collection(db, "users", uid, "expenses"); }
function docCounter(){ return doc(db, "users", uid, "counters", "expenses"); }

// =============================
// 8) INIT: asegurar contador
// =============================
async function ensureCounter(){
  const ref = docCounter();
  const snap = await getDoc(ref);
  if(!snap.exists()){
    await setDoc(ref, { next: 1, updatedAt: serverTimestamp() });
  }
}

// =============================
// 9) NUMERACIÓN SEGURA
// =============================
async function nextExpenseNumber(expenseDateYmd){
  // Formato: SF-AAAA-000001
  const year = Number(expenseDateYmd.slice(0,4));
  const counterRef = docCounter();

  const seq = await runTransaction(db, async (tx)=>{
    const snap = await tx.get(counterRef);
    if(!snap.exists()){
      tx.set(counterRef, { next: 2, updatedAt: serverTimestamp() });
      return 1;
    }
    const next = Number(snap.data().next || 1);
    tx.update(counterRef, { next: next + 1, updatedAt: serverTimestamp() });
    return next;
  });

  const padded = String(seq).padStart(6, "0");
  return `SF-${year}-${padded}`;
}

// =============================
// 10) PROVEEDORES
// =============================
function renderCategoryChecks(container){
  container.innerHTML = "";
  for(const cat of CATEGORIES){
    const wrap = document.createElement("label");
    wrap.className = "check";
    wrap.innerHTML = `<input type="checkbox" value="${cat}"> <span>${cat}</span>`;
    container.appendChild(wrap);
  }
}

let editingProviderId = null;

$("#btnNewProvider").addEventListener("click", ()=>{
  editingProviderId = null;
  $("#providerFormTitle").textContent = "Alta proveedor";
  $("#providerForm").classList.remove("hidden");
  $("#pName").value = "";
  $("#pContact").value = "";
  $("#pPhone").value = "";
  $("#pEmail").value = "";
  $$("#categoryChecks input[type=checkbox]").forEach(ch => ch.checked = false);
  setMsg($("#providerMsg"), "", "");
});

$("#btnCancelProvider").addEventListener("click", ()=>{
  $("#providerForm").classList.add("hidden");
});

$("#btnSaveProvider").addEventListener("click", async ()=>{
  setMsg($("#providerMsg"), "", "");
  const name = $("#pName").value.trim();
  if(!name) return setMsg($("#providerMsg"), "El nombre del proveedor es obligatorio.", "err");

  const categories = $$("#categoryChecks input[type=checkbox]")
    .filter(ch => ch.checked)
    .map(ch => ch.value);

  const data = {
    name,
    contact: $("#pContact").value.trim(),
    phone: $("#pPhone").value.trim(),
    email: $("#pEmail").value.trim(),
    categories,
    updatedAt: serverTimestamp(),
    ownerUid: uid
  };

  try{
    if(editingProviderId){
      await updateDoc(doc(db, "users", uid, "providers", editingProviderId), data);
      setMsg($("#providerMsg"), "Proveedor actualizado.", "ok");
    }else{
      data.createdAt = serverTimestamp();
      await addDoc(colProviders(), data);
      setMsg($("#providerMsg"), "Proveedor guardado.", "ok");
    }
    $("#providerForm").classList.add("hidden");
    await loadProviders();
    fillProviderSelect();
  }catch(e){
    setMsg($("#providerMsg"), "Error guardando proveedor.", "err");
  }
});

async function loadProviders(){
  const qy = query(colProviders(), orderBy("name"));
  const snap = await getDocs(qy);
  providersCache = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  renderProvidersList();
}

function renderProvidersList(){
  const term = $("#providerSearch").value.trim().toLowerCase();
  const list = $("#providersList");
  list.innerHTML = "";

  const rows = providersCache.filter(p => !term || (p.name || "").toLowerCase().includes(term));

  if(rows.length === 0){
    list.innerHTML = `<div class="item muted">No hay proveedores.</div>`;
    return;
  }

  for(const p of rows){
    const el = document.createElement("div");
    el.className = "item";
    const cats = (p.categories || []).join(", ") || "—";
    el.innerHTML = `
      <div class="itemHead">
        <div>
          <div><strong>${p.name}</strong></div>
          <div class="kv">
            <span>Contacto: ${p.contact || "—"}</span>
            <span>Tel: ${p.phone || "—"}</span>
            <span>Email: ${p.email || "—"}</span>
          </div>
          <div class="kv">
            <span class="badge">${cats}</span>
          </div>
        </div>
        <div class="row">
          <button class="btn ghost" data-edit="${p.id}">Editar</button>
        </div>
      </div>
    `;
    list.appendChild(el);
  }

  list.querySelectorAll("button[data-edit]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.dataset.edit;
      const p = providersCache.find(x => x.id === id);
      if(!p) return;

      editingProviderId = id;
      $("#providerFormTitle").textContent = "Editar proveedor";
      $("#providerForm").classList.remove("hidden");
      $("#pName").value = p.name || "";
      $("#pContact").value = p.contact || "";
      $("#pPhone").value = p.phone || "";
      $("#pEmail").value = p.email || "";
      const set = new Set(p.categories || []);
      $$("#categoryChecks input[type=checkbox]").forEach(ch => ch.checked = set.has(ch.value));
      setMsg($("#providerMsg"), "", "");
    });
  });
}

$("#providerSearch").addEventListener("input", renderProvidersList);

// =============================
// 11) GASTOS
// =============================
function fillProviderSelect(){
  const sel = $("#eProvider");
  sel.innerHTML = "";

  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "— Selecciona proveedor —";
  sel.appendChild(opt0);

  for(const p of providersCache){
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  }
}

function fillCategorySelect(selected){
  const sel = $("#eCategory");
  sel.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "—";
  sel.appendChild(opt0);

  for(const cat of CATEGORIES){
    const o = document.createElement("option");
    o.value = cat;
    o.textContent = cat;
    if(selected && selected === cat) o.selected = true;
    sel.appendChild(o);
  }
}

$("#btnNewExpense").addEventListener("click", ()=>{
  editingExpenseId = null;
  $("#expenseForm").classList.remove("hidden");
  $("#eDate").value = ymd(new Date());
  $("#eProvider").value = "";
  fillCategorySelect("");
  $("#eAmount").value = "";
  $("#eRef").value = "";
  $("#eNotes").value = "";
  $("#ePay").value = "";
  $("#eNumberPreview").value = "";
  setMsg($("#expenseMsg"), "", "");
});

$("#btnCancelExpense").addEventListener("click", ()=>{
  $("#expenseForm").classList.add("hidden");
});

$("#eProvider").addEventListener("change", ()=>{
  const pid = $("#eProvider").value;
  const p = providersCache.find(x => x.id === pid);
  // Si el proveedor tiene 1 categoría, la preseleccionamos
  if(p && (p.categories || []).length === 1){
    fillCategorySelect(p.categories[0]);
  }
});

$("#btnSaveExpense").addEventListener("click", async ()=>{
  setMsg($("#expenseMsg"), "", "");

  const dateYmd = $("#eDate").value;
  const providerId = $("#eProvider").value;
  const category = $("#eCategory").value;
  const amount = Number($("#eAmount").value);
  const refText = $("#eRef").value.trim();

  if(!dateYmd) return setMsg($("#expenseMsg"), "La fecha es obligatoria.", "err");
  if(!providerId) return setMsg($("#expenseMsg"), "Selecciona proveedor.", "err");
  if(!category) return setMsg($("#expenseMsg"), "Selecciona categoría.", "err");
  if(!refText) return setMsg($("#expenseMsg"), "La referencia / concepto es obligatoria.", "err");
  if(!Number.isFinite(amount) || amount <= 0) return setMsg($("#expenseMsg"), "Indica un importe válido.", "err");

  const provider = providersCache.find(x => x.id === providerId);
  if(!provider) return setMsg($("#expenseMsg"), "Proveedor no válido.", "err");
const isEditing = !!editingExpenseId;
  try{
    if(isEditing){
  // EDITAR: no se toca el número
  const refDoc = doc(db, "users", uid, "expenses", editingExpenseId);

  await updateDoc(refDoc, {
    dateYmd,
    providerId,
    providerName: provider.name || "",
    category,
    reference: refText,
    amount,
    notes: $("#eNotes").value.trim(),
    payMethod: $("#ePay").value,
    updatedAt: serverTimestamp()
  });

  setMsg($("#expenseMsg"), "Gasto actualizado.", "ok");
}else{
  // CREAR: genera número único
  const num = await nextExpenseNumber(dateYmd);

  const data = {
    number: num,
    dateYmd,
    providerId,
    providerName: provider.name || "",
    category,
    reference: refText,
    amount,
    notes: $("#eNotes").value.trim(),
    payMethod: $("#ePay").value,
    status: "active",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ownerUid: uid
  };

  await addDoc(colExpenses(), data);

  $("#eNumberPreview").value = num;
  setMsg($("#expenseMsg"), `Gasto guardado con número ${num}.`, "ok");
}

$("#expenseForm").classList.add("hidden");
await loadExpensesList();
  }catch(e){
    setMsg($("#expenseMsg"), "Error guardando gasto.", "err");
  }
});

async function loadExpensesList(){
  // Carga simple: últimos 200 ordenados por fecha desc
  const qy = query(colExpenses(), orderBy("dateYmd", "desc"), orderBy("number", "desc"));
  const snap = await getDocs(qy);
  const all = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  renderExpensesList(all);
}
async function voidExpense(expenseId){
  // Anular (recomendado): no borra, marca estado y deja rastro
  const ref = doc(db, "users", uid, "expenses", expenseId);
  await updateDoc(ref, {
    status: "void",
    voidedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

async function hardDeleteExpense(expenseId){
  // Borrado real (si alguna vez lo necesitas)
  const ref = doc(db, "users", uid, "expenses", expenseId);
  await deleteDoc(ref);
}
function renderExpensesList(all){
  const term = $("#expenseSearch").value.trim().toLowerCase();
  const quick = $("#expenseQuickFilter").value;

  const now = new Date();
  let start = null, end = null;

  if(quick === "m0"){
    const { start:s, end:e } = startEndOfMonth(now.getFullYear(), now.getMonth()+1);
    start = ymd(s); end = ymd(e);
  }
  if(quick === "q0"){
    const q = Math.floor(now.getMonth()/3)+1;
    const { start:s, end:e } = startEndOfQuarter(now.getFullYear(), q);
    start = ymd(s); end = ymd(e);
  }

  const rows = all.filter(x=>{
    const matchesText =
      !term ||
      (x.providerName || "").toLowerCase().includes(term) ||
      (x.reference || "").toLowerCase().includes(term) ||
      (x.number || "").toLowerCase().includes(term);

    const inRange = (!start || (x.dateYmd >= start && x.dateYmd < end));
    return matchesText && inRange;
  });

  const list = $("#expensesList");
  list.innerHTML = "";

  if(rows.length === 0){
    list.innerHTML = `<div class="item muted">No hay gastos para mostrar.</div>`;
    return;
  }

  for(const e of rows){
    const el = document.createElement("div");
    el.className = "item";
    const isVoid = (e.status === "void");

el.innerHTML = `
  <div class="itemHead">
    <div>
      <div>
        <strong>${e.number || "—"}</strong> — ${e.providerName || "—"}
        ${isVoid ? `<span class="badge" style="margin-left:8px">ANULADO</span>` : ``}
      </div>

      <div class="kv">
        <span>Fecha: ${e.dateYmd || "—"}</span>
        <span>Categoría: ${e.category || "—"}</span>
        <span>Importe: ${euro(e.amount)}</span>
      </div>

      <div class="kv">
        <span>Ref: ${e.reference || "—"}</span>
        <span>Pago: ${e.payMethod || "—"}</span>
      </div>
    </div>

    <div style="display:grid; gap:8px; justify-items:end">
      <div class="badge">${euro(e.amount)}</div>
      <div class="row" style="margin-top:0">
        <button class="btn ghost" data-eedit="${e.id}" ${isVoid ? "disabled" : ""}>Editar</button>
        <button class="btn danger" data-evoid="${e.id}" ${isVoid ? "disabled" : ""}>Anular</button>
      </div>
    </div>
  </div>
`;
    list.appendChild(el);
  }
  list.querySelectorAll("button[data-eedit]").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    const id = btn.dataset.eedit;
    const e = rows.find(x => x.id === id);
    if(!e) return;

    editingExpenseId = id;
    $("#expenseForm").classList.remove("hidden");

    $("#eDate").value = e.dateYmd || ymd(new Date());
    $("#eProvider").value = e.providerId || "";
    fillCategorySelect(e.category || "");
    $("#eAmount").value = String(e.amount ?? "");
    $("#eRef").value = e.reference || "";
    $("#eNotes").value = e.notes || "";
    $("#ePay").value = e.payMethod || "";
    $("#eNumberPreview").value = e.number || "";

    setMsg($("#expenseMsg"), "", "");
  });
});

list.querySelectorAll("button[data-evoid]").forEach(btn=>{
  btn.addEventListener("click", async ()=>{
    const id = btn.dataset.evoid;
    const e = rows.find(x => x.id === id);
    if(!e) return;

    const ok = confirm(`¿Seguro que quieres ANULAR el gasto ${e.number}?\n\nNo se borrará: quedará marcado como ANULADO para control interno.`);
    if(!ok) return;

    await voidExpense(id);
    await loadExpensesList();
  });
});
}

$("#expenseSearch").addEventListener("input", ()=> loadExpensesList());
$("#expenseQuickFilter").addEventListener("change", ()=> loadExpensesList());

// =============================
// 12) INFORMES
// =============================
$("#rYear").value = String(currentYear());
$("#rMonth").value = String(currentMonth());
$("#rQuarter").value = String(Math.floor((currentMonth()-1)/3)+1);

$("#rType").addEventListener("change", ()=>{
  const t = $("#rType").value;
  $("#wrapMonth").classList.toggle("hidden", t !== "month");
  $("#wrapQuarter").classList.toggle("hidden", t !== "quarter");
});

$("#btnRunReport").addEventListener("click", async ()=>{
  const type = $("#rType").value;
  const year = Number($("#rYear").value);
  if(!Number.isFinite(year) || year < 2020) return;

  let start, end, label;

  if(type === "month"){
    const m = Number($("#rMonth").value);
    const r = startEndOfMonth(year, m);
    start = ymd(r.start);
    end = ymd(r.end);
    label = `Informe mensual — ${year}-${String(m).padStart(2,"0")}`;
  }else{
    const q = Number($("#rQuarter").value);
    const r = startEndOfQuarter(year, q);
    start = ymd(r.start);
    end = ymd(r.end);
    label = `Informe trimestral — ${year} T${q}`;
  }

  const qy = query(
  colExpenses(),
  where("dateYmd", ">=", start),
  where("dateYmd", "<", end),
  orderBy("dateYmd", "asc"),
  orderBy("number", "asc")
);

  const snap = await getDocs(qy);
  const rows = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  const rowsActive = rows.filter(r => r.status !== "void"); // incluye status undefined
renderReport(label, start, end, rowsActive);
return;
});

function renderReport(label, start, end, rows){
  lastReportRows = rows;

  let total = 0;
  const byCat = new Map();
  const byProv = new Map();

  for(const r of rows){
    const a = Number(r.amount || 0);
    total += a;
    byCat.set(r.category || "—", (byCat.get(r.category || "—") || 0) + a);
    byProv.set(r.providerName || "—", (byProv.get(r.providerName || "—") || 0) + a);
  }

  const cats = Array.from(byCat.entries()).sort((a,b)=> b[1]-a[1]);
  const provs = Array.from(byProv.entries()).sort((a,b)=> b[1]-a[1]);

  const lines = rows.map(r => `
    <tr>
      <td>${r.dateYmd || ""}</td>
      <td>${r.number || ""}</td>
      <td>${r.providerName || ""}</td>
      <td>${r.category || ""}</td>
      <td>${r.reference || ""}</td>
      <td style="text-align:right">${euro(r.amount)}</td>
    </tr>
  `).join("");

  const catsHtml = cats.map(([k,v])=> `<li><strong>${k}:</strong> ${euro(v)}</li>`).join("");
  const provsHtml = provs.slice(0, 12).map(([k,v])=> `<li><strong>${k}:</strong> ${euro(v)}</li>`).join("");

  $("#reportArea").innerHTML = `
    <div class="item">
      <div><strong>${label}</strong></div>
      <div class="kv">
        <span>Rango: ${start} a ${ymd(new Date(new Date(end).getTime()-86400000))}</span>
        <span>Nº registros: ${rows.length}</span>
        <span>Total: <strong>${euro(total)}</strong></span>
      </div>
    </div>

    <div class="grid2" style="margin-top:10px">
      <div class="item">
        <div><strong>Totales por categoría</strong></div>
        <ul>${catsHtml || "<li>—</li>"}</ul>
      </div>
      <div class="item">
        <div><strong>Top proveedores (hasta 12)</strong></div>
        <ul>${provsHtml || "<li>—</li>"}</ul>
      </div>
    </div>

    <div class="item" style="margin-top:10px; overflow:auto">
      <div><strong>Detalle</strong></div>
      <table style="width:100%; border-collapse:collapse; margin-top:8px">
        <thead>
          <tr>
            <th style="text-align:left; border-bottom:1px solid var(--line); padding:6px">Fecha</th>
            <th style="text-align:left; border-bottom:1px solid var(--line); padding:6px">Nº</th>
            <th style="text-align:left; border-bottom:1px solid var(--line); padding:6px">Proveedor</th>
            <th style="text-align:left; border-bottom:1px solid var(--line); padding:6px">Categoría</th>
            <th style="text-align:left; border-bottom:1px solid var(--line); padding:6px">Referencia</th>
            <th style="text-align:right; border-bottom:1px solid var(--line); padding:6px">Importe</th>
          </tr>
        </thead>
        <tbody>${lines || ""}</tbody>
      </table>
    </div>
  `;
}

$("#btnExportCsv").addEventListener("click", ()=>{
  if(!lastReportRows || lastReportRows.length === 0){
    return;
  }
  const header = ["Fecha","Numero","Proveedor","Categoria","Referencia","Importe","Pago","Notas"];
  const rows = lastReportRows.map(r => ([
    r.dateYmd || "",
    r.number || "",
    r.providerName || "",
    r.category || "",
    r.reference || "",
    String(r.amount ?? ""),
    r.payMethod || "",
    r.notes || ""
  ].map(csvEscape).join(";")));

  const content = [header.join(";"), ...rows].join("\n");
  downloadText("informe_gastos_sin_factura.csv", content);
});

// =============================
// 13) ARRANQUE
// =============================
renderCategoryChecks($("#categoryChecks"));

onAuthStateChanged(auth, async (user)=>{
  if(!user){
    uid = null;
    $("#viewLogin").classList.remove("hidden");
    $("#viewApp").classList.add("hidden");
    return;
  }

  uid = user.uid;
  $("#viewLogin").classList.add("hidden");
  $("#viewApp").classList.remove("hidden");

  showTab("providers");

  fillCategorySelect("");
  await ensureCounter();
  await loadProviders();
  fillProviderSelect();
  await loadExpensesList();
});
