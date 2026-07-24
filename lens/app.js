(() => {
  const PAGE_SIZE = 30;
  const SESSION_KEY = "lei_lens_session_v1";

  const state = {
    rows: [],
    filtered: [],
    mode: "fuzzy",
    query: "",
    page: 1,
    bundle: null,
    filters: { brand: "", catalogGroup: "", family: "", series: "", refractiveIndex: "", coating: "", supplyType: "" }
  };

  const $ = (selector) => document.querySelector(selector);
  const loginView = $("#loginView");
  const catalogView = $("#catalogView");
  const loginForm = $("#loginForm");
  const loginError = $("#loginError");
  const loginButton = $("#loginButton");
  const resultRows = $("#resultRows");
  const money = (value) => value === null || value === undefined || value === "" ? "—" : `¥${Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
  const clean = (value) => String(value ?? "").trim();
  const normalize = (value) => clean(value).normalize("NFKC").toLowerCase()
    .replace(/[()（）[\]【】]/g, "").replace(/[\s\-_.\/·、，,]+/g, "");
  const escapeHtml = (value) => clean(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
  const fromB64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  const toB64 = (value) => btoa(String.fromCharCode(...new Uint8Array(value)));

  const ALIASES = {
    "铂金": ["铂金", "钻立方铂金膜"], "鎏金": ["鎏金", "钻立方鎏金膜"],
    "防蓝": ["防蓝", "防蓝光", "防蓝光膜", "防蓝光plus"], "变色": ["变色", "焕色视界", "全视线"],
    "青控": ["青控", "近视防控", "近视管理", "小乐圆", "成长", "星趣控"], "太阳": ["太阳", "户外", "偏光", "染色"],
    "办公": ["办公", "室内", "数码型"], "爱赞": ["爱赞", "爱赞全晰", "视觉舒缓"],
    "渐进": ["渐进", "成人视力调节", "万里路"], "拓刻": ["拓刻", "伊藤拓刻", "伊藤"],
    "朝日": ["朝日", "朝日富士", "富士"], "柯达": ["柯达", "kodak", "kn", "k3", "k5", "柯学佳", "柯学控"],
    "万新": ["万新", "wanxin", "赛乐", "易百分", "都市max", "睿思", "万阅"],
    "东海": ["东海", "tokai", "瓅晶", "绚晶", "ltn", "neuro select", "active age"],
    "尼康": ["尼康", "nikon", "控优点", "小尼护眼", "尼傲", "智妍", "尊世", "尊睿", "尊耀"],
    "爱眼汇": ["爱眼汇", "同座的你", "星空蓝", "爱眼乐", "aiyanhui"],
    "缓控": ["缓控", "优乐控", "近视管理"], "超非": ["超非", "超非球面"],
    "双非": ["双非", "fz", "双面非球面"], "内非": ["内非", "acro", "内面非球面"],
    "护光": ["护光", "护光盾", "triguard"]
  };

  const facetValues = (rows, key) => {
    const counts = new Map();
    rows.forEach((row) => {
      const value = clean(row[key]);
      if (value) counts.set(value, (counts.get(value) || 0) + 1);
    });
    return [...counts.entries()].map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "zh-CN"));
  };

  function showLogin(message = "") {
    catalogView.hidden = true;
    loginView.hidden = false;
    loginError.textContent = message;
    state.rows = [];
  }

  function showCatalog(phone, rows) {
    loginView.hidden = true;
    catalogView.hidden = false;
    $("#currentUser").textContent = phone ? `${phone.slice(0,3)}****${phone.slice(-4)}` : "已登录";
    rows.forEach((row) => { row.search_text = Object.values(row).filter((value) => value !== null).join(" "); });
    state.rows = rows;
    $("#catalogSummary").textContent = `已整理 ${rows.length.toLocaleString("zh-CN")} 个在售产品变体，成本数据仅向已登录员工开放。`;
    $("#loadingState").textContent = "";
    refreshBrandOptions();
    refreshGroupOptions();
    refreshSelects();
    applyFilters();
  }

  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  async function deriveKey(phone, password, salt, iterations) {
    const material = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(`${phone}:${password}`), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: fromB64(salt), iterations },
      material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
    );
  }

  async function decryptAes(key, encrypted) {
    return crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(encrypted.iv), tagLength: 128 },
      key, fromB64(encrypted.data)
    );
  }

  async function loadBundle() {
    if (state.bundle) return state.bundle;
    const response = await fetch("./catalog.enc.json", { cache: "no-store" });
    if (!response.ok) throw new Error("PRICE_ARCHIVE_UNAVAILABLE");
    state.bundle = await response.json();
    return state.bundle;
  }

  async function openCatalog(masterKeyBytes) {
    const key = await crypto.subtle.importKey("raw", masterKeyBytes, "AES-GCM", false, ["decrypt"]);
    const plaintext = await decryptAes(key, state.bundle.catalog);
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  async function signIn(phone, password) {
    const bundle = await loadBundle();
    const id = await sha256Hex(`lei-lens-id-v1:${phone}`);
    const user = bundle.users.find((item) => item.id === id);
    if (!user) throw new Error("INVALID_LOGIN");
    const wrappingKey = await deriveKey(phone, password, user.salt, bundle.iterations);
    const masterKey = await decryptAes(wrappingKey, user);
    const catalog = await openCatalog(masterKey);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ phone, masterKey: toB64(masterKey) }));
    return catalog.products;
  }

  function buttonHtml(value, count, selected, allLabel = "") {
    return `<button type="button" data-value="${escapeHtml(value)}" class="${selected ? "selected" : ""}" aria-pressed="${selected}">
      <span>${escapeHtml(value || allLabel)}</span><small>${count.toLocaleString("zh-CN")} 款</small>
    </button>`;
  }

  function refreshBrandOptions() {
    const options = facetValues(state.rows, "brand");
    $("#brandOptions").innerHTML = buttonHtml("", state.rows.length, !state.filters.brand, "全部品牌") +
      options.map((item) => buttonHtml(item.value, item.count, state.filters.brand === item.value)).join("");
    $("#brandOptions").querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        state.filters = { brand: button.dataset.value, catalogGroup: "", family: "", series: "", refractiveIndex: "", coating: "", supplyType: "" };
        state.page = 1;
        refreshBrandOptions();
        refreshGroupOptions();
        refreshSelects();
        applyFilters();
      });
    });
  }

  function brandScopedRows() {
    return state.filters.brand ? state.rows.filter((row) => row.brand === state.filters.brand) : state.rows;
  }

  function refreshGroupOptions() {
    const scoped = brandScopedRows();
    const options = facetValues(scoped, "catalog_group");
    $("#groupTitle").textContent = state.filters.brand ? `${state.filters.brand}产品体系` : "全部产品体系";
    $("#groupOptions").innerHTML = buttonHtml("", scoped.length, !state.filters.catalogGroup, "全部") +
      options.map((item) => buttonHtml(item.value, item.count, state.filters.catalogGroup === item.value)).join("");
    $("#groupOptions").querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        state.filters.catalogGroup = button.dataset.value;
        state.page = 1;
        refreshGroupOptions();
        refreshSelects();
        applyFilters();
      });
    });
  }

  const SELECTS = [
    ["familyFilter", "family", "全部家族"], ["seriesFilter", "series", "全部系列"],
    ["indexFilter", "refractive_index", "全部折射率"], ["coatingFilter", "coating", "全部膜层"],
    ["supplyFilter", "supply_type", "全部供货方式"]
  ];

  function refreshSelects() {
    const scoped = brandScopedRows().filter((row) => !state.filters.catalogGroup || row.catalog_group === state.filters.catalogGroup);
    SELECTS.forEach(([id, key, label]) => {
      const select = $(`#${id}`);
      const filterKey = key === "refractive_index" ? "refractiveIndex" : key === "supply_type" ? "supplyType" : key;
      const current = state.filters[filterKey];
      select.innerHTML = `<option value="">${label}</option>` + facetValues(scoped, key)
        .map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.value)}（${item.count}）</option>`).join("");
      select.value = current;
    });
  }

  function queryMatches(row) {
    if (!state.query) return true;
    const query = normalize(state.query);
    if (state.mode === "exact") return [row.sku, row.model, row.display_name].map(normalize).includes(query);
    const tokens = state.query.trim().split(/\s+/).filter(Boolean);
    const haystack = normalize(row.search_text);
    return tokens.every((token) => {
      const alias = ALIASES[token] || [token];
      return alias.some((candidate) => haystack.includes(normalize(candidate)));
    });
  }

  function applyFilters() {
    state.filtered = state.rows.filter((row) =>
      (!state.filters.brand || row.brand === state.filters.brand) &&
      (!state.filters.catalogGroup || row.catalog_group === state.filters.catalogGroup) &&
      (!state.filters.family || row.family === state.filters.family) &&
      (!state.filters.series || row.series === state.filters.series) &&
      (!state.filters.refractiveIndex || row.refractive_index === state.filters.refractiveIndex) &&
      (!state.filters.coating || row.coating === state.filters.coating) &&
      (!state.filters.supplyType || row.supply_type === state.filters.supplyType) &&
      queryMatches(row)
    );
    const activeCount = Object.values(state.filters).filter(Boolean).length;
    $("#filterCount").textContent = activeCount;
    $("#resultSummary").textContent = `共 ${state.filtered.length.toLocaleString("zh-CN")} 个产品`;
    renderRows();
  }

  function renderRows() {
    const pageCount = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
    state.page = Math.min(state.page, pageCount);
    const start = (state.page - 1) * PAGE_SIZE;
    const pageRows = state.filtered.slice(start, start + PAGE_SIZE);
    resultRows.innerHTML = pageRows.map((row) => `<tr>
      <td class="brand-cell" data-label="品牌"><b>${escapeHtml(row.brand)}</b></td>
      <td class="product-cell" data-label="产品"><strong>${escapeHtml(row.display_name)}</strong><small>${escapeHtml(row.model || row.sku)}</small></td>
      <td data-label="折射率">${escapeHtml(row.refractive_index || "—")}</td>
      <td data-label="设计 / 供货">${escapeHtml([row.lens_design,row.supply_type].filter(Boolean).join(" · ") || "—")}</td>
      <td data-label="膜层">${escapeHtml(row.coating || "—")}</td>
      <td class="money" data-label="批发价">${money(row.wholesale_price)}</td>
      <td class="money cost-cell" data-label="成本价">${money(row.cost_price)}</td>
      <td class="money" data-label="建议零售价">${money(row.retail_price)}</td>
    </tr>`).join("");
    $("#emptyState").hidden = pageRows.length > 0;
    renderPagination(pageCount);
  }

  function renderPagination(pageCount) {
    const nav = $("#pagination");
    if (pageCount <= 1) { nav.innerHTML = ""; return; }
    const pages = new Set([1, pageCount, state.page - 1, state.page, state.page + 1].filter((page) => page >= 1 && page <= pageCount));
    const sorted = [...pages].sort((a,b) => a-b);
    let previous = 0;
    const middle = sorted.map((page) => {
      const gap = page - previous > 1 ? `<span>…</span>` : "";
      previous = page;
      return `${gap}<button type="button" data-page="${page}" class="${page === state.page ? "selected" : ""}">${page}</button>`;
    }).join("");
    nav.innerHTML = `<button type="button" data-page="${state.page - 1}" ${state.page === 1 ? "disabled" : ""}>‹</button>${middle}
      <button type="button" data-page="${state.page + 1}" ${state.page === pageCount ? "disabled" : ""}>›</button>`;
    nav.querySelectorAll("button:not(:disabled)").forEach((button) => button.addEventListener("click", () => {
      state.page = Number(button.dataset.page);
      renderRows();
      $(".result-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const phone = $("#phoneInput").value.replace(/\D/g, "");
    const password = $("#passwordInput").value;
    if (!/^1[3-9]\d{9}$/.test(phone)) { loginError.textContent = "请输入正确的11位手机号"; return; }
    loginButton.disabled = true;
    loginButton.textContent = "正在验证…";
    loginError.textContent = "";
    try {
      const rows = await signIn(phone, password);
      showCatalog(phone, rows);
    } catch (error) {
      console.error(error);
      loginError.textContent = error.message === "PRICE_ARCHIVE_UNAVAILABLE"
        ? "价格档案暂时无法读取，请检查网络后重试"
        : "手机号或密码不正确，请联系管理员确认账号";
    } finally {
      loginButton.disabled = false;
      loginButton.textContent = "进入价格档案";
    }
  });

  $("#logoutButton").addEventListener("click", () => { sessionStorage.removeItem(SESSION_KEY); showLogin(); });
  document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    document.querySelectorAll("[data-mode]").forEach((item) => item.classList.toggle("selected", item === button));
    $("#searchGuidance").textContent = state.mode === "fuzzy"
      ? "多个关键词会组合匹配品牌、名称、系列、膜层、使用场景与型号。"
      : "精准模式只匹配完整 SKU、完整型号或完整产品名称。";
    state.page = 1;
    applyFilters();
  }));
  const submitSearch = () => { state.query = $("#searchInput").value.trim(); state.page = 1; applyFilters(); };
  $("#searchButton").addEventListener("click", submitSearch);
  $("#searchInput").addEventListener("keydown", (event) => { if (event.key === "Enter") submitSearch(); });
  $("#filterToggle").addEventListener("click", () => { $("#filterPanel").hidden = !$("#filterPanel").hidden; });
  $("#resetFilters").addEventListener("click", () => {
    state.filters = { brand: "", catalogGroup: "", family: "", series: "", refractiveIndex: "", coating: "", supplyType: "" };
    state.query = "";
    $("#searchInput").value = "";
    state.page = 1;
    refreshBrandOptions(); refreshGroupOptions(); refreshSelects(); applyFilters();
  });
  SELECTS.forEach(([id, key]) => $(`#${id}`).addEventListener("change", (event) => {
    const filterKey = key === "refractive_index" ? "refractiveIndex" : key === "supply_type" ? "supplyType" : key;
    state.filters[filterKey] = event.target.value;
    state.page = 1;
    applyFilters();
  }));

  (async () => {
    try {
      await loadBundle();
      const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
      if (!saved?.phone || !saved?.masterKey) { showLogin(); return; }
      const catalog = await openCatalog(fromB64(saved.masterKey));
      showCatalog(saved.phone, catalog.products);
    } catch (error) {
      console.error(error);
      sessionStorage.removeItem(SESSION_KEY);
      showLogin(error.message === "PRICE_ARCHIVE_UNAVAILABLE" ? "价格档案暂时无法读取，请检查网络后重试" : "");
    }
  })();
})();
