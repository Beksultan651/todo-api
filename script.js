const API = "https://dummyjson.com";
const DEFAULT_URL = `${API}/todos?limit=30`;
const STORAGE_KEY = "is.task-manager.v2";
const HISTORY_KEY = "isCrudRoute";
const $ = selector => document.querySelector(selector);
const collator = new Intl.Collator("ru", { sensitivity: "base", numeric: true });

// Барлық тізім бір Map-пен жұмыс істейді. Өзгерістер API деректерінен бөлек сақталады.
const state = {
  tasks: new Map(), mainKeys: new Set(), changes: new Map(), deleted: new Set(),
  users: new Map(), usersReady: false, profiles: new Map(), profileLoaded: new Set(),
  profileRequests: new Map(), profileErrors: new Map(), mainLoading: false,
  mainFailed: false, mainStatus: "all", profileStatus: "all", userIdFilter: null,
  profileId: null, saving: false, frames: [], historyPending: false, editorId: null,
};
const dialogs = { profile: $("#profile-dialog"), editor: $("#editor-dialog"), delete: $("#delete-dialog") };

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
function message(selector, text, kind = "") {
  const node = $(selector);
  node.hidden = !text;
  node.textContent = text;
  node.className = `message ${kind}`;
  node.setAttribute("role", kind === "error" ? "alert" : "status");
}
function notify(text, kind = "success") {
  message("#app-feedback", text, kind);
  if (dialogs.profile.open) message("#profile-feedback", text, kind);
}
function busyText(selector, text) {
  message(selector, text);
  const spinner = element("span", "spinner");
  $(selector).replaceChildren(spinner, text);
}
function name(user) { return [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "Не указано"; }
function authorLabel(user) { return `${name(user)} (@${user.username || `user${user.id}`}) · ID ${user.id}`; }
function uniqueKey(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}
function avatar(user) {
  const node = element("span", "avatar", `${user?.firstName?.[0] || "?"}${user?.lastName?.[0] || ""}`);
  if (typeof user?.image === "string" && user.image.startsWith(`${API}/`)) {
    const image = document.createElement("img");
    image.src = user.image;
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("error", () => image.remove());
    node.append(image);
  }
  return node;
}

// Қате жауап, желі қатесі және күту уақыты барлық сұрауда бірдей өңделеді.
async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url.startsWith("/") ? API + url : url, {
      ...options, signal: controller.signal, credentials: "omit",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
    });
    if (!response.ok) throw new Error(`Ошибка API: HTTP ${response.status}. Повторите попытку.`);
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Сервер не ответил вовремя. Повторите попытку.");
    if (error instanceof TypeError) throw new Error("Не удалось подключиться к API. Проверьте интернет-соединение.");
    if (error instanceof SyntaxError) throw new Error("API вернул некорректный JSON.");
    throw error;
  } finally { clearTimeout(timer); }
}

function validTask(task) {
  return task && Number.isInteger(task.userId) && task.userId > 0 &&
    typeof task.todo === "string" && task.todo.trim().length > 0 && typeof task.completed === "boolean";
}
function cleanTask(task, key, local = false) {
  return { key, id: task.id, todo: task.todo, completed: task.completed, userId: task.userId, local };
}
function readStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || !Array.isArray(saved.changes) || !Array.isArray(saved.deleted)) throw new Error();
    const changes = new Map();
    for (const task of saved.changes) {
      if (!validTask(task) || typeof task.key !== "string" ||
        !(task.local ? /^local-[\w-]+$/.test(task.key) : Number.isInteger(task.id) && task.key === `api-${task.id}`)) throw new Error();
      changes.set(task.key, cleanTask(task, task.key, task.local === true));
    }
    state.deleted = new Set(saved.deleted.filter(id => Number.isInteger(id) && id > 0));
    state.changes = changes;
    for (const task of changes.values()) {
      if (!task.local && state.deleted.has(task.id)) continue;
      state.tasks.set(task.key, task);
      state.mainKeys.add(task.key);
    }
  } catch {
    message("#storage-status", "Не удалось прочитать локальные изменения. Сохранение может быть недоступно или данные повреждены. Серверные задачи будут загружены отдельно.", "warning");
  }
}
function saveStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, changes: [...state.changes.values()], deleted: [...state.deleted] }));
    message("#storage-status", "");
    return true;
  } catch {
    message("#storage-status", "Браузер запретил localStorage или закончилось место. Текущие изменения видны, но после обновления страницы могут пропасть.", "warning");
    return false;
  }
}
function mergeServerTasks(payload, expectedUserId = null) {
  if (!Array.isArray(payload.todos) || !payload.todos.every(task => validTask(task) && Number.isInteger(task.id) &&
    (expectedUserId === null || task.userId === expectedUserId))) throw new Error("API вернул некорректный список задач.");
  const keys = [];
  for (const raw of payload.todos) {
    const key = `api-${raw.id}`;
    if (state.deleted.has(raw.id)) continue;
    state.tasks.set(key, state.changes.get(key) || cleanTask(raw, key));
    keys.push(key);
  }
  return keys;
}

// Өріске тек қолдау көрсетілетін DummyJSON HTTPS мекенжайлары қабылданады.
function validatedUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Введите HTTPS-ссылку на задачи DummyJSON, а не API-ключ."); }
  if (url.protocol !== "https:" || url.origin !== API || url.username || url.password || url.hash ||
    !/^\/todos(?:\/user\/[1-9]\d*)?\/?$/.test(url.pathname)) {
    throw new Error("Поддерживаются только HTTPS-ссылки https://dummyjson.com/todos и /todos/user/ID.");
  }
  for (const [key, value] of url.searchParams) {
    if ((key === "limit" || key === "skip") && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) continue;
    if (key === "sortBy" && value === "todo") continue;
    if (key === "order" && ["asc", "desc"].includes(value)) continue;
    throw new Error(`Параметр «${key}» не поддерживается. Используйте limit, skip, sortBy=todo и order=asc/desc.`);
  }
  return url.href;
}
async function loadMain() {
  if (state.mainLoading) return;
  let url;
  try { url = validatedUrl($("#api-url").value.trim()); }
  catch (error) { message("#load-status", error.message, "error"); return; }
  state.mainLoading = true;
  state.mainFailed = false;
  busyText("#load-status", "Загрузка задач…");
  renderAll();
  try {
    const payload = await request(url);
    const keys = mergeServerTasks(payload);
    state.mainKeys = new Set([...state.changes.keys()].reverse().concat(keys).filter(key => state.tasks.has(key)));
    message("#load-status", `Загружено ${payload.todos.length} задач${Number.isInteger(payload.total) ? ` из ${payload.total} доступных в API` : ""}. Локальные изменения восстановлены.`, "success");
  } catch (error) {
    state.mainFailed = true;
    message("#load-status", error.message, "error");
  } finally {
    state.mainLoading = false;
    renderAll();
  }
}
async function loadUsers() {
  $("#retry-users").hidden = true;
  busyText("#users-status", "Загрузка пользователей…");
  $("#users-list").setAttribute("aria-busy", "true");
  try {
    const payload = await request("/users?limit=0");
    if (!Array.isArray(payload.users) || !payload.users.every(user => Number.isInteger(user.id) &&
      typeof user.firstName === "string" && typeof user.lastName === "string")) throw new Error("Некорректный список пользователей.");
    state.users = new Map(payload.users.map(user => [user.id, user]));
    state.usersReady = true;
    ["#user-search", "#user-sort", "#user-id", "#id-search"].forEach(id => { $(id).disabled = false; });
    populateAuthors();
    renderUsers();
    renderAll();
  } catch (error) {
    message("#users-status", error.message, "error");
    $("#retry-users").hidden = false;
  } finally { $("#users-list").setAttribute("aria-busy", "false"); }
}
function sortedUsers() { return [...state.users.values()].sort((a, b) => collator.compare(name(a), name(b)) || a.id - b.id); }
function populateAuthors() {
  const filter = $("#author-filter").value;
  const editor = $("#editor-author").value;
  $("#author-filter").replaceChildren(new Option("Все авторы", "all"));
  $("#editor-author").replaceChildren();
  sortedUsers().forEach(user => {
    $("#author-filter").append(new Option(authorLabel(user), user.id));
    $("#editor-author").append(new Option(authorLabel(user), user.id));
  });
  $("#author-filter").value = filter || "all";
  if (state.users.has(Number(editor))) $("#editor-author").value = editor;
}
function renderUsers() {
  const list = $("#users-list");
  const scroll = list.scrollTop;
  const query = $("#user-search").value.trim().toLocaleLowerCase("ru");
  let users = sortedUsers().filter(user => state.userIdFilter !== null ? user.id === state.userIdFilter : name(user).toLocaleLowerCase("ru").includes(query));
  if ($("#user-sort").value === "desc") users.reverse();
  list.replaceChildren();
  $("#users-count").textContent = state.users.size;
  users.forEach(user => {
    const button = element("button", "user-card");
    button.type = "button";
    button.dataset.userId = user.id;
    button.setAttribute("aria-haspopup", "dialog");
    const text = element("span");
    text.append(element("span", "user-name", name(user)), element("span", "user-meta", `@${user.username || `user${user.id}`} · ID ${user.id}`));
    button.append(avatar(user), text);
    list.append(button);
  });
  list.scrollTop = scroll;
  if (state.usersReady) message("#users-status", users.length ? state.userIdFilter !== null ? "Пользователь найден. Нажмите на карточку." : "" : state.userIdFilter !== null ? `Пользователь с User ID ${state.userIdFilter} не найден.` : "Пользователи не найдены.", users.length ? "" : "error");
}

function mainTasks() { return [...state.mainKeys].map(key => state.tasks.get(key)).filter(Boolean); }
function filteredTasks(tasks, status, sort, query = "", author = "all") {
  const text = query.trim().toLocaleLowerCase("ru");
  const result = tasks.filter(task => task.todo.toLocaleLowerCase("ru").includes(text) &&
    (author === "all" || task.userId === Number(author)) &&
    (status === "all" || task.completed === (status === "done")));
  if (sort !== "none") result.sort((a, b) => (sort === "desc" ? -1 : 1) * collator.compare(a.todo, b.todo));
  return result;
}
function taskRow(task, context) {
  const row = element("li", `task-row${task.completed ? " completed" : ""}`);
  row.dataset.key = task.key;
  const check = element("input", "task-checkbox");
  check.type = "checkbox";
  check.id = `${context}-${task.key}`;
  check.checked = task.completed;
  check.dataset.action = "toggle";
  check.setAttribute("aria-label", `${task.completed ? "Отметить невыполненной" : "Отметить выполненной"}: ${task.todo}`);
  const content = element("div", "task-content");
  const label = element("label", "task-title", task.todo);
  label.htmlFor = check.id;
  const author = state.users.get(task.userId);
  const meta = element("div", "task-author");
  const authorButton = element("button", "author-button");
  authorButton.type = "button";
  authorButton.dataset.userId = task.userId;
  authorButton.setAttribute("aria-label", `Открыть профиль ${name(author)} · User ID ${task.userId}`);
  authorButton.append(avatar(author), element("span", "", `@${author?.username || `user${task.userId}`}`));
  meta.append(authorButton, element("span", "task-id", task.local ? "Локальная задача" : `#${task.id}`));
  content.append(label, meta);
  const actions = element("div", "task-actions");
  [["edit", "Изменить", "secondary"], ["delete", "Удалить", "danger"]].forEach(([action, text, kind]) => {
    const button = element("button", `button ${kind}`, text);
    button.type = "button";
    button.dataset.action = action;
    button.setAttribute("aria-label", `${text}: ${task.todo}`);
    actions.append(button);
  });
  row.append(check, content, actions);
  return row;
}
function renderTaskList(selector, tasks, context) {
  const list = $(selector);
  const scroll = list.scrollTop;
  list.replaceChildren(...tasks.map(task => taskRow(task, context)));
  list.scrollTop = scroll;
}
function updateTabs(selector, status) {
  $(selector).querySelectorAll("button").forEach(button => {
    const active = button.dataset.status === status;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}
function renderMain() {
  const all = mainTasks();
  const tasks = filteredTasks(all, state.mainStatus, $("#task-sort").value, $("#task-search").value, $("#author-filter").value || "all");
  const done = all.filter(task => task.completed).length;
  $("#stat-total").textContent = all.length;
  $("#stat-done").textContent = done;
  $("#stat-active").textContent = all.length - done;
  $("#main-total").textContent = `${all.length} задач`;
  $("#main-shown").textContent = `Показано ${tasks.length} из ${all.length}`;
  $("#main-state").hidden = tasks.length > 0;
  $("#main-state").textContent = state.mainLoading ? "Загрузка задач…" : state.mainFailed && !all.length ? "Не удалось загрузить задачи. Проверьте ссылку и повторите загрузку." : all.length ? "По заданным фильтрам ничего не найдено." : "Задач пока нет. Добавьте первую задачу.";
  $("#main-list").setAttribute("aria-busy", String(state.mainLoading));
  renderTaskList("#main-list", tasks, "main");
  updateTabs("#main-tabs", state.mainStatus);
}

// Профиль әрқашан жеке endpoint-тен толық тапсырмалар тізімін алады.
async function loadProfile(userId, force = false) {
  if (state.profileRequests.has(userId)) return state.profileRequests.get(userId);
  if (!force && state.profiles.has(userId) && state.profileLoaded.has(userId)) return;
  const operation = (async () => {
    state.profileErrors.delete(userId);
    const results = await Promise.allSettled([request(`/users/${userId}`), request(`/todos/user/${userId}?limit=0`)]);
    const errors = {};
    if (results[0].status === "fulfilled" && results[0].value?.id === userId) {
      state.profiles.set(userId, results[0].value);
    } else errors.info = results[0].status === "rejected" ? results[0].reason.message : "Некорректные данные профиля.";
    if (results[1].status === "fulfilled") {
      try { mergeServerTasks(results[1].value, userId); state.profileLoaded.add(userId); }
      catch (error) { errors.tasks = error.message; }
    } else errors.tasks = results[1].reason.message;
    state.profileErrors.set(userId, errors);
  })();
  state.profileRequests.set(userId, operation);
  renderProfile();
  try { await operation; }
  finally { state.profileRequests.delete(userId); renderAll(); renderProfile(); }
}
function shownValue(value) { return value === undefined || value === null || value === "" ? "Не указано" : String(value); }
function translated(value, values) { return value ? values[value] || value : "Не указано"; }
function birthDate(value) {
  if (!value) return "Не указано";
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (!match) return shownValue(value);
  return new Intl.DateTimeFormat("ru", { timeZone: "UTC" }).format(new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])));
}
function renderProfileInfo() {
  const id = state.profileId;
  const user = state.profiles.get(id) || state.users.get(id) || { id };
  const container = $("#profile-info");
  const summary = element("div", "profile-summary");
  summary.append(avatar(user), element("h3", "", name(user)), element("p", "", user.username ? `@${user.username}` : "Не указано"), element("span", "badge", `User ID: ${id}`));
  container.replaceChildren(summary);
  const address = user.address || {};
  const company = user.company || {};
  const colors = { Brown: "Карий / коричневый", Blue: "Голубой", Green: "Зелёный", Gray: "Серый", Hazel: "Ореховый", Amber: "Янтарный", Black: "Чёрный", Blonde: "Светлый", White: "Белый", Red: "Рыжий" };
  // Тек рұқсат етілген өрістер. Құпиясөз, банк және жеке идентификаторлар көрсетілмейді.
  const groups = [
    ["Контакты", [["Email", user.email], ["Телефон", user.phone]]],
    ["Личные данные", [["Девичья фамилия", user.maidenName], ["Возраст", user.age], ["Пол", translated(user.gender, { male: "Мужской", female: "Женский" })], ["Дата рождения", birthDate(user.birthDate)]]],
    ["Адрес", [["Адрес", [address.address, address.city, address.state, address.country].filter(Boolean).join(", ")], ["Почтовый индекс", address.postalCode]]],
    ["Работа и образование", [["Компания", company.name], ["Отдел", company.department], ["Должность", company.title], ["Университет", user.university], ["Роль", translated(user.role, { admin: "Администратор", moderator: "Модератор", user: "Пользователь" })]]],
    ["Дополнительная информация", [["Рост", user.height == null ? null : `${user.height} см`], ["Вес", user.weight == null ? null : `${user.weight} кг`], ["Группа крови", user.bloodGroup], ["Цвет глаз", translated(user.eyeColor, colors)], ["Волосы", user.hair ? [translated(user.hair.color, colors), translated(user.hair.type, { Curly: "Кудрявые", Straight: "Прямые", Wavy: "Волнистые", Kinky: "Очень кудрявые" })].join(", ") : null]]],
  ];
  groups.forEach(([title, fields]) => {
    const section = element("section", "detail-group");
    const list = element("dl", "details-list");
    fields.forEach(([label, value]) => {
      const row = element("div", "detail-row");
      row.append(element("dt", "", label), element("dd", "", shownValue(value)));
      list.append(row);
    });
    section.append(element("h3", "", title), list);
    container.append(section);
  });
  const error = state.profileErrors.get(id)?.info;
  message("#profile-info-status", error || (state.profileRequests.has(id) && !state.profiles.has(id) ? "Загрузка данных профиля…" : ""), error ? "error" : "");
}
function renderProfileTasks() {
  if (!state.profileId) return;
  const loaded = state.profileLoaded.has(state.profileId);
  const all = [...state.tasks.values()].filter(task => task.userId === state.profileId);
  const tasks = loaded ? filteredTasks(all, state.profileStatus, $("#profile-sort").value) : [];
  $("#profile-shown").textContent = loaded ? `Показано ${tasks.length} из ${all.length}` : "Показано 0 из 0";
  renderTaskList("#profile-list", tasks, "profile");
  const error = state.profileErrors.get(state.profileId)?.tasks;
  $("#profile-task-status").hidden = loaded && tasks.length > 0 && !error;
  $("#profile-task-status").textContent = error || (!loaded ? "Загрузка задач пользователя…" : all.length ? "По выбранному статусу задач нет." : "У пользователя пока нет задач.");
  $("#profile-task-status").classList.toggle("error", Boolean(error));
  $("#profile-list").setAttribute("aria-busy", String(state.profileRequests.has(state.profileId)));
  updateTabs("#profile-tabs", state.profileStatus);
}
function renderProfile() {
  if (!state.profileId) return;
  renderProfileInfo();
  renderProfileTasks();
  const errors = state.profileErrors.get(state.profileId);
  $("#retry-profile").hidden = !(errors?.info || errors?.tasks);
}
function updateControls() {
  $("#load-button").disabled = state.mainLoading;
  $("#load-button").textContent = state.mainLoading ? "Загрузка…" : "Загрузить задачи ↓";
  document.querySelectorAll("[data-add]").forEach(button => { button.disabled = state.saving || !state.usersReady || !state.users.size; });
  document.querySelectorAll(".task-list [data-action]").forEach(control => { control.disabled = state.saving || (control.dataset.action === "edit" && !state.usersReady); });
  ["#editor-save", "#editor-text", "#editor-author", "#editor-status", "#delete-confirm"].forEach(id => { $(id).disabled = state.saving; });
}
function renderAll() { renderMain(); renderProfileTasks(); updateControls(); }

// Тарихта әр ашылған терезеге жеке жазба бар: Назад тек жоғарғысын жабады.
function topFrame() { return state.frames.at(-1); }
function captureView() {
  const values = {};
  ["task-search", "task-sort", "author-filter", "user-search", "user-sort", "user-id", "profile-sort"].forEach(id => { values[id] = $(`#${id}`).value; });
  const scrolls = {};
  ["main-list", "users-list", "profile-dialog"].forEach(id => { scrolls[id] = $(`#${id}`).scrollTop; });
  return { values, scrolls, pageX: window.scrollX, pageY: window.scrollY, mainStatus: state.mainStatus, profileStatus: state.profileStatus, userIdFilter: state.userIdFilter };
}
function restoreView(view) {
  if (!view) return;
  Object.entries(view.values || {}).forEach(([id, value]) => { if ($(`#${id}`)) $(`#${id}`).value = value; });
  state.mainStatus = view.mainStatus || "all";
  state.profileStatus = view.profileStatus || "all";
  state.userIdFilter = view.userIdFilter ?? null;
  renderAll();
  if (state.usersReady) renderUsers();
  Object.entries(view.scrolls || {}).forEach(([id, value]) => { $(`#${id}`).scrollTop = value; });
  window.scrollTo(view.pageX || 0, view.pageY || 0);
}
function writeRoute(replace = false) {
  const value = { ...history.state, [HISTORY_KEY]: { frames: state.frames, view: captureView() } };
  if (replace) history.replaceState(value, ""); else history.pushState(value, "");
}
function rememberRoute() {
  if (state.historyPending) return;
  const frame = topFrame();
  if (frame?.type === "editor" && dialogs.editor.open) frame.draft = editorValues();
  writeRoute(true);
}
function focusFrame(closedFrame = null) {
  const top = topFrame();
  let target;
  if (top?.type === "editor") target = $("#editor-text");
  else if (top?.type === "delete") target = $("#delete-dialog [data-close]");
  else if (top?.type === "profile") target = closedFrame?.key ? $("#profile-list").querySelector(`[data-key="${closedFrame.key}"] button[data-action="edit"]`) : $("#profile-add");
  else if (closedFrame?.userId) target = $("#users-list").querySelector(`[data-user-id="${closedFrame.userId}"]`) || $("#main-list").querySelector(`[data-user-id="${closedFrame.userId}"]`);
  (target || $("#main-add")).focus({ preventScroll: true });
}
function applyFrames(frames, fromHistory = false) {
  const oldProfile = state.profileId;
  state.frames = frames;
  const profile = frames.find(frame => frame.type === "profile");
  state.profileId = profile?.userId || null;
  ["delete", "editor", "profile"].forEach(type => { if (!frames.some(frame => frame.type === type) && dialogs[type].open) dialogs[type].close(); });
  if (profile) {
    if (oldProfile !== profile.userId && !fromHistory) { state.profileStatus = "all"; $("#profile-sort").value = "none"; message("#profile-feedback", ""); }
    renderProfile();
    if (!dialogs.profile.open) dialogs.profile.showModal();
    loadProfile(profile.userId);
  }
  const editor = frames.find(frame => frame.type === "editor");
  if (editor) {
    if (state.editorId !== editor.id || !dialogs.editor.open) {
      state.editorId = editor.id;
      $("#editor-title").textContent = editor.mode === "add" ? "Новая задача" : "Изменить задачу";
      $("#editor-save").textContent = editor.mode === "add" ? "Добавить" : "Сохранить";
      $("#editor-text").value = editor.draft.todo;
      $("#editor-author").value = editor.draft.userId;
      $("#editor-status").value = editor.draft.completed ? "done" : "active";
      message("#editor-error", "");
    }
    if (!dialogs.editor.open) dialogs.editor.showModal();
  }
  const deleting = frames.find(frame => frame.type === "delete");
  if (deleting) {
    $("#delete-text").textContent = `Вы уверены, что хотите удалить «${state.tasks.get(deleting.key)?.todo || "задачу"}»?`;
    message("#delete-error", "");
    if (!dialogs.delete.open) dialogs.delete.showModal();
  }
  document.body.classList.toggle("modal-open", frames.length > 0);
  updateControls();
}
function openFrame(frame) {
  if (state.historyPending) return;
  rememberRoute();
  const next = state.frames.concat({ ...frame, id: uniqueKey("window") });
  applyFrames(next);
  writeRoute();
  focusFrame();
}
function closeTop() {
  if (state.historyPending || !state.frames.length) return;
  rememberRoute();
  const closed = topFrame();
  state.historyPending = true;
  applyFrames(state.frames.slice(0, -1));
  focusFrame(closed);
  history.back();
}
function syncRoute() {
  const closed = topFrame();
  state.historyPending = false;
  const route = history.state?.[HISTORY_KEY];
  const frames = Array.isArray(route?.frames) ? route.frames.filter(frame =>
    ["profile", "editor", "delete"].includes(frame.type) && (frame.type !== "profile" || Number.isInteger(frame.userId))) : [];
  applyFrames(frames, true);
  restoreView(route?.view);
  focusFrame(closed);
}
function openProfile(userId) {
  if (!Number.isInteger(userId) || userId <= 0) return;
  if (state.frames.some(frame => frame.type === "profile")) return;
  openFrame({ type: "profile", userId });
}
function openEditor(mode, key = null, context = "main") {
  if (state.saving || !state.usersReady || !state.users.size) return;
  const task = key ? state.tasks.get(key) : null;
  const userId = context === "profile" ? state.profileId : state.users.keys().next().value;
  openFrame({ type: "editor", mode, key, draft: task ? { todo: task.todo, userId: task.userId, completed: task.completed } : { todo: "", userId, completed: false } });
}
function editorValues() {
  return { todo: $("#editor-text").value, userId: Number($("#editor-author").value), completed: $("#editor-status").value === "done" };
}
function rememberTask(task) {
  state.tasks.set(task.key, task);
  state.changes.delete(task.key);
  state.changes.set(task.key, task);
  state.mainKeys = new Set([task.key, ...state.mainKeys]);
  const persisted = saveStorage();
  renderAll();
  notify(persisted ? "Изменения сохранены в этом браузере." : "Изменение применено, но localStorage недоступен. После обновления оно может пропасть.", persisted ? "success" : "warning");
}
async function saveEditor(event) {
  event.preventDefault();
  const frame = topFrame();
  if (frame?.type !== "editor" || state.saving) return;
  const values = editorValues();
  values.todo = values.todo.trim();
  if (!values.todo || values.todo.length > 500) { message("#editor-error", "Введите текст задачи: от 1 до 500 символов, не только пробелы.", "error"); $("#editor-text").focus(); return; }
  if (!state.users.has(values.userId)) { message("#editor-error", "Выберите автора из списка.", "error"); return; }
  state.saving = true;
  updateControls();
  try {
    let task;
    if (frame.mode === "add") {
      const response = await request("/todos/add", { method: "POST", body: JSON.stringify(values) });
      let key;
      do { key = uniqueKey("local"); } while (state.tasks.has(key));
      task = cleanTask({ id: response.id, ...values }, key, true);
    } else {
      const previous = state.tasks.get(frame.key);
      if (!previous) throw new Error("Задача больше не существует.");
      if (!previous.local) await request(`/todos/${previous.id}`, { method: "PATCH", body: JSON.stringify(values) });
      task = { ...previous, ...values };
    }
    rememberTask(task);
    state.saving = false;
    if (topFrame()?.id === frame.id) closeTop();
  } catch (error) {
    if (topFrame()?.id === frame.id) message("#editor-error", error.message, "error");
    else notify(error.message, "error");
  } finally { state.saving = false; updateControls(); }
}
async function toggleTask(task, checkbox) {
  const completed = checkbox.checked;
  checkbox.checked = task.completed;
  if (state.saving) return;
  state.saving = true;
  updateControls();
  try {
    if (!task.local) await request(`/todos/${task.id}`, { method: "PATCH", body: JSON.stringify({ completed }) });
    rememberTask({ ...task, completed });
  } catch (error) { notify(error.message, "error"); }
  finally { state.saving = false; renderAll(); }
}
async function deleteTask() {
  const frame = topFrame();
  if (frame?.type !== "delete" || state.saving) return;
  const task = state.tasks.get(frame.key);
  if (!task) { closeTop(); return; }
  state.saving = true;
  updateControls();
  try {
    if (!task.local) await request(`/todos/${task.id}`, { method: "DELETE" });
    if (!task.local) state.deleted.add(task.id);
    state.changes.delete(task.key);
    state.tasks.delete(task.key);
    state.mainKeys.delete(task.key);
    const persisted = saveStorage();
    renderAll();
    notify(persisted ? "Задача удалена. Изменение сохранено локально." : "Задача удалена, но локальное сохранение недоступно.", persisted ? "success" : "warning");
    state.saving = false;
    if (topFrame()?.id === frame.id) closeTop();
  } catch (error) {
    if (topFrame()?.id === frame.id) message("#delete-error", error.message, "error");
    else notify(error.message, "error");
  } finally { state.saving = false; updateControls(); }
}

// Оқиғаларды бір жерде тіркейміз: әр тізімнің жолдары кейін қайта салына алады.
$("#api-form").addEventListener("submit", event => { event.preventDefault(); loadMain(); });
$("#preset-button").addEventListener("click", () => { $("#api-url").value = DEFAULT_URL; $("#api-url").focus(); });
$("#retry-users").addEventListener("click", loadUsers);
$("#retry-profile").addEventListener("click", () => loadProfile(state.profileId, true));
$("#task-search").addEventListener("input", () => { renderMain(); rememberRoute(); });
["#task-sort", "#author-filter"].forEach(id => $(id).addEventListener("change", () => { renderMain(); rememberRoute(); }));
$("#reset-filters").addEventListener("click", () => {
  $("#task-search").value = ""; $("#task-sort").value = "none"; $("#author-filter").value = "all"; state.mainStatus = "all";
  renderAll(); rememberRoute();
});
$("#profile-sort").addEventListener("change", () => { renderProfileTasks(); rememberRoute(); });
[["#main-tabs", "mainStatus"], ["#profile-tabs", "profileStatus"]].forEach(([selector, key]) => {
  $(selector).addEventListener("click", event => {
    const button = event.target.closest("button[data-status]");
    if (!button) return;
    state[key] = button.dataset.status; renderAll(); rememberRoute();
  });
});
$("#user-search").addEventListener("input", () => { state.userIdFilter = null; $("#user-id").value = ""; renderUsers(); rememberRoute(); });
$("#user-sort").addEventListener("change", () => { renderUsers(); rememberRoute(); });
$("#id-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!state.usersReady) return;
  const value = $("#user-id").value.trim();
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) { message("#users-status", "Введите целый User ID больше нуля.", "error"); return; }
  state.userIdFilter = Number(value); $("#user-search").value = ""; renderUsers(); rememberRoute();
});
$("#user-id").addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); $("#id-form").requestSubmit(); } });
$("#clear-users").addEventListener("click", () => { state.userIdFilter = null; $("#user-id").value = ""; $("#user-search").value = ""; renderUsers(); rememberRoute(); });
document.addEventListener("click", event => {
  const close = event.target.closest("[data-close]");
  if (close) { if (close.closest("dialog") === dialogs[topFrame()?.type]) closeTop(); return; }
  const author = event.target.closest("button[data-user-id]");
  if (author) { openProfile(Number(author.dataset.userId)); return; }
  const add = event.target.closest("[data-add]");
  if (add) { openEditor("add", null, add.dataset.add); return; }
  const action = event.target.closest("button[data-action]");
  if (!action || state.saving) return;
  const key = action.closest(".task-row").dataset.key;
  if (action.dataset.action === "edit") openEditor("edit", key);
  else openFrame({ type: "delete", key });
});
document.addEventListener("change", event => {
  if (!event.target.matches(".task-checkbox")) return;
  const task = state.tasks.get(event.target.closest(".task-row").dataset.key);
  if (task) toggleTask(task, event.target);
});
$("#editor-form").addEventListener("submit", saveEditor);
["#editor-text", "#editor-author", "#editor-status"].forEach(id => $(id).addEventListener("input", rememberRoute));
$("#delete-confirm").addEventListener("click", deleteTask);
Object.entries(dialogs).forEach(([type, dialog]) => dialog.addEventListener("cancel", event => {
  event.preventDefault(); if (topFrame()?.type === type) closeTop();
}));
window.addEventListener("popstate", syncRoute);

readStorage();
if (!history.state?.[HISTORY_KEY]) writeRoute(true);
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
renderAll();
Promise.allSettled([loadUsers(), loadMain()]).then(syncRoute);
