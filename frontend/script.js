'use strict';

// ---------------------------------------------------------------------------
// Настройки API
// ---------------------------------------------------------------------------

const API_BASE_URL = 'http://localhost:3000';
const MEETUPS_ENDPOINT = `${API_BASE_URL}/meetups`;

const REQUEST_TIMEOUT_MS = 8000;
const SEARCH_DEBOUNCE_MS = 400;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const DEFAULT_SORT = 'startsAt';

// Справочник направлений: из него строятся оба select и подписи в карточках.
const TOPIC_LABELS = {
  frontend: 'Frontend',
  backend: 'Backend',
  design: 'Дизайн и UX',
  career: 'Карьера и soft skills',
};

const FORMAT_FILTERS = {
  online: true,
  offline: false,
};

const EDITABLE_FIELDS = [
  'title',
  'topic',
  'startsAt',
  'durationMinutes',
  'capacity',
  'host',
  'isOnline',
];

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const ui = {
  endpoint: document.querySelector('[data-ui="endpoint"]'),
  status: document.querySelector('[data-ui="status"]'),
  statusTitle: document.querySelector('[data-ui="status-title"]'),
  statusText: document.querySelector('[data-ui="status-text"]'),
  retryButton: document.querySelector('[data-action="retry"]'),
  resetFiltersButton: document.querySelector('[data-action="reset-filters"]'),
  reloadButton: document.querySelector('[data-action="reload"]'),
  collection: document.querySelector('[data-ui="collection"]'),
  filtersForm: document.querySelector('[data-form="filters"]'),
  topicFilter: document.querySelector('[data-ui="topic-filter"]'),
  entryForm: document.querySelector('[data-form="entry"]'),
  topicInput: document.querySelector('[data-ui="topic-input"]'),
  formEyebrow: document.querySelector('[data-ui="form-eyebrow"]'),
  formTitle: document.querySelector('[data-ui="form-title"]'),
  formStatus: document.querySelector('[data-ui="form-status"]'),
  submitButton: document.querySelector('[data-action="submit"]'),
  cancelEditButton: document.querySelector('[data-action="cancel-edit"]'),
};

// ---------------------------------------------------------------------------
// Состояние приложения — единственный источник правды о коллекции
// ---------------------------------------------------------------------------

const state = {
  meetups: [],
  editingMeetup: null,
  isSubmitting: false,
  confirmDeleteId: null,
  deletingId: null,
  cardErrors: new Map(),
};

let collectionController = null;
let collectionRequestId = 0;
let searchTimerId = null;

// ---------------------------------------------------------------------------
// HTTP-слой
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(response) {
    super(`HTTP ${response.status} ${response.statusText}`.trim());
    this.name = 'HttpError';
    this.status = response.status;
    this.url = response.url;
  }
}

class TimeoutError extends Error {
  constructor(url) {
    super(`Request timed out after ${REQUEST_TIMEOUT_MS} ms: ${url}`);
    this.name = 'TimeoutError';
  }
}

/**
 * Единая обертка над fetch.
 * - ограничивает время ожидания через собственный AbortController;
 * - принимает внешний signal (например, чтобы отменить устаревший поиск);
 * - проверяет response.ok до разбора тела.
 */
async function requestJson(url, { method = 'GET', body, signal } = {}) {
  const controller = new AbortController();
  let isTimedOut = false;

  const timerId = setTimeout(() => {
    isTimedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  const abortByCaller = () => controller.abort();

  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener('abort', abortByCaller, { once: true });
  }

  const options = { method, signal: controller.signal };

  if (body !== undefined) {
    options.headers = JSON_HEADERS;
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      throw new HttpError(response);
    }

    return await response.json();
  } catch (error) {
    if (isTimedOut) {
      throw new TimeoutError(url);
    }

    throw error;
  } finally {
    clearTimeout(timerId);
    signal?.removeEventListener('abort', abortByCaller);
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function getMeetupUrl(id) {
  return `${MEETUPS_ENDPOINT}/${encodeURIComponent(id)}`;
}

function fetchMeetups(query, signal) {
  const queryString = query.toString();
  const url = queryString ? `${MEETUPS_ENDPOINT}?${queryString}` : MEETUPS_ENDPOINT;

  return requestJson(url, { method: 'GET', signal });
}

function createMeetup(meetup) {
  return requestJson(MEETUPS_ENDPOINT, { method: 'POST', body: meetup });
}

function updateMeetup(id, changes) {
  return requestJson(getMeetupUrl(id), { method: 'PATCH', body: changes });
}

function deleteMeetup(id) {
  return requestJson(getMeetupUrl(id), { method: 'DELETE' });
}

/** Переводит техническую ошибку в понятное пользователю сообщение. */
function getErrorMessage(error) {
  if (error instanceof TimeoutError) {
    return `Сервер не ответил за ${REQUEST_TIMEOUT_MS / 1000} с. Возможно, он перегружен — попробуйте еще раз.`;
  }

  if (error instanceof HttpError) {
    if (error.status === 404) {
      return 'Ресурс не найден (404). Проверьте адрес endpoint или обновите список: запись могли удалить.';
    }

    if (error.status >= 500) {
      return `Ошибка на стороне сервера (${error.status}). Попробуйте позже.`;
    }

    return `Сервер отклонил запрос (${error.status}).`;
  }

  if (error instanceof SyntaxError) {
    return 'Сервер вернул ответ, который не удалось разобрать как JSON.';
  }

  return 'Не удалось подключиться к API. Проверьте, что сервер запущен командой npm run dev.';
}

// ---------------------------------------------------------------------------
// Фильтры, сортировка и поиск → query-параметры
// ---------------------------------------------------------------------------

function readFilters() {
  const formData = new FormData(ui.filtersForm);

  return {
    search: String(formData.get('search') ?? '').trim(),
    topic: String(formData.get('topic') ?? ''),
    format: String(formData.get('format') ?? ''),
    sort: String(formData.get('sort') || DEFAULT_SORT),
  };
}

function hasActiveFilters(filters) {
  return Boolean(filters.search || filters.topic || filters.format);
}

function buildCollectionQuery(filters) {
  const query = new URLSearchParams();

  if (filters.topic) {
    query.set('topic', filters.topic);
  }

  if (filters.format in FORMAT_FILTERS) {
    query.set('isOnline', String(FORMAT_FILTERS[filters.format]));
  }

  if (filters.search) {
    query.set('title:contains', filters.search);
  }

  query.set('_sort', filters.sort);

  return query;
}

// ---------------------------------------------------------------------------
// Загрузка коллекции (GET)
// ---------------------------------------------------------------------------

async function loadMeetups() {
  clearTimeout(searchTimerId);

  // Новый запрос делает предыдущий неактуальным — отменяем его.
  collectionController?.abort();
  const controller = new AbortController();
  collectionController = controller;

  const requestId = ++collectionRequestId;
  const filters = readFilters();

  setCollectionLoading(true);
  showStatus('loading', 'Загрузка…', 'Получаем список встреч с сервера.');

  try {
    const meetups = await fetchMeetups(buildCollectionQuery(filters), controller.signal);

    // Ответ на устаревший запрос не должен перезаписать более новый результат.
    if (requestId !== collectionRequestId) {
      return;
    }

    if (!Array.isArray(meetups)) {
      throw new TypeError('Expected an array of meetups');
    }

    state.meetups = meetups;
    renderCollectionState(filters);
  } catch (error) {
    if (isAbortError(error) || requestId !== collectionRequestId) {
      console.info('Устаревший запрос коллекции отменен');
      return;
    }

    console.error('Не удалось загрузить встречи:', error);
    state.meetups = [];
    renderMeetups([]);
    showStatus('error', 'Не удалось загрузить встречи', getErrorMessage(error), {
      canRetry: true,
    });
  } finally {
    if (requestId === collectionRequestId) {
      collectionController = null;
      setCollectionLoading(false);
    }
  }
}

function scheduleSearch() {
  clearTimeout(searchTimerId);
  searchTimerId = setTimeout(loadMeetups, SEARCH_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Состояния и отображение
// ---------------------------------------------------------------------------

function showStatus(type, title, text, { canRetry = false, canResetFilters = false } = {}) {
  ui.status.className = `status status--${type}`;
  ui.statusTitle.textContent = title;
  ui.statusText.textContent = text;
  ui.retryButton.hidden = !canRetry;
  ui.resetFiltersButton.hidden = !canResetFilters;
}

function setCollectionLoading(isLoading) {
  ui.collection.hidden = isLoading;
  ui.collection.setAttribute('aria-busy', String(isLoading));
  ui.reloadButton.disabled = isLoading;
}

function renderCollectionState(filters = readFilters()) {
  renderMeetups(state.meetups);

  const count = state.meetups.length;

  if (count === 0 && hasActiveFilters(filters)) {
    showStatus('empty', 'Ничего не найдено', 'Под выбранные условия не подходит ни одна встреча.', {
      canResetFilters: true,
    });
    return;
  }

  if (count === 0) {
    showStatus('empty', 'Встреч пока нет', 'База пуста. Добавьте первую встречу через форму.');
    return;
  }

  showStatus('success', `Найдено встреч: ${count}`, 'Данные актуальны на момент загрузки.');
}

function renderMeetups(meetups) {
  const cards = meetups.map(createMeetupCard);
  ui.collection.replaceChildren(...cards);
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);

  if (className) {
    element.className = className;
  }

  if (text !== undefined) {
    element.textContent = text;
  }

  return element;
}

function createButton(text, className, action, id) {
  const button = createElement('button', `button ${className}`, text);
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.id = id;
  return button;
}

function formatStartsAt(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateFormatter.format(date);
}

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  if (!hours) return `${minutes} мин`;
  if (!rest) return `${hours} ч`;
  return `${hours} ч ${rest} мин`;
}

function isMeetupFinished(meetup) {
  const start = new Date(meetup.startsAt).getTime();
  const durationMs = Number(meetup.durationMinutes) * 60 * 1000;
  return Number.isFinite(start) && start + durationMs < Date.now();
}

function createMetaRow(term, value) {
  const row = createElement('div', 'card__row');
  row.append(createElement('dt', 'card__term', term), createElement('dd', 'card__value', value));
  return row;
}

function createMeetupCard(meetup) {
  const id = String(meetup.id);
  const isFinished = isMeetupFinished(meetup);
  const isEditing = state.editingMeetup?.id === meetup.id;
  const isDeleting = state.deletingId === id;
  const isConfirming = state.confirmDeleteId === id;

  const card = createElement('article', 'card');
  card.dataset.id = id;
  card.classList.toggle('card--finished', isFinished);
  card.classList.toggle('card--editing', isEditing);

  const badges = createElement('div', 'card__badges');
  badges.append(
    createElement(
      'span',
      'card__badge card__badge--topic',
      TOPIC_LABELS[meetup.topic] ?? meetup.topic ?? 'Без направления',
    ),
    createElement(
      'span',
      `card__badge ${meetup.isOnline ? 'card__badge--online' : 'card__badge--offline'}`,
      meetup.isOnline ? 'Онлайн' : 'Очно',
    ),
  );

  if (isFinished) {
    badges.append(createElement('span', 'card__badge card__badge--finished', 'Прошла'));
  }

  const meta = createElement('dl', 'card__meta');
  meta.append(
    createMetaRow('Начало', formatStartsAt(meetup.startsAt)),
    createMetaRow('Длительность', formatDuration(Number(meetup.durationMinutes))),
    createMetaRow('Мест', String(meetup.capacity)),
    createMetaRow('Ведущий', meetup.host ?? '—'),
  );

  card.append(badges, createElement('h3', 'card__title', meetup.title ?? 'Без названия'), meta);

  const errorMessage = state.cardErrors.get(id);
  if (errorMessage) {
    const error = createElement('p', 'card__error', errorMessage);
    error.setAttribute('role', 'alert');
    card.append(error);
  }

  card.append(createCardActions(id, { isConfirming, isDeleting, isEditing }));
  return card;
}

function createCardActions(id, { isConfirming, isDeleting, isEditing }) {
  const actions = createElement('div', 'card__actions');

  if (isConfirming || isDeleting) {
    const question = createElement('span', 'card__question', 'Удалить встречу?');
    const confirmButton = createButton(
      isDeleting ? 'Удаляем…' : 'Да, удалить',
      'button--danger card__button',
      'confirm-delete',
      id,
    );
    const cancelButton = createButton('Нет', 'button--ghost card__button', 'cancel-delete', id);

    confirmButton.disabled = isDeleting;
    cancelButton.disabled = isDeleting;
    actions.append(question, confirmButton, cancelButton);
    return actions;
  }

  const editButton = createButton(
    isEditing ? 'Редактируется' : 'Изменить',
    'button--secondary card__button',
    'edit',
    id,
  );
  const deleteButton = createButton('Удалить', 'button--ghost card__button', 'ask-delete', id);

  editButton.disabled = isEditing;
  // Пока идет удаление другой карточки, не запускаем параллельные удаления.
  deleteButton.disabled = state.deletingId !== null;
  actions.append(editButton, deleteButton);
  return actions;
}

function rerenderCards() {
  renderMeetups(state.meetups);
}

function fillTopicSelects() {
  for (const select of [ui.topicFilter, ui.topicInput]) {
    for (const [value, label] of Object.entries(TOPIC_LABELS)) {
      select.append(new Option(label, value));
    }
  }
}

// ---------------------------------------------------------------------------
// Удаление (DELETE)
// ---------------------------------------------------------------------------

function askDelete(id) {
  state.confirmDeleteId = id;
  state.cardErrors.delete(id);
  rerenderCards();
  focusCardAction(id, 'cancel-delete');
}

function cancelDelete(id) {
  state.confirmDeleteId = null;
  rerenderCards();
  focusCardAction(id, 'ask-delete');
}

async function confirmDelete(id) {
  if (state.deletingId !== null) {
    return;
  }

  state.deletingId = id;
  rerenderCards();

  try {
    await deleteMeetup(id);

    state.confirmDeleteId = null;
    state.cardErrors.delete(id);

    if (state.editingMeetup && String(state.editingMeetup.id) === id) {
      exitEditMode();
      showFormMessage('Редактируемая встреча была удалена.', 'info');
    }

    state.deletingId = null;
    await loadMeetups();
  } catch (error) {
    console.error(`Не удалось удалить встречу ${id}:`, error);
    state.deletingId = null;
    state.confirmDeleteId = null;
    state.cardErrors.set(id, `Не удалось удалить. ${getErrorMessage(error)}`);
    rerenderCards();
    focusCardAction(id, 'ask-delete');
  }
}

function focusCardAction(id, action) {
  const selector = `[data-action="${action}"][data-id="${CSS.escape(id)}"]`;
  ui.collection.querySelector(selector)?.focus();
}

// ---------------------------------------------------------------------------
// Форма: создание (POST) и редактирование (PATCH)
// ---------------------------------------------------------------------------

function readMeetupForm() {
  const formData = new FormData(ui.entryForm);

  return {
    title: String(formData.get('title')).trim(),
    topic: String(formData.get('topic')),
    startsAt: String(formData.get('startsAt')),
    durationMinutes: Number(formData.get('durationMinutes')),
    capacity: Number(formData.get('capacity')),
    host: String(formData.get('host')).trim(),
    isOnline: formData.get('isOnline') === 'true',
  };
}

function getChangedFields(original, next) {
  const changes = {};

  for (const field of EDITABLE_FIELDS) {
    if (original[field] !== next[field]) {
      changes[field] = next[field];
    }
  }

  return changes;
}

function setSubmitting(isSubmitting) {
  state.isSubmitting = isSubmitting;
  ui.submitButton.disabled = isSubmitting;
  ui.cancelEditButton.disabled = isSubmitting;
  ui.entryForm.setAttribute('aria-busy', String(isSubmitting));

  if (isSubmitting) {
    ui.submitButton.textContent = state.editingMeetup ? 'Сохраняем…' : 'Отправляем…';
  } else {
    ui.submitButton.textContent = state.editingMeetup ? 'Сохранить изменения' : 'Добавить встречу';
  }
}

function showFormMessage(text, type = 'info') {
  ui.formStatus.className = `form-status form-status--${type}`;
  ui.formStatus.textContent = text;
}

function clearFormMessage() {
  ui.formStatus.className = 'form-status';
  ui.formStatus.textContent = '';
}

async function handleEntrySubmit(event) {
  event.preventDefault();

  if (state.isSubmitting) {
    return;
  }

  const meetup = readMeetupForm();
  const editingMeetup = state.editingMeetup;

  if (editingMeetup) {
    await submitChanges(editingMeetup, meetup);
  } else {
    await submitNewMeetup(meetup);
  }
}

async function submitNewMeetup(meetup) {
  setSubmitting(true);
  clearFormMessage();

  try {
    const created = await createMeetup(meetup);
    ui.entryForm.reset();
    showFormMessage(`Встреча «${created.title}» добавлена.`, 'success');
    await loadMeetups();
  } catch (error) {
    console.error('Не удалось создать встречу:', error);
    showFormMessage(`Встреча не сохранена, данные остались в форме. ${getErrorMessage(error)}`, 'error');
  } finally {
    setSubmitting(false);
  }
}

async function submitChanges(original, next) {
  const changes = getChangedFields(original, next);

  if (Object.keys(changes).length === 0) {
    showFormMessage('Изменений нет — сохранять нечего.', 'info');
    return;
  }

  setSubmitting(true);
  clearFormMessage();

  try {
    const updated = await updateMeetup(original.id, changes);
    exitEditMode();
    showFormMessage(`Изменения во встрече «${updated.title}» сохранены.`, 'success');
    await loadMeetups();
  } catch (error) {
    console.error(`Не удалось обновить встречу ${original.id}:`, error);
    showFormMessage(`Изменения не сохранены, данные остались в форме. ${getErrorMessage(error)}`, 'error');
  } finally {
    setSubmitting(false);
  }
}

function enterEditMode(id) {
  const meetup = state.meetups.find((item) => String(item.id) === id);

  if (!meetup || state.isSubmitting) {
    return;
  }

  state.editingMeetup = { ...meetup };

  const { elements } = ui.entryForm;
  elements.title.value = meetup.title ?? '';
  elements.topic.value = meetup.topic ?? '';
  elements.startsAt.value = meetup.startsAt ?? '';
  elements.durationMinutes.value = meetup.durationMinutes ?? '';
  elements.capacity.value = meetup.capacity ?? '';
  elements.host.value = meetup.host ?? '';
  elements.isOnline.checked = Boolean(meetup.isOnline);

  ui.formEyebrow.textContent = 'Редактирование';
  ui.formTitle.textContent = 'Изменить встречу';
  ui.cancelEditButton.hidden = false;
  setSubmitting(false);
  clearFormMessage();
  rerenderCards();

  ui.entryForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  elements.title.focus({ preventScroll: true });
}

function exitEditMode() {
  const editedId = state.editingMeetup ? String(state.editingMeetup.id) : null;

  state.editingMeetup = null;
  ui.entryForm.reset();
  ui.formEyebrow.textContent = 'Новая запись';
  ui.formTitle.textContent = 'Добавить встречу';
  ui.cancelEditButton.hidden = true;
  setSubmitting(false);
  rerenderCards();

  return editedId;
}

function handleCancelEdit() {
  const editedId = exitEditMode();
  showFormMessage('Редактирование отменено.', 'info');

  if (editedId) {
    focusCardAction(editedId, 'edit');
  }
}

// ---------------------------------------------------------------------------
// Обработчики событий
// ---------------------------------------------------------------------------

function handleCollectionClick(event) {
  const button = event.target.closest('button[data-action]');

  if (!button) {
    return;
  }

  const { action, id } = button.dataset;

  switch (action) {
    case 'edit':
      enterEditMode(id);
      break;
    case 'ask-delete':
      askDelete(id);
      break;
    case 'cancel-delete':
      cancelDelete(id);
      break;
    case 'confirm-delete':
      confirmDelete(id);
      break;
    default:
      break;
  }
}

function handleFiltersInput(event) {
  if (event.target.name === 'search') {
    scheduleSearch();
  }
}

function handleFiltersChange(event) {
  if (event.target.name !== 'search') {
    loadMeetups();
  }
}

function handleFiltersSubmit(event) {
  event.preventDefault();
  loadMeetups();
}

function handleFiltersReset() {
  // Событие reset срабатывает до очистки полей — читаем значения на следующем шаге.
  setTimeout(loadMeetups);
}

function resetFilters() {
  ui.filtersForm.reset();
}

function init() {
  ui.endpoint.textContent = MEETUPS_ENDPOINT;
  fillTopicSelects();

  ui.reloadButton.addEventListener('click', loadMeetups);
  ui.retryButton.addEventListener('click', loadMeetups);
  ui.resetFiltersButton.addEventListener('click', resetFilters);
  ui.collection.addEventListener('click', handleCollectionClick);

  ui.filtersForm.addEventListener('input', handleFiltersInput);
  ui.filtersForm.addEventListener('change', handleFiltersChange);
  ui.filtersForm.addEventListener('submit', handleFiltersSubmit);
  ui.filtersForm.addEventListener('reset', handleFiltersReset);

  ui.entryForm.addEventListener('submit', handleEntrySubmit);
  ui.cancelEditButton.addEventListener('click', handleCancelEdit);

  loadMeetups();
}

init();
