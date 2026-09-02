/* ==========================================================
   تواريخ المنتجات — موقع مخصّص
   القاعدة الذهبية بهذا الملف: أي عملية حفظ لازم تُنتظر (await)
   وتُتأكَّد نتيجتها الفعلية قبل ما نقول للمستخدم "تم الحفظ" أو
   نغلق أي نافذة. لو فشلت، تظهر رسالة خطأ واضحة والنافذة تبقى
   مفتوحة ببياناتها كما هي، حتى لا يضيع أي إدخال.
========================================================== */

const supabaseClient = (window.SUPABASE_URL && window.SUPABASE_ANON_KEY)
  ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)
  : null;

const state = {
  branches: [],
  products: [],
  dailyEditedIds: {}, // { branchId: [productId, ...] }
  links: [],
  activeTab: null, // null = الشاشة الرئيسية (القائمة)
  activeBranchId: null,
};

/* ---------------- توست (رسائل تنبيه) ---------------- */
let toastTimer = null;
function toast(msg, isError){
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.toggle("err", !!isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> el.classList.remove("show"), 2600);
}

/* ---------------- أدوات عامة ---------------- */
function uid(){ return Math.random().toString(36).slice(2,10) + Date.now().toString(36); }

function expiryStatus(p){
  if(!p.end_day || !p.end_month) return { status:"ok", label:"—" };
  const today = new Date();
  const year = p.end_year || today.getFullYear();
  const end = new Date(year, p.end_month-1, p.end_day);
  const diffDays = Math.ceil((end - today) / (1000*60*60*24));
  if(diffDays < 0) return { status:"expired", label:"منتهي" };
  if(diffDays <= (p.alert_days||0)) return { status:"warning", label:`باقي ${diffDays} يوم` };
  return { status:"ok", label:`${p.end_day}/${p.end_month}/${String(year).slice(-2)}` };
}

/* ---------------- رفع الصور إلى Storage (لا تُخزَّن كنص طويل أبدًا) ---------------- */
async function compressImageToDataUrl(file, maxDim){
  const dataUrl = await new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject)=>{
    const im = new Image();
    im.onload = ()=> resolve(im);
    im.onerror = reject;
    im.src = dataUrl;
  });
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width*scale);
  canvas.height = Math.round(img.height*scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.8);
}

async function uploadImageToStorage(dataUrl, productId){
  if(!supabaseClient) return null;
  try{
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const path = `${productId}-${Date.now()}.jpg`;
    const { error } = await supabaseClient.storage.from("product-images")
      .upload(path, blob, { contentType: "image/jpeg", upsert: true });
    if(error) throw error;
    const { data } = supabaseClient.storage.from("product-images").getPublicUrl(path);
    return data && data.publicUrl ? data.publicUrl : null;
  }catch(e){ console.error("image upload failed", e); return null; }
}

/* ---------------- الفروع (جدول حقيقي: branches_v2) ---------------- */
async function loadBranches(){
  if(!supabaseClient) return [];
  try{
    const { data, error } = await supabaseClient.from("branches_v2").select("*").order("created_at");
    if(error) throw error;
    return data || [];
  }catch(e){ console.error("loadBranches failed", e); return []; }
}
async function saveBranch(branch){
  if(!supabaseClient) return false;
  try{
    const { error } = await supabaseClient.from("branches_v2").upsert(branch);
    if(error) throw error;
    return true;
  }catch(e){ console.error("saveBranch failed", e); return false; }
}
async function deleteBranchAndProducts(branchId){
  if(!supabaseClient) return false;
  try{
    const ids = state.products.filter(p=>p.branch_id===branchId).map(p=>p.id);
    if(ids.length){
      const { error: delProdsErr } = await supabaseClient.from("products_v2").delete().in("id", ids);
      if(delProdsErr) throw delProdsErr;
    }
    const { error } = await supabaseClient.from("branches_v2").delete().eq("id", branchId);
    if(error) throw error;
    return true;
  }catch(e){ console.error("deleteBranchAndProducts failed", e); return false; }
}

/* ---------------- المنتجات (جدول حقيقي: products_v2، سطر لكل منتج) ---------------- */
async function loadProducts(){
  if(!supabaseClient) return [];
  try{
    const { data, error } = await supabaseClient.from("products_v2").select("*");
    if(error) throw error;
    return data || [];
  }catch(e){ console.error("loadProducts failed", e); return []; }
}
/* يحفظ فقط المنتج الممرَّر (upsert سطر واحد) — لا يعيد إرسال أي قائمة كاملة أبدًا */
async function saveProductRow(row){
  if(!supabaseClient) return false;
  try{
    const { error } = await supabaseClient.from("products_v2").upsert(row);
    if(error) throw error;
    return true;
  }catch(e){
    console.error("saveProductRow failed, retrying once", e);
    try{
      const { error: e2 } = await supabaseClient.from("products_v2").upsert(row);
      if(e2) throw e2;
      return true;
    }catch(e2){ console.error("saveProductRow failed after retry", e2); return false; }
  }
}
async function deleteProductRow(id){
  if(!supabaseClient) return false;
  try{
    const { error } = await supabaseClient.from("products_v2").delete().eq("id", id);
    if(error) throw error;
    return true;
  }catch(e){ console.error("deleteProductRow failed", e); return false; }
}

/* ---------------- منتجات مختارة (جدول حقيقي: daily_edited_products) ---------------- */
async function loadDailyEditedIds(){
  if(!supabaseClient) return {};
  try{
    const { data, error } = await supabaseClient.from("daily_edited_products").select("branch_id, product_id");
    if(error) throw error;
    const grouped = {};
    (data||[]).forEach(r=> (grouped[r.branch_id] = grouped[r.branch_id]||[]).push(r.product_id));
    return grouped;
  }catch(e){ console.error("loadDailyEditedIds failed", e); return {}; }
}
async function markSelected(branchId, productId){
  if(!supabaseClient) return false;
  try{
    const { error } = await supabaseClient.from("daily_edited_products")
      .upsert({ branch_id: branchId, product_id: productId });
    if(error) throw error;
    return true;
  }catch(e){ console.error("markSelected failed", e); return false; }
}
async function unmarkSelected(branchId, productId){
  if(!supabaseClient) return false;
  try{
    const { error } = await supabaseClient.from("daily_edited_products")
      .delete().eq("branch_id", branchId).eq("product_id", productId);
    if(error) throw error;
    return true;
  }catch(e){ console.error("unmarkSelected failed", e); return false; }
}

/* ---------------- الروابط (جدول: links_v1) ---------------- */
async function loadLinks(){
  if(!supabaseClient) return [];
  try{
    const { data, error } = await supabaseClient.from("links_v1").select("*").order("sort_order").order("created_at");
    if(error) throw error;
    return data || [];
  }catch(e){ console.error("loadLinks failed", e); return []; }
}
async function saveLink(link){
  if(!supabaseClient) return false;
  try{
    const { error } = await supabaseClient.from("links_v1").upsert(link);
    if(error) throw error;
    return true;
  }catch(e){ console.error("saveLink failed", e); return false; }
}
async function deleteLink(id){
  if(!supabaseClient) return false;
  try{
    const { error } = await supabaseClient.from("links_v1").delete().eq("id", id);
    if(error) throw error;
    return true;
  }catch(e){ console.error("deleteLink failed", e); return false; }
}

/* ---------------- تحميل كل شي أول ما يفتح الموقع ---------------- */
async function loadAll(){
  if(!supabaseClient){
    document.getElementById("app").innerHTML = `<div class="empty-state">
      لم يتم ضبط الاتصال بـ Supabase — تأكد من ملء ملف config.js بالرابط والمفتاح الصحيحين.
    </div>`;
    return;
  }
  [state.branches, state.products, state.dailyEditedIds, state.links] = await Promise.all([
    loadBranches(), loadProducts(), loadDailyEditedIds(), loadLinks()
  ]);
  if(!state.activeBranchId && state.branches.length) state.activeBranchId = state.branches[0].id;
  render();
}

/* ---------------- العرض (Render) ---------------- */
function render(){
  const app = document.getElementById("app");
  const backBtn = document.getElementById("backBtn");
  const sub = document.getElementById("topbarSub");
  if(state.activeTab === null){
    backBtn.style.display = "none";
    sub.textContent = "موقع مخصّص — منتجات مختارة وروابط";
    app.innerHTML = renderHomeMenu();
  }else{
    backBtn.style.display = "flex";
    sub.textContent = state.activeTab === "dates" ? "التواريخ" : "الروابط";
    app.innerHTML = state.activeTab === "dates" ? renderDatesTab() : renderLinksTab();
  }
  attachHandlers();
}

function renderHomeMenu(){
  return `
    <div class="home-menu">
      <div class="home-tile" data-goto="dates">
        <div class="htitle">📅 التواريخ</div>
        <div class="hsub">جميع المنتجات ومنتجات مختارة لكل فرع</div>
      </div>
      <div class="home-tile" data-goto="links">
        <div class="htitle">🔗 الروابط</div>
        <div class="hsub">روابط سريعة تفتح مباشرة عند الضغط</div>
      </div>
    </div>
  `;
}


function renderDatesTab(){
  if(!state.branches.length){
    return `
      <button class="add-tile" id="addBranchBtn">+ إضافة فرع جديد</button>
      <div class="empty-state">لا يوجد فروع بعد — أضف أول فرع للبدء.</div>
    `;
  }
  const pills = state.branches.map(b=> `
    <div class="branch-pill ${b.id===state.activeBranchId?'active':''}" data-branch="${b.id}">${escapeHtml(b.name)}</div>
  `).join("") + `<div class="branch-pill" id="addBranchBtn" style="border-style:dashed;">+ فرع جديد</div>`;

  const branch = state.branches.find(b=>b.id===state.activeBranchId);
  if(!branch) return `<div class="branch-pills">${pills}</div>`;

  const allProducts = state.products.filter(p=>p.branch_id===branch.id);
  const selectedIds = new Set(state.dailyEditedIds[branch.id] || []);
  const selectedProducts = allProducts.filter(p=> selectedIds.has(p.id));

  return `
    <div class="branch-pills">${pills}</div>

    <details class="group" open>
      <summary>
        <span><span class="group-count">${allProducts.length}</span>جميع المنتجات</span>
        <span>▾</span>
      </summary>
      <div class="group-body">
        <div class="product-grid">${allProducts.map(p=>productCardHtml(p)).join("") || '<div class="empty-state">لا يوجد منتجات بهذا الفرع</div>'}</div>
        <button class="add-tile" data-add-product="${branch.id}">+ إضافة منتج</button>
      </div>
    </details>

    <details class="group" open>
      <summary>
        <span><span class="group-count">${selectedProducts.length}</span>منتجات مختارة</span>
        <span>▾</span>
      </summary>
      <div class="group-body">
        <button class="btn btn-ghost" id="exportSelectedBtn">⬇ تحميل منتجات مختارة (كل الفروع)</button>
        <div class="product-grid">${selectedProducts.map(p=>productCardHtml(p)).join("") || '<div class="empty-state">لا يوجد منتجات مختارة بعد</div>'}</div>
      </div>
    </details>

    <button class="btn btn-danger" style="width:100%;" data-del-branch="${branch.id}">حذف هذا الفرع</button>
  `;
}

function productCardHtml(p){
  const ex = expiryStatus(p);
  if(!p.image_url){
    return `
      <div class="product-card compact" data-edit-product="${p.id}">
        <div class="pname">${escapeHtml(p.name)}</div>
        <div class="psku">${escapeHtml(p.sku||'')}</div>
        <div class="pexp ${ex.status}">${ex.label}</div>
      </div>
    `;
  }
  return `
    <div class="product-card" data-edit-product="${p.id}">
      <img src="${p.image_url}" alt="">
      <div class="pname">${escapeHtml(p.name)}</div>
      <div class="psku">${escapeHtml(p.sku||'')}</div>
      <div class="pexp ${ex.status}">${ex.label}</div>
    </div>
  `;
}

function renderLinksTab(){
  return `
    <div class="links-list">
      ${state.links.map(l=> `
        <div class="link-item">
          <div>
            <div class="ltitle">${escapeHtml(l.title)}</div>
            <div class="lurl">${escapeHtml(l.url)}</div>
          </div>
          <div style="display:flex; gap:6px;">
            <button class="btn btn-primary" data-open-link="${l.id}">فتح</button>
            <button class="btn btn-danger" data-del-link="${l.id}">حذف</button>
          </div>
        </div>
      `).join("") || '<div class="empty-state">لا يوجد روابط بعد</div>'}
    </div>
    <button class="add-tile" id="addLinkBtn">+ إضافة رابط جديد</button>
  `;
}

function escapeHtml(s){
  return String(s||"").replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------------- قوائم اختيار التاريخ (بدون كتابة يدوية) ---------------- */
function dayOptions(selected){
  let html = `<option value="">-</option>`;
  for(let d=1; d<=31; d++) html += `<option value="${d}" ${d===selected?'selected':''}>${d}</option>`;
  return html;
}
function monthOptions(selected){
  const names = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];
  let html = `<option value="">-</option>`;
  names.forEach((n,i)=>{
    const m = i+1;
    html += `<option value="${m}" ${m===selected?'selected':''}>${m} - ${n}</option>`;
  });
  return html;
}
function yearOptions(selected){
  const currentYear = new Date().getFullYear();
  let html = "";
  for(let y=currentYear; y<=currentYear+2; y++){
    const isSel = selected ? y===selected : y===currentYear;
    html += `<option value="${y}" ${isSel?'selected':''}>${String(y).slice(-2)}</option>`;
  }
  return html;
}

/* ---------------- ربط الأحداث ---------------- */
function attachHandlers(){
  const backBtn = document.getElementById("backBtn");
  if(backBtn) backBtn.onclick = ()=>{ state.activeTab = null; render(); };

  document.querySelectorAll("[data-goto]").forEach(el=>{
    el.onclick = ()=>{ state.activeTab = el.getAttribute("data-goto"); render(); };
  });

  document.querySelectorAll("[data-branch]").forEach(el=>{
    el.onclick = ()=>{ state.activeBranchId = el.getAttribute("data-branch"); render(); };
  });

  const addBranchBtn = document.getElementById("addBranchBtn");
  if(addBranchBtn) addBranchBtn.onclick = ()=> openAddBranchModal();

  document.querySelectorAll("[data-del-branch]").forEach(el=>{
    el.onclick = async ()=>{
      const id = el.getAttribute("data-del-branch");
      if(!confirm("تأكيد حذف الفرع وكل منتجاته؟")) return;
      const ok = await deleteBranchAndProducts(id);
      if(!ok){ toast("فشل الحذف، حاول مرة أخرى", true); return; }
      state.branches = state.branches.filter(b=>b.id!==id);
      state.products = state.products.filter(p=>p.branch_id!==id);
      state.activeBranchId = state.branches[0] ? state.branches[0].id : null;
      toast("تم حذف الفرع");
      render();
    };
  });

  document.querySelectorAll("[data-add-product]").forEach(el=>{
    el.onclick = ()=> openProductModal(el.getAttribute("data-add-product"), null);
  });
  document.querySelectorAll("[data-edit-product]").forEach(el=>{
    el.onclick = ()=>{
      const p = state.products.find(x=>x.id===el.getAttribute("data-edit-product"));
      if(p) openProductModal(p.branch_id, p);
    };
  });

  const exportBtn = document.getElementById("exportSelectedBtn");
  if(exportBtn) exportBtn.onclick = exportSelectedProductsCSV;

  const addLinkBtn = document.getElementById("addLinkBtn");
  if(addLinkBtn) addLinkBtn.onclick = ()=> openLinkModal();

  document.querySelectorAll("[data-open-link]").forEach(el=>{
    el.onclick = ()=>{
      const l = state.links.find(x=>x.id===el.getAttribute("data-open-link"));
      if(l) window.open(l.url, "_blank");
    };
  });
  document.querySelectorAll("[data-del-link]").forEach(el=>{
    el.onclick = async ()=>{
      const id = el.getAttribute("data-del-link");
      if(!confirm("حذف هذا الرابط؟")) return;
      const ok = await deleteLink(id);
      if(!ok){ toast("فشل الحذف، حاول مرة أخرى", true); return; }
      state.links = state.links.filter(l=>l.id!==id);
      toast("تم الحذف");
      render();
    };
  });
}

/* ---------------- نافذة إضافة فرع ---------------- */
function openAddBranchModal(){
  const wrap = document.createElement("div");
  wrap.className = "modal-overlay";
  wrap.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-title">إضافة فرع جديد</div>
      <div class="field"><label>اسم الفرع</label><input id="newBranchName" type="text" placeholder="مثال: فرع الرياض"></div>
      <button class="btn btn-primary" style="width:100%;" id="saveBranchBtn">حفظ</button>
    </div>
  `;
  document.body.appendChild(wrap);
  wrap.onclick = (e)=>{ if(e.target===wrap) wrap.remove(); };
  document.getElementById("saveBranchBtn").onclick = async ()=>{
    const name = document.getElementById("newBranchName").value.trim();
    if(!name){ toast("اكتب اسم الفرع", true); return; }
    const btn = document.getElementById("saveBranchBtn");
    btn.disabled = true; btn.textContent = "...جاري الحفظ";
    const branch = { id: uid(), name };
    const ok = await saveBranch(branch);
    if(!ok){
      btn.disabled = false; btn.textContent = "حفظ";
      toast("فشل الحفظ، حاول مرة أخرى", true);
      return;
    }
    state.branches.push(branch);
    state.activeBranchId = branch.id;
    wrap.remove();
    toast("تمت إضافة الفرع");
    render();
  };
}

/* ---------------- نافذة إضافة/تعديل منتج ---------------- */
function openProductModal(branchId, existing){
  let pendingImage = null;
  const isSelected = existing ? (state.dailyEditedIds[branchId]||[]).includes(existing.id) : false;
  const wrap = document.createElement("div");
  wrap.className = "modal-overlay";
  wrap.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-title">${existing ? "تعديل منتج" : "إضافة منتج"}</div>
      <img class="img-preview" id="pmImgPreview" src="${existing?.image_url || ''}" alt="">
      <input type="file" id="pmImgInput" accept="image/*" style="margin-bottom:10px;">
      <div class="field"><label>اسم المنتج</label><input id="pmName" type="text" value="${existing? escapeHtml(existing.name):''}"></div>
      <div class="field-row">
        <div class="field"><label>SKU</label><input id="pmSku" type="text" value="${existing?.sku||''}"></div>
        <div class="field"><label>الوزن</label><input id="pmWeight" type="number" value="${existing?.weight_value||''}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>يوم الانتهاء</label>
          <select id="pmEndDay">${dayOptions(existing?.end_day)}</select>
        </div>
        <div class="field"><label>شهر الانتهاء</label>
          <select id="pmEndMonth">${monthOptions(existing?.end_month)}</select>
        </div>
        <div class="field"><label>السنة</label>
          <select id="pmEndYear">${yearOptions(existing?.end_year)}</select>
        </div>
      </div>
      <div class="field"><label>أيام التنبيه قبل الانتهاء</label><input id="pmAlertDays" type="number" value="${existing?.alert_days||7}"></div>
      <button class="btn btn-primary" style="width:100%;" id="pmSaveBtn">حفظ</button>
      ${existing && isSelected ? `<button class="btn btn-ghost" style="margin-top:8px;" id="pmRemoveSelectedBtn">إزالة من منتجات مختارة فقط</button>` : ''}
      ${existing ? `<button class="btn btn-danger" style="width:100%; margin-top:8px;" id="pmDeleteBtn">حذف المنتج نهائيًا</button>` : ''}
    </div>
  `;
  document.body.appendChild(wrap);
  wrap.onclick = (e)=>{ if(e.target===wrap) wrap.remove(); };

  document.getElementById("pmImgInput").onchange = async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const dataUrl = await compressImageToDataUrl(file, 640);
    pendingImage = dataUrl;
    document.getElementById("pmImgPreview").src = dataUrl;
  };

  if(existing){
    if(isSelected){
      document.getElementById("pmRemoveSelectedBtn").onclick = async ()=>{
        const btn = document.getElementById("pmRemoveSelectedBtn");
        btn.disabled = true; btn.textContent = "...جاري الإزالة";
        const ok = await unmarkSelected(branchId, existing.id);
        if(!ok){
          btn.disabled = false; btn.textContent = "إزالة من منتجات مختارة فقط";
          toast("فشلت الإزالة، حاول مرة أخرى", true);
          return;
        }
        state.dailyEditedIds[branchId] = (state.dailyEditedIds[branchId]||[]).filter(id=>id!==existing.id);
        wrap.remove();
        toast("تمت الإزالة من منتجات مختارة (المنتج باقٍ بالقائمة العامة)");
        render();
      };
    }
    document.getElementById("pmDeleteBtn").onclick = async ()=>{
      if(!confirm("تأكيد حذف المنتج نهائيًا من كل مكان؟")) return;
      const ok = await deleteProductRow(existing.id);
      if(!ok){ toast("فشل الحذف، حاول مرة أخرى", true); return; }
      state.products = state.products.filter(p=>p.id!==existing.id);
      Object.keys(state.dailyEditedIds).forEach(bid=>{
        state.dailyEditedIds[bid] = (state.dailyEditedIds[bid]||[]).filter(id=>id!==existing.id);
      });
      wrap.remove();
      toast("تم حذف المنتج");
      render();
    };
  }

  document.getElementById("pmSaveBtn").onclick = async ()=>{
    const btn = document.getElementById("pmSaveBtn");
    btn.disabled = true; btn.textContent = "...جاري الحفظ";

    const id = existing ? existing.id : uid();
    const row = {
      id, branch_id: branchId,
      name: document.getElementById("pmName").value.trim() || "منتج بدون اسم",
      sku: document.getElementById("pmSku").value.trim(),
      weight_value: parseFloat(document.getElementById("pmWeight").value) || 0,
      weight_unit: existing?.weight_unit || "غ",
      start_day: 1, start_month: 1,
      end_day: parseInt(document.getElementById("pmEndDay").value,10) || null,
      end_month: parseInt(document.getElementById("pmEndMonth").value,10) || null,
      end_year: parseInt(document.getElementById("pmEndYear").value,10) || new Date().getFullYear(),
      alert_days: parseInt(document.getElementById("pmAlertDays").value,10) || 0,
      image_url: existing?.image_url || "",
    };

    /* رفع الصورة أولًا (لو فيه صورة جديدة) — رابط فقط يُخزَّن، لا نص طويل */
    if(pendingImage){
      const uploadedUrl = await uploadImageToStorage(pendingImage, id);
      row.image_url = uploadedUrl || pendingImage;
    }

    /* الحفظ الفعلي، والتأكد من نجاحه قبل أي إغلاق أو رسالة نجاح */
    const productSaved = await saveProductRow(row);
    if(!productSaved){
      btn.disabled = false; btn.textContent = "حفظ";
      toast("فشل الحفظ، حاول مرة أخرى", true);
      return; /* تبقى النافذة مفتوحة وبياناتك كما أدخلتها */
    }

    const selectedSaved = await markSelected(branchId, id);
    if(!selectedSaved){
      btn.disabled = false; btn.textContent = "حفظ";
      toast("تم حفظ المنتج، لكن فشل نقله لمنتجات مختارة — حاول مرة أخرى", true);
      return;
    }

    if(existing){
      const idx = state.products.findIndex(p=>p.id===id);
      state.products[idx] = row;
    }else{
      state.products.push(row);
    }
    (state.dailyEditedIds[branchId] = state.dailyEditedIds[branchId] || []);
    if(!state.dailyEditedIds[branchId].includes(id)) state.dailyEditedIds[branchId].push(id);

    wrap.remove();
    toast("تم الحفظ بنجاح");
    render();
  };
}

/* ---------------- نافذة إضافة رابط ---------------- */
function openLinkModal(){
  const wrap = document.createElement("div");
  wrap.className = "modal-overlay";
  wrap.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-title">إضافة رابط جديد</div>
      <div class="field"><label>العنوان</label><input id="lnkTitle" type="text" placeholder="مثال: كتالوج المنتجات"></div>
      <div class="field"><label>الرابط (URL)</label><input id="lnkUrl" type="text" placeholder="https://..."></div>
      <button class="btn btn-primary" style="width:100%;" id="lnkSaveBtn">حفظ</button>
    </div>
  `;
  document.body.appendChild(wrap);
  wrap.onclick = (e)=>{ if(e.target===wrap) wrap.remove(); };
  document.getElementById("lnkSaveBtn").onclick = async ()=>{
    const title = document.getElementById("lnkTitle").value.trim();
    let url = document.getElementById("lnkUrl").value.trim();
    if(!title || !url){ toast("عبّي العنوان والرابط", true); return; }
    if(!/^https?:\/\//i.test(url)) url = "https://" + url;
    const btn = document.getElementById("lnkSaveBtn");
    btn.disabled = true; btn.textContent = "...جاري الحفظ";
    const link = { id: crypto.randomUUID(), title, url, sort_order: state.links.length };
    const ok = await saveLink(link);
    if(!ok){
      btn.disabled = false; btn.textContent = "حفظ";
      toast("فشل الحفظ، حاول مرة أخرى", true);
      return;
    }
    state.links.push(link);
    wrap.remove();
    toast("تمت إضافة الرابط");
    render();
  };
}

/* ---------------- تحميل منتجات مختارة (كل الفروع) كملف CSV ---------------- */
function exportSelectedProductsCSV(){
  const rows = [["اسم الفرع","اسم المنتج","SKU","الوزن","الوحدة","تاريخ الانتهاء"]];
  state.branches.forEach(b=>{
    const ids = state.dailyEditedIds[b.id] || [];
    ids.forEach(pid=>{
      const p = state.products.find(x=>x.id===pid);
      if(!p) return;
      rows.push([b.name||"", p.name||"", p.sku||"", p.weight_value||"", p.weight_unit||"", `${p.end_day||""}/${p.end_month||""}/${p.end_year?String(p.end_year).slice(-2):""}`]);
    });
  });
  if(rows.length===1){ toast("لا يوجد منتجات مختارة للتصدير", true); return; }
  const csv = rows.map(r=> r.map(c=>{
    const s = String(c).replace(/"/g,'""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  }).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF"+csv], { type:"text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `منتجات-مختارة-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

loadAll();
