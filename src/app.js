/**
 * @typedef {{ id: string; name: string; createdAt: string }} User
 * @typedef {{ id: string; type: "addition"; rowNumbers: number[]; colNumbers: number[]; answers: number[][]; createdAt: string }} ProblemSheet
 * @typedef {{ startedAt: string; finishedAt: string; elapsedMs: number }} TimerResult
 * @typedef {{ digit: number | null; confidence: number }} DigitPrediction
 * @typedef {{ rawText: string; value: number | null; confidence: number; digitPredictions: DigitPrediction[] }} CellPrediction
 * @typedef {{ x: number; y: number; expected: number; actual: number | null; isCorrect: boolean; needsReview: boolean; confidence: number; imageDataUrl?: string }} CellGrade
 * @typedef {{ id: string; userId: string; sheetId: string; problemType: "addition"; createdAt: string; elapsedMs: number | null; totalCount: number; correctCount: number; wrongCount: number; reviewCount: number; accuracy: number; cells: CellGrade[] }} PracticeResult
 */

const DB_NAME = "math100-mvp";
const DB_VERSION = 1;
const CONFIDENCE_THRESHOLD = 0.75;

const app = document.querySelector("#app");

const state = {
  view: "home",
  users: [],
  selectedUserId: "",
  currentSheet: null,
  answerInputs: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "")),
  timer: {
    startedAt: null,
    finishedAt: null,
    elapsedBeforeRun: 0,
    running: false,
    displayMs: 0,
    tickId: null
  },
  results: [],
  scan: {
    image: null,
    sourceCanvas: null,
    processedCanvas: null,
    markers: null,
    cells: [],
    message: "画像を読み込んでください。"
  },
  review: {
    cells: [],
    resultId: null
  },
  printImageCache: {
    key: "",
    dataUrl: ""
  },
  modalCell: null
};

const icons = {
  home: "⌂",
  sheet: "▦",
  timer: "◷",
  scan: "▣",
  history: "↗",
  settings: "⚙"
};

let dbPromise;

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function shuffledNumbersOneToNineWithDuplicate() {
  const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  numbers.push(1 + Math.floor(Math.random() * 9));
  for (let i = numbers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
  }
  return numbers;
}

function formatDate(iso) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(iso));
}

function formatMs(ms) {
  if (ms == null) return "-";
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const tenths = Math.floor((ms % 1000) / 100);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("users")) db.createObjectStore("users", { keyPath: "id" });
      if (!db.objectStoreNames.contains("sheets")) db.createObjectStore("sheets", { keyPath: "id" });
      if (!db.objectStoreNames.contains("results")) {
        const store = db.createObjectStore("results", { keyPath: "id" });
        store.createIndex("userId", "userId");
        store.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const value = action(store);
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = () => reject(transaction.error);
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAll(storeName) {
  const db = await openDb();
  return requestToPromise(db.transaction(storeName).objectStore(storeName).getAll());
}

async function put(storeName, item) {
  await tx(storeName, "readwrite", (store) => store.put(item));
}

async function remove(storeName, id) {
  await tx(storeName, "readwrite", (store) => store.delete(id));
}

async function loadState() {
  state.users = (await getAll("users")).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  state.results = (await getAll("results")).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  state.selectedUserId = localStorage.getItem("math100.selectedUserId") || state.users[0]?.id || "";
  if (!state.users.some((user) => user.id === state.selectedUserId)) {
    state.selectedUserId = state.users[0]?.id || "";
  }
  const savedSheet = localStorage.getItem("math100.currentSheet");
  if (savedSheet) {
    try {
      state.currentSheet = JSON.parse(savedSheet);
    } catch {
      state.currentSheet = null;
    }
  }
}

function selectedUser() {
  return state.users.find((user) => user.id === state.selectedUserId) || null;
}

function generateProblem() {
  const rowNumbers = shuffledNumbersOneToNineWithDuplicate();
  const colNumbers = shuffledNumbersOneToNineWithDuplicate();
  const answers = rowNumbers.map((row) => colNumbers.map((col) => row + col));
  const sheet = {
    id: uid("sheet"),
    type: "addition",
    rowNumbers,
    colNumbers,
    answers,
    createdAt: nowIso()
  };
  state.currentSheet = sheet;
  state.answerInputs = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => ""));
  state.review = { cells: [], resultId: null };
  localStorage.setItem("math100.currentSheet", JSON.stringify(sheet));
  put("sheets", sheet);
  setView("problem");
}

function gradeManualInputs() {
  if (!state.currentSheet) return [];
  return state.currentSheet.answers.flatMap((row, y) =>
    row.map((expected, x) => {
      const raw = state.answerInputs[y][x].trim();
      const actual = raw === "" ? null : Number(raw);
      const valid = Number.isInteger(actual) && actual >= 0 && actual <= 18;
      return {
        x,
        y,
        expected,
        actual: valid ? actual : null,
        isCorrect: valid && actual === expected,
        needsReview: raw === "" || !valid,
        confidence: valid ? 1 : 0
      };
    })
  );
}

function summarizeCells(cells) {
  const totalCount = cells.length;
  const correctCount = cells.filter((cell) => cell.isCorrect).length;
  const reviewCount = cells.filter((cell) => cell.needsReview).length;
  const wrongCount = totalCount - correctCount - reviewCount;
  const accuracy = totalCount ? Math.round((correctCount / totalCount) * 1000) / 10 : 0;
  return { totalCount, correctCount, wrongCount, reviewCount, accuracy };
}

async function saveResult(cells, elapsedMs = state.timer.displayMs || null) {
  if (!state.currentSheet || !state.selectedUserId) return null;
  const summary = summarizeCells(cells);
  const result = {
    id: state.review.resultId || uid("result"),
    userId: state.selectedUserId,
    sheetId: state.currentSheet.id,
    problemType: "addition",
    createdAt: nowIso(),
    elapsedMs,
    ...summary,
    cells
  };
  await put("results", result);
  state.results = (await getAll("results")).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  state.review.resultId = result.id;
  return result;
}

function startTimer() {
  if (state.timer.running) return;
  state.timer.startedAt = state.timer.startedAt || nowIso();
  state.timer.running = true;
  const started = performance.now();
  const base = state.timer.elapsedBeforeRun;
  state.timer.tickId = window.setInterval(() => {
    state.timer.displayMs = base + (performance.now() - started);
    updateTimerOnly();
  }, 100);
}

function stopTimer() {
  if (!state.timer.running) return;
  window.clearInterval(state.timer.tickId);
  state.timer.elapsedBeforeRun = state.timer.displayMs;
  state.timer.running = false;
  state.timer.finishedAt = nowIso();
  render();
}

function resetTimer() {
  window.clearInterval(state.timer.tickId);
  state.timer = {
    startedAt: null,
    finishedAt: null,
    elapsedBeforeRun: 0,
    running: false,
    displayMs: 0,
    tickId: null
  };
  render();
}

function updateTimerOnly() {
  const display = document.querySelector("[data-timer-display]");
  if (display) display.textContent = formatMs(state.timer.displayMs);
}

function setView(view) {
  state.view = view;
  state.modalCell = null;
  render();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function render() {
  app.innerHTML = `
    <div class="app-shell">
      ${renderTopbar()}
      <main class="content">${renderView()}</main>
      ${renderBottomNav()}
      <div class="sheet-zone">${state.currentSheet ? renderPrintableSheet() : ""}</div>
      ${state.modalCell ? renderCellModal(state.modalCell) : ""}
    </div>
  `;
  bindEvents();
  drawCharts();
}

function renderTopbar() {
  const userOptions = state.users
    .map((user) => `<option value="${user.id}" ${user.id === state.selectedUserId ? "selected" : ""}>${escapeHtml(user.name)}</option>`)
    .join("");
  return `
    <header class="topbar">
      <div class="brand"><span class="brand-mark">百</span><span>百ます計算</span></div>
      <div class="top-actions">
        <select data-select-user aria-label="ユーザー選択">
          <option value="">ユーザー未選択</option>
          ${userOptions}
        </select>
      </div>
    </header>
  `;
}

function renderBottomNav() {
  const items = [
    ["home", "ホーム", icons.home],
    ["problem", "問題", icons.sheet],
    ["practice", "練習", icons.timer],
    ["scan", "撮影", icons.scan],
    ["history", "履歴", icons.history]
  ];
  return `
    <nav class="bottom-nav">
      ${items
        .map(
          ([view, label, icon]) => `
            <button data-view="${view}" class="${state.view === view ? "active" : ""}" aria-label="${label}">
              <span class="nav-icon">${icon}</span>
              <span class="nav-label">${label}</span>
            </button>
          `
        )
        .join("")}
    </nav>
  `;
}

function renderView() {
  switch (state.view) {
    case "problem":
      return renderProblemPage();
    case "practice":
      return renderPracticePage();
    case "scan":
      return renderScanPage();
    case "review":
      return renderReviewPage();
    case "history":
      return renderHistoryPage();
    case "settings":
      return renderSettingsPage();
    default:
      return renderHomePage();
  }
}

function renderHomePage() {
  const user = selectedUser();
  const recent = filteredResults().slice(0, 3);
  return `
    <section class="hero">
      <div class="panel">
        <div class="section-head">
          <div>
            <h1>印刷して、解いて、採点まで。</h1>
            <div class="muted">10x10足し算のMVPです。記録はこの端末だけに保存されます。</div>
          </div>
          <button class="primary" data-generate>新しい問題</button>
        </div>
        ${user ? `<div class="muted">現在のユーザー: ${escapeHtml(user.name)}</div>` : `<div class="empty">まずユーザーを追加してください。</div>`}
      </div>
      <div class="grid-3">
        <button class="panel stack" data-view="problem"><strong>問題生成・印刷</strong><span class="muted">A4固定レイアウト</span></button>
        <button class="panel stack" data-view="practice"><strong>タイマー・手動採点</strong><span class="muted">100問を入力して採点</span></button>
        <button class="panel stack" data-view="scan"><strong>撮影採点</strong><span class="muted">セル切り出しと確認</span></button>
      </div>
      <div class="grid-2">
        <section class="panel">
          <div class="section-head">
            <h2>ユーザー</h2>
            <button data-view="settings">管理</button>
          </div>
          ${renderUserList(false)}
        </section>
        <section class="panel">
          <div class="section-head">
            <h2>最近の記録</h2>
            <button data-view="history">見る</button>
          </div>
          ${recent.length ? recent.map(renderHistoryRow).join("") : `<div class="empty">まだ記録がありません。</div>`}
        </section>
      </div>
    </section>
  `;
}

function renderProblemPage() {
  return `
    <section class="stack">
      <div class="panel">
        <div class="section-head">
          <div>
            <h1>問題生成</h1>
            <div class="muted">足し算のみ、数字は1〜9、答えは2〜18です。</div>
          </div>
          <button class="primary" data-generate>生成</button>
        </div>
        ${state.currentSheet ? renderProblemSummary() : `<div class="empty">新しい問題を生成してください。</div>`}
      </div>
      ${state.currentSheet ? `<section class="panel stack"><h2>印刷画像</h2>${renderPrintableImage("preview")}</section>` : ""}
      ${state.currentSheet ? `<section class="panel">${renderProblemGrid(false)}</section>` : ""}
    </section>
  `;
}

function renderProblemSummary() {
  return `
    <div class="grid-3">
      <div class="stat"><div class="muted small">sheetId</div><div>${state.currentSheet.id}</div></div>
      <div class="stat"><div class="muted small">作成</div><div>${formatDate(state.currentSheet.createdAt)}</div></div>
      <div class="stat row">
        <button class="primary" data-print>印刷</button>
        <button data-view="practice">練習へ</button>
      </div>
    </div>
  `;
}

function renderPracticePage() {
  if (!state.currentSheet) {
    return `
      <section class="panel stack">
        <h1>練習</h1>
        <div class="empty">先に問題を生成してください。</div>
        <button class="primary" data-generate>新しい問題</button>
      </section>
    `;
  }
  const cells = gradeManualInputs();
  const summary = summarizeCells(cells);
  return `
    <section class="stack">
      <div class="panel">
        <div class="section-head">
          <div>
            <h1>練習</h1>
            <div class="muted">タイマーを止めたあとでも入力と採点ができます。</div>
          </div>
          <div class="timer-display" data-timer-display>${formatMs(state.timer.displayMs)}</div>
        </div>
        <div class="row">
          <button class="primary" data-timer-start ${state.timer.running ? "disabled" : ""}>開始</button>
          <button data-timer-stop ${!state.timer.running ? "disabled" : ""}>停止</button>
          <button data-timer-reset>リセット</button>
          <button data-manual-save>採点して保存</button>
        </div>
      </div>
      <div class="grid-3">
        <div class="stat"><div class="muted small">正解</div><div class="stat-value">${summary.correctCount}</div></div>
        <div class="stat"><div class="muted small">ミス</div><div class="stat-value">${summary.wrongCount}</div></div>
        <div class="stat"><div class="muted small">要確認</div><div class="stat-value">${summary.reviewCount}</div></div>
      </div>
      <section class="panel">${renderProblemGrid(true, cells)}</section>
    </section>
  `;
}

function renderProblemGrid(editable, grades = []) {
  if (!state.currentSheet) return "";
  const gradeMap = new Map(grades.map((grade) => [`${grade.x},${grade.y}`, grade]));
  const nodes = [`<div class="problem-cell corner">＋</div>`];
  state.currentSheet.colNumbers.forEach((number) => nodes.push(`<div class="problem-cell header">${number}</div>`));
  state.currentSheet.rowNumbers.forEach((rowNumber, y) => {
    nodes.push(`<div class="problem-cell header">${rowNumber}</div>`);
    state.currentSheet.colNumbers.forEach((_, x) => {
      if (editable) {
        const grade = gradeMap.get(`${x},${y}`);
        const klass = grade?.needsReview ? "review" : grade?.isCorrect ? "correct" : grade?.actual != null ? "wrong" : "";
        nodes.push(`
          <div class="problem-cell">
            <input class="answer-input ${klass}" data-answer-input data-x="${x}" data-y="${y}" inputmode="numeric" maxlength="2" value="${escapeHtml(state.answerInputs[y][x])}" />
          </div>
        `);
      } else {
        nodes.push(`<div class="problem-cell"></div>`);
      }
    });
  });
  return `<div class="problem-wrap"><div class="problem-grid">${nodes.join("")}</div></div>`;
}

function renderPrintableSheet() {
  const sheet = state.currentSheet;
  if (!sheet) return "";
  return `
    <section class="print-page">
      ${renderPrintableImage("print")}
    </section>
  `;
}

function renderPrintableImage(kind) {
  const dataUrl = getPrintableSheetImageDataUrl();
  const alt = "百ます計算の印刷用紙画像";
  const download = state.currentSheet ? `math100-${state.currentSheet.id}.png` : "math100-sheet.png";
  if (kind === "preview") {
    return `
      <div class="print-image-preview">
        <img class="print-image" alt="${alt}" src="${dataUrl}" />
      </div>
      <div class="row">
        <a class="download-button" href="${dataUrl}" download="${download}">画像を保存</a>
        <button class="primary" data-print>この画像を印刷</button>
      </div>
    `;
  }
  return `<img class="print-image print-image-page" alt="${alt}" src="${dataUrl}" />`;
}

function getPrintableSheetImageDataUrl() {
  const sheet = state.currentSheet;
  if (!sheet) return "";
  const user = selectedUser();
  const cacheKey = JSON.stringify({
    id: sheet.id,
    userName: user?.name || "",
    rowNumbers: sheet.rowNumbers,
    colNumbers: sheet.colNumbers
  });
  if (state.printImageCache.key === cacheKey) return state.printImageCache.dataUrl;

  const canvas = document.createElement("canvas");
  canvas.width = 2480;
  canvas.height = 3508;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  ctx.strokeStyle = "#000000";
  ctx.lineCap = "square";
  ctx.lineJoin = "miter";

  ctx.font = "700 92px system-ui, sans-serif";
  ctx.fillText("百ます計算（足し算）", 190, 210);
  ctx.font = "42px system-ui, sans-serif";
  ctx.fillText("たての数字 + よこの数字を書きましょう", 190, 285);
  ctx.textAlign = "right";
  ctx.fillText(new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium" }).format(new Date(sheet.createdAt)), 2290, 210);
  ctx.fillText("10 x 10", 2290, 275);
  ctx.textAlign = "left";

  ctx.font = "48px system-ui, sans-serif";
  ctx.fillText("なまえ", 190, 430);
  ctx.fillText(user?.name || "", 380, 430);
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(360, 448);
  ctx.lineTo(1120, 448);
  ctx.stroke();
  ctx.fillText("タイム", 1280, 430);
  ctx.beginPath();
  ctx.moveTo(1460, 448);
  ctx.lineTo(2290, 448);
  ctx.stroke();

  const gridX = 240;
  const gridY = 585;
  const gridSize = 2002;
  const cell = gridSize / 11;
  const marker = 96;
  ctx.fillStyle = "#000000";
  ctx.fillRect(gridX - marker / 2, gridY - marker / 2, marker, marker);
  ctx.fillRect(gridX + gridSize - marker / 2, gridY - marker / 2, marker, marker);
  ctx.fillRect(gridX - marker / 2, gridY + gridSize - marker / 2, marker, marker);
  ctx.fillRect(gridX + gridSize - marker / 2, gridY + gridSize - marker / 2, marker, marker);

  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 10;
  ctx.strokeRect(gridX, gridY, gridSize, gridSize);
  ctx.lineWidth = 4;
  for (let i = 1; i < 11; i++) {
    const p = Math.round(gridX + cell * i) + 0.5;
    ctx.beginPath();
    ctx.moveTo(p, gridY);
    ctx.lineTo(p, gridY + gridSize);
    ctx.stroke();
    const q = Math.round(gridY + cell * i) + 0.5;
    ctx.beginPath();
    ctx.moveTo(gridX, q);
    ctx.lineTo(gridX + gridSize, q);
    ctx.stroke();
  }

  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "800 86px system-ui, sans-serif";
  ctx.fillText("+", gridX + cell / 2, gridY + cell / 2);
  sheet.colNumbers.forEach((number, x) => {
    ctx.fillText(String(number), gridX + cell * (x + 1.5), gridY + cell / 2);
  });
  sheet.rowNumbers.forEach((number, y) => {
    ctx.fillText(String(number), gridX + cell / 2, gridY + cell * (y + 1.5));
  });

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = "30px system-ui, sans-serif";
  ctx.fillText(`sheetId: ${sheet.id}`, 190, 2725);
  ctx.font = "28px system-ui, sans-serif";
  ctx.fillText("四隅の黒いマーカーと太い外枠は撮影補正用です。", 190, 2780);

  state.printImageCache = { key: cacheKey, dataUrl: canvas.toDataURL("image/png") };
  return state.printImageCache.dataUrl;
}

function renderScanPage() {
  if (!state.currentSheet) {
    return `
      <section class="panel stack">
        <h1>撮影採点</h1>
        <div class="empty">先に問題を生成してください。印刷した用紙のsheetIdと現在の問題が一致している前提で採点します。</div>
        <button class="primary" data-generate>新しい問題</button>
      </section>
    `;
  }
  return `
    <section class="stack">
      <div class="panel">
        <div class="section-head">
          <div>
            <h1>撮影採点</h1>
            <div class="muted">アプリ生成の用紙だけに対応します。斜めが強い場合は再撮影してください。</div>
          </div>
        </div>
        <div class="row">
          <label class="button-like">
            <input type="file" accept="image/*" capture="environment" data-camera-input hidden />
            <button type="button" data-trigger-camera>撮影する</button>
          </label>
          <label class="button-like">
            <input type="file" accept="image/*" data-file-input hidden />
            <button type="button" data-trigger-file>画像を選択</button>
          </label>
          <button data-correct-image ${state.scan.sourceCanvas ? "" : "disabled"}>補正する</button>
          <button class="primary" data-grade-scan ${state.scan.processedCanvas ? "" : "disabled"}>採点する</button>
          <button data-reset-scan>やり直す</button>
        </div>
        <div class="muted small">${escapeHtml(state.scan.message)}</div>
      </div>
      <div class="scan-layout">
        <section class="panel stack">
          <h2>プレビュー</h2>
          <canvas class="preview-canvas" data-preview-canvas width="900" height="1200"></canvas>
        </section>
        <section class="panel stack">
          <h2>切り出しセル</h2>
          ${state.scan.cells.length ? renderCellStrip() : `<div class="empty">補正後に100セルを切り出します。</div>`}
        </section>
      </div>
    </section>
  `;
}

function renderCellStrip() {
  return `
    <div class="cell-strip">
      ${state.scan.cells.map((cell) => `<div class="cell-thumb"><img alt="cell ${cell.x + 1},${cell.y + 1}" src="${cell.dataUrl}" /></div>`).join("")}
    </div>
  `;
}

function renderReviewPage() {
  if (!state.review.cells.length) {
    return `
      <section class="panel stack">
        <h1>採点結果</h1>
        <div class="empty">手動採点するか、撮影画像を採点してください。</div>
        <div class="row"><button data-view="practice">手動採点</button><button data-view="scan">撮影へ</button></div>
      </section>
    `;
  }
  const summary = summarizeCells(state.review.cells);
  return `
    <section class="stack">
      <div class="panel">
        <div class="section-head">
          <div>
            <h1>採点結果</h1>
            <div class="muted">黄色のセルはタップして修正できます。</div>
          </div>
          <button class="primary" data-confirm-review>確定保存</button>
        </div>
        <div class="grid-3">
          <div class="stat"><div class="muted small">正答率</div><div class="stat-value">${summary.accuracy}%</div></div>
          <div class="stat"><div class="muted small">ミス</div><div class="stat-value">${summary.wrongCount}</div></div>
          <div class="stat"><div class="muted small">要確認</div><div class="stat-value">${summary.reviewCount}</div></div>
        </div>
      </div>
      <section class="panel">${renderReviewGrid()}</section>
    </section>
  `;
}

function renderReviewGrid() {
  const sheet = state.currentSheet;
  const map = new Map(state.review.cells.map((cell) => [`${cell.x},${cell.y}`, cell]));
  const nodes = [`<div class="problem-cell corner">＋</div>`];
  sheet.colNumbers.forEach((number) => nodes.push(`<div class="problem-cell header">${number}</div>`));
  sheet.rowNumbers.forEach((rowNumber, y) => {
    nodes.push(`<div class="problem-cell header">${rowNumber}</div>`);
    sheet.colNumbers.forEach((_, x) => {
      const cell = map.get(`${x},${y}`);
      const klass = cell.needsReview ? "review" : cell.isCorrect ? "correct" : "wrong";
      const mark = cell.needsReview ? "?" : cell.isCorrect ? "○" : "×";
      nodes.push(`
        <button class="grade-cell ${klass}" data-open-cell="${x},${y}">
          <span class="grade-mark">${mark}</span>
          <span class="grade-value">${cell.actual ?? "-"} / ${cell.expected}</span>
        </button>
      `);
    });
  });
  return `<div class="problem-wrap"><div class="review-grid">${nodes.join("")}</div></div>`;
}

function renderCellModal(cell) {
  return `
    <div class="modal-backdrop" data-close-modal>
      <div class="modal stack" role="dialog" aria-modal="true" data-modal-panel>
        <div class="section-head">
          <h2>${cell.y + 1}行 ${cell.x + 1}列</h2>
          <button class="icon" data-close-modal-button aria-label="閉じる">×</button>
        </div>
        ${cell.imageDataUrl ? `<img alt="切り出し画像" src="${cell.imageDataUrl}" />` : ""}
        <div class="grid-3">
          <div class="stat"><div class="muted small">正解</div><div class="stat-value">${cell.expected}</div></div>
          <div class="stat"><div class="muted small">認識</div><div class="stat-value">${cell.actual ?? "-"}</div></div>
          <div class="stat"><div class="muted small">信頼度</div><div class="stat-value">${Math.round(cell.confidence * 100)}%</div></div>
        </div>
        <label class="stack">
          <span>実際の答え</span>
          <input data-modal-answer inputmode="numeric" maxlength="2" value="${cell.actual ?? ""}" />
        </label>
        <div class="row">
          <button class="primary" data-save-cell>修正</button>
          <button data-mark-blank>空欄にする</button>
        </div>
      </div>
    </div>
  `;
}

function renderHistoryPage() {
  const results = filteredResults();
  return `
    <section class="stack">
      <div class="panel">
        <div class="section-head">
          <div>
            <h1>履歴</h1>
            <div class="muted">ユーザー別の直近10回と全期間を見られます。</div>
          </div>
        </div>
        ${results.length ? renderHistoryStats(results) : `<div class="empty">まだ記録がありません。</div>`}
      </div>
      ${
        results.length
          ? `
        <div class="grid-3">
          <section class="panel stack"><h2>タイム推移</h2><canvas class="chart" data-chart="time"></canvas></section>
          <section class="panel stack"><h2>正答率推移</h2><canvas class="chart" data-chart="accuracy"></canvas></section>
          <section class="panel stack"><h2>ミス数推移</h2><canvas class="chart" data-chart="wrong"></canvas></section>
        </div>
        <section class="panel stack">
          <h2>一覧</h2>
          <div class="history-list">${results.map(renderHistoryRow).join("")}</div>
        </section>
      `
          : ""
      }
    </section>
  `;
}

function renderHistoryStats(results) {
  const latest = results[0];
  const bestTime = results.filter((r) => r.elapsedMs != null).reduce((best, r) => Math.min(best, r.elapsedMs), Infinity);
  const avgAccuracy = Math.round((results.reduce((sum, r) => sum + r.accuracy, 0) / results.length) * 10) / 10;
  return `
    <div class="grid-3">
      <div class="stat"><div class="muted small">最新タイム</div><div class="stat-value">${formatMs(latest.elapsedMs)}</div></div>
      <div class="stat"><div class="muted small">ベスト</div><div class="stat-value">${Number.isFinite(bestTime) ? formatMs(bestTime) : "-"}</div></div>
      <div class="stat"><div class="muted small">平均正答率</div><div class="stat-value">${avgAccuracy}%</div></div>
    </div>
  `;
}

function renderHistoryRow(result) {
  const user = state.users.find((item) => item.id === result.userId);
  return `
    <div class="history-row">
      <div>
        <strong>${formatDate(result.createdAt)}</strong>
        <div class="muted small">${escapeHtml(user?.name || "削除済みユーザー")} / 足し算 / ${formatMs(result.elapsedMs)}</div>
      </div>
      <div class="small">${result.accuracy}%・ミス${result.wrongCount}</div>
    </div>
  `;
}

function renderSettingsPage() {
  return `
    <section class="stack">
      <div class="panel">
        <div class="section-head"><h1>設定</h1></div>
        <form class="row" data-user-form>
          <input name="name" placeholder="子供の名前" required />
          <button class="primary">ユーザー追加</button>
        </form>
      </div>
      <section class="panel stack">
        <h2>ユーザー管理</h2>
        ${renderUserList(true)}
      </section>
      <section class="panel stack">
        <h2>モデル情報</h2>
        <div class="muted">ONNX Runtime Webと digit_classifier.onnx は未同梱です。現在は空欄検出と要確認フローで動作します。</div>
      </section>
      <section class="panel stack">
        <h2>データ削除</h2>
        <button class="danger" data-clear-results>履歴を削除</button>
      </section>
    </section>
  `;
}

function renderUserList(manage) {
  if (!state.users.length) return `<div class="empty">ユーザーがいません。</div>`;
  return `
    <div class="user-list">
      ${state.users
        .map(
          (user) => `
          <div class="user-row ${user.id === state.selectedUserId ? "selected" : ""}">
            <button data-pick-user="${user.id}">
              <strong>${escapeHtml(user.name)}</strong>
              <span class="muted small">${formatDate(user.createdAt)}</span>
            </button>
            ${manage ? `<button class="danger" data-delete-user="${user.id}">削除</button>` : ""}
          </div>
        `
        )
        .join("")}
    </div>
  `;
}

function filteredResults() {
  return state.results.filter((result) => !state.selectedUserId || result.userId === state.selectedUserId);
}

function drawCharts() {
  const charts = document.querySelectorAll("[data-chart]");
  if (!charts.length) return;
  const results = filteredResults().slice(0, 10).reverse();
  charts.forEach((canvas) => {
    const metric = canvas.dataset.chart;
    const values = results.map((result) => {
      if (metric === "time") return result.elapsedMs == null ? 0 : Math.round(result.elapsedMs / 1000);
      if (metric === "accuracy") return result.accuracy;
      return result.wrongCount;
    });
    drawLineChart(canvas, values, metric === "accuracy" ? "%" : metric === "time" ? "秒" : "問");
  });
}

function drawLineChart(canvas, values, unit) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(300, Math.floor(rect.width * dpr));
  canvas.height = Math.max(180, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#cbd5e1";
  ctx.lineWidth = 1;
  const pad = 34;
  ctx.beginPath();
  ctx.moveTo(pad, 16);
  ctx.lineTo(pad, h - pad);
  ctx.lineTo(w - 12, h - pad);
  ctx.stroke();
  if (!values.length) return;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(1, max - min);
  const points = values.map((value, index) => {
    const x = pad + ((w - pad - 20) * index) / Math.max(values.length - 1, 1);
    const y = h - pad - ((h - pad - 26) * (value - min)) / span;
    return { x, y, value };
  });
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 3;
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();
  ctx.fillStyle = "#f97316";
  points.forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = "#475569";
  ctx.font = "12px system-ui";
  ctx.fillText(`${max}${unit}`, 4, 22);
  ctx.fillText(`${min}${unit}`, 4, h - pad);
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
  document.querySelector("[data-generate]")?.addEventListener("click", generateProblem);
  document.querySelectorAll("[data-print]").forEach((button) => {
    button.addEventListener("click", () => window.print());
  });
  document.querySelector("[data-select-user]")?.addEventListener("change", async (event) => {
    state.selectedUserId = event.target.value;
    localStorage.setItem("math100.selectedUserId", state.selectedUserId);
    render();
  });
  document.querySelectorAll("[data-pick-user]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedUserId = button.dataset.pickUser;
      localStorage.setItem("math100.selectedUserId", state.selectedUserId);
      render();
    });
  });
  document.querySelector("[data-user-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "").trim();
    if (!name) return;
    const user = { id: uid("user"), name, createdAt: nowIso() };
    await put("users", user);
    state.users = (await getAll("users")).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    state.selectedUserId = user.id;
    localStorage.setItem("math100.selectedUserId", user.id);
    render();
  });
  document.querySelectorAll("[data-delete-user]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("このユーザーを削除します。履歴は残ります。")) return;
      await remove("users", button.dataset.deleteUser);
      state.users = (await getAll("users")).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      state.selectedUserId = state.users[0]?.id || "";
      localStorage.setItem("math100.selectedUserId", state.selectedUserId);
      render();
    });
  });
  document.querySelector("[data-clear-results]")?.addEventListener("click", async () => {
    if (!confirm("履歴をすべて削除します。")) return;
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const request = db.transaction("results", "readwrite").objectStore("results").clear();
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
    state.results = [];
    render();
  });
  document.querySelector("[data-timer-start]")?.addEventListener("click", startTimer);
  document.querySelector("[data-timer-stop]")?.addEventListener("click", stopTimer);
  document.querySelector("[data-timer-reset]")?.addEventListener("click", resetTimer);
  document.querySelectorAll("[data-answer-input]").forEach((input) => {
    input.addEventListener("input", (event) => {
      const x = Number(input.dataset.x);
      const y = Number(input.dataset.y);
      state.answerInputs[y][x] = event.target.value.replace(/[^\d]/g, "").slice(0, 2);
      event.target.value = state.answerInputs[y][x];
    });
  });
  document.querySelector("[data-manual-save]")?.addEventListener("click", async () => {
    stopTimer();
    const cells = gradeManualInputs();
    state.review = { cells, resultId: null };
    await saveResult(cells);
    setView("review");
  });
  bindScanEvents();
  bindReviewEvents();
  drawPreviewCanvas();
}

function bindScanEvents() {
  const cameraInput = document.querySelector("[data-camera-input]");
  const fileInput = document.querySelector("[data-file-input]");
  document.querySelector("[data-trigger-camera]")?.addEventListener("click", () => cameraInput?.click());
  document.querySelector("[data-trigger-file]")?.addEventListener("click", () => fileInput?.click());
  cameraInput?.addEventListener("change", (event) => handleImageFile(event.target.files?.[0]));
  fileInput?.addEventListener("change", (event) => handleImageFile(event.target.files?.[0]));
  document.querySelector("[data-correct-image]")?.addEventListener("click", correctImage);
  document.querySelector("[data-grade-scan]")?.addEventListener("click", gradeScan);
  document.querySelector("[data-reset-scan]")?.addEventListener("click", () => {
    state.scan = { image: null, sourceCanvas: null, processedCanvas: null, markers: null, cells: [], message: "画像を読み込んでください。" };
    render();
  });
}

function bindReviewEvents() {
  document.querySelectorAll("[data-open-cell]").forEach((button) => {
    button.addEventListener("click", () => {
      const [x, y] = button.dataset.openCell.split(",").map(Number);
      state.modalCell = state.review.cells.find((cell) => cell.x === x && cell.y === y);
      render();
    });
  });
  document.querySelector("[data-confirm-review]")?.addEventListener("click", async () => {
    await saveResult(state.review.cells);
    setView("history");
  });
  document.querySelector("[data-close-modal]")?.addEventListener("click", (event) => {
    if (event.target.matches("[data-close-modal]")) {
      state.modalCell = null;
      render();
    }
  });
  document.querySelector("[data-close-modal-button]")?.addEventListener("click", () => {
    state.modalCell = null;
    render();
  });
  document.querySelector("[data-save-cell]")?.addEventListener("click", () => {
    const input = document.querySelector("[data-modal-answer]");
    updateModalCell(input.value);
  });
  document.querySelector("[data-mark-blank]")?.addEventListener("click", () => updateModalCell(""));
}

function updateModalCell(value) {
  const raw = String(value || "").trim();
  const actual = raw === "" ? null : Number(raw);
  const cell = state.review.cells.find((item) => item.x === state.modalCell.x && item.y === state.modalCell.y);
  if (!cell) return;
  cell.actual = Number.isInteger(actual) && actual >= 0 && actual <= 18 ? actual : null;
  cell.confidence = cell.actual == null ? 0 : 1;
  cell.needsReview = cell.actual == null;
  cell.isCorrect = cell.actual === cell.expected;
  state.modalCell = null;
  render();
}

async function handleImageFile(file) {
  if (!file) return;
  const image = new Image();
  image.decoding = "async";
  image.src = URL.createObjectURL(file);
  await image.decode();
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(image.src);
  state.scan = {
    image,
    sourceCanvas: canvas,
    processedCanvas: null,
    markers: null,
    cells: [],
    message: "画像を読み込みました。補正してください。"
  };
  render();
}

function drawPreviewCanvas() {
  const preview = document.querySelector("[data-preview-canvas]");
  if (!preview) return;
  const source = state.scan.processedCanvas || state.scan.sourceCanvas;
  const ctx = preview.getContext("2d");
  ctx.clearRect(0, 0, preview.width, preview.height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, preview.width, preview.height);
  if (!source) {
    ctx.fillStyle = "#64748b";
    ctx.font = "24px system-ui";
    ctx.fillText("画像プレビュー", 32, 60);
    return;
  }
  const scale = Math.min(preview.width / source.width, preview.height / source.height);
  const w = source.width * scale;
  const h = source.height * scale;
  const x = (preview.width - w) / 2;
  const y = (preview.height - h) / 2;
  ctx.drawImage(source, x, y, w, h);
  if (state.scan.markers) {
    ctx.strokeStyle = "#f97316";
    ctx.lineWidth = 4;
    ctx.strokeRect(
      x + state.scan.markers.left * scale,
      y + state.scan.markers.top * scale,
      (state.scan.markers.right - state.scan.markers.left) * scale,
      (state.scan.markers.bottom - state.scan.markers.top) * scale
    );
  }
}

function correctImage() {
  const source = state.scan.sourceCanvas;
  if (!source) return;
  const markers = detectMarkerBounds(source);
  state.scan.markers = markers;
  if (!markers) {
    state.scan.processedCanvas = source;
    state.scan.message = "マーカーを検出できませんでした。用紙全体を明るく正面から撮り直してください。";
    render();
    return;
  }
  const cropped = cropCanvas(source, markers.left, markers.top, markers.right - markers.left, markers.bottom - markers.top);
  state.scan.processedCanvas = cropped;
  state.scan.markers = { left: 0, top: 0, right: cropped.width, bottom: cropped.height };
  state.scan.cells = extractCells(cropped);
  state.scan.message = `補正しました。${state.scan.cells.length}セルを切り出しました。`;
  render();
}

function detectMarkerBounds(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const visited = new Uint8Array(width * height);
  const components = [];
  const isDark = (idx) => {
    const i = idx * 4;
    return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 < 55;
  };
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const start = y * width + x;
      if (visited[start] || !isDark(start)) continue;
      const queue = [start];
      visited[start] = 1;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let count = 0;
      while (queue.length) {
        const current = queue.pop();
        const cx = current % width;
        const cy = Math.floor(current / width);
        count++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        const neighbors = [current - 2, current + 2, current - width * 2, current + width * 2];
        neighbors.forEach((next) => {
          if (next < 0 || next >= width * height || visited[next]) return;
          const nx = next % width;
          const ny = Math.floor(next / width);
          if (Math.abs(nx - cx) > 2 || Math.abs(ny - cy) > 2) return;
          if (isDark(next)) {
            visited[next] = 1;
            queue.push(next);
          }
        });
      }
      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      const area = w * h;
      const ratio = w / Math.max(h, 1);
      const fill = count * 4 / Math.max(area, 1);
      if (area > 80 && area < width * height * 0.02 && ratio > 0.55 && ratio < 1.8 && fill > 0.28) {
        components.push({ minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, area });
      }
    }
  }
  if (components.length < 4) return fallbackDarkBounds(canvas);
  const topLeft = nearest(components, 0, 0);
  const topRight = nearest(components, width, 0);
  const bottomLeft = nearest(components, 0, height);
  const bottomRight = nearest(components, width, height);
  const selected = [topLeft, topRight, bottomLeft, bottomRight];
  if (new Set(selected).size < 4) return fallbackDarkBounds(canvas);
  const left = Math.max(0, Math.min(topLeft.cx, bottomLeft.cx));
  const right = Math.min(width, Math.max(topRight.cx, bottomRight.cx));
  const top = Math.max(0, Math.min(topLeft.cy, topRight.cy));
  const bottom = Math.min(height, Math.max(bottomLeft.cy, bottomRight.cy));
  if (right - left < width * 0.35 || bottom - top < height * 0.35) return fallbackDarkBounds(canvas);
  return { left, right, top, bottom };
}

function fallbackDarkBounds(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const rowCounts = new Uint32Array(height);
  const colCounts = new Uint32Array(width);
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      const luma = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      if (luma < 70) {
        rowCounts[y]++;
        colCounts[x]++;
      }
    }
  }
  const rowThreshold = Math.max(20, width * 0.12);
  const colThreshold = Math.max(20, height * 0.12);
  const rows = [];
  const cols = [];
  rowCounts.forEach((count, index) => {
    if (count > rowThreshold) rows.push(index);
  });
  colCounts.forEach((count, index) => {
    if (count > colThreshold) cols.push(index);
  });
  if (rows.length < 8 || cols.length < 8) return null;
  const top = rows[0];
  const bottom = rows[rows.length - 1];
  const left = cols[0];
  const right = cols[cols.length - 1];
  if (right - left < width * 0.3 || bottom - top < height * 0.3) return null;
  return { left, right, top, bottom };
}

function nearest(items, x, y) {
  return items.reduce((best, item) => {
    const distance = (item.cx - x) ** 2 + (item.cy - y) ** 2;
    return !best || distance < best.distance ? { ...item, distance } : best;
  }, null);
}

function cropCanvas(source, x, y, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  canvas.getContext("2d").drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function extractCells(canvas) {
  const cells = [];
  const cellW = canvas.width / 11;
  const cellH = canvas.height / 11;
  const marginX = cellW * 0.16;
  const marginY = cellH * 0.16;
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const sx = (x + 1) * cellW + marginX;
      const sy = (y + 1) * cellH + marginY;
      const sw = cellW - marginX * 2;
      const sh = cellH - marginY * 2;
      const cellCanvas = cropCanvas(canvas, sx, sy, sw, sh);
      cells.push({ x, y, canvas: cellCanvas, dataUrl: cellCanvas.toDataURL("image/png") });
    }
  }
  return cells;
}

async function gradeScan() {
  if (!state.currentSheet) return;
  const cells = state.scan.cells.length ? state.scan.cells : extractCells(state.scan.processedCanvas);
  state.scan.cells = cells;
  const grades = [];
  for (const cell of cells) {
    const prediction = classifyCell(cell.canvas);
    const expected = state.currentSheet.answers[cell.y][cell.x];
    grades.push({
      x: cell.x,
      y: cell.y,
      expected,
      actual: prediction.value,
      isCorrect: prediction.value === expected && prediction.confidence >= CONFIDENCE_THRESHOLD,
      needsReview: prediction.confidence < CONFIDENCE_THRESHOLD || prediction.value == null,
      confidence: prediction.confidence,
      imageDataUrl: cell.dataUrl
    });
  }
  state.review = { cells: grades, resultId: null };
  await saveResult(grades);
  setView("review");
}

function classifyCell(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let dark = 0;
  let total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const luma = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      if (luma < 120) dark++;
      total++;
    }
  }
  const ratio = dark / total;
  if (ratio < 0.015) {
    return { rawText: "", value: null, confidence: 0.95, digitPredictions: [] };
  }
  return {
    rawText: "",
    value: null,
    confidence: 0.35,
    digitPredictions: [
      { digit: null, confidence: 0.35 }
    ]
  };
}

async function boot() {
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  await loadState();
  render();
}

boot().catch((error) => {
  app.innerHTML = `<main class="content"><div class="panel"><h1>起動できませんでした</h1><pre>${escapeHtml(error.stack || error.message)}</pre></div></main>`;
});
