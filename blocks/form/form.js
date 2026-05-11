/*
 * Form block.
 *
 * Authored content (Google Doc table):
 *   | Form                |
 *   | /forms/<name>.json  |
 *
 * The single cell text or anchor href is the URL of a Sheet that defines
 * the form fields. The Sheet has columns: name, type, label, placeholder,
 * required, options (pipe-separated for select/radio), value (default).
 *
 * Submission posts a JSON body to the same URL with a `data` payload — the
 * Sheet's owner wires this to a real form processor (AEM Forms / Forms
 * Submit / a Cloud Function endpoint).
 */

function createInput(type, field) {
  const input = document.createElement('input');
  input.type = type;
  input.id = field.name;
  input.name = field.name;
  if (field.placeholder) input.placeholder = field.placeholder;
  if (field.required === 'true') input.required = true;
  if (field.value) input.value = field.value;
  return input;
}

function createTextarea(field) {
  const textarea = document.createElement('textarea');
  textarea.id = field.name;
  textarea.name = field.name;
  if (field.placeholder) textarea.placeholder = field.placeholder;
  if (field.required === 'true') textarea.required = true;
  if (field.value) textarea.value = field.value;
  return textarea;
}

function createSelect(field) {
  const select = document.createElement('select');
  select.id = field.name;
  select.name = field.name;
  if (field.required === 'true') select.required = true;
  (field.options || '').split('|').filter(Boolean).forEach((opt) => {
    const option = document.createElement('option');
    option.value = opt.trim();
    option.textContent = opt.trim();
    if (opt === field.value) option.selected = true;
    select.appendChild(option);
  });
  return select;
}

function createCheckbox(field) {
  const wrap = document.createElement('label');
  wrap.classList.add('form-checkbox-wrap');
  const input = createInput('checkbox', field);
  input.value = field.value || 'on';
  wrap.appendChild(input);
  if (field.label) wrap.append(' ', field.label);
  return wrap;
}

function createRadio(field) {
  const wrap = document.createElement('div');
  wrap.classList.add('form-radio-group');
  (field.options || '').split('|').filter(Boolean).forEach((opt) => {
    const id = `${field.name}-${opt.trim().replace(/\W+/g, '-')}`;
    const label = document.createElement('label');
    label.htmlFor = id;
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = field.name;
    input.value = opt.trim();
    input.id = id;
    if (opt.trim() === field.value) input.checked = true;
    label.appendChild(input);
    label.append(' ', opt.trim());
    wrap.appendChild(label);
  });
  return wrap;
}

function createSubmit(field) {
  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = field.label || 'Submit';
  return button;
}

const FIELD_FACTORIES = {
  text: (field) => createInput('text', field),
  email: (field) => createInput('email', field),
  tel: (field) => createInput('tel', field),
  url: (field) => createInput('url', field),
  number: (field) => createInput('number', field),
  date: (field) => createInput('date', field),
  password: (field) => createInput('password', field),
  hidden: (field) => createInput('hidden', field),
  textarea: (field) => createTextarea(field),
  select: (field) => createSelect(field),
  checkbox: (field) => createCheckbox(field),
  radio: (field) => createRadio(field),
  submit: (field) => createSubmit(field),
};

function createField(field) {
  const wrap = document.createElement('div');
  wrap.classList.add('form-field', `form-field-${field.type || 'text'}`);

  const skipLabel = field.type === 'hidden'
    || field.type === 'submit'
    || field.type === 'checkbox';
  if (!skipLabel && field.label) {
    const label = document.createElement('label');
    label.htmlFor = field.name;
    label.textContent = field.label + (field.required === 'true' ? ' *' : '');
    wrap.appendChild(label);
  }

  const factory = FIELD_FACTORIES[field.type] || FIELD_FACTORIES.text;
  wrap.appendChild(factory(field));
  return wrap;
}

async function fetchFormDefinition(href) {
  try {
    const url = href.endsWith('.json') ? href : `${href}.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`form fetch ${res.status}`);
    const json = await res.json();
    // EDS Sheet returns { data: [...] } for single-sheet, or
    // { ":names": [...], "<name>": { data: [...] } } for multi-sheet.
    if (json.data) return json.data;
    const names = json[':names'];
    if (names && names.length > 0) {
      const first = json[names[0]];
      if (first && first.data) return first.data;
    }
    return [];
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[form] failed to load form definition:', href, e);
    return [];
  }
}

async function handleSubmit(event, action) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form).entries());
  const status = form.querySelector('.form-status');
  if (status) status.textContent = 'Submitting…';
  try {
    const res = await fetch(action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    });
    if (status) {
      status.textContent = res.ok ? 'Thanks — your message has been sent.' : `Submit failed (${res.status}).`;
      status.classList.toggle('form-status-error', !res.ok);
    }
    if (res.ok) form.reset();
  } catch (_) {
    if (status) {
      status.textContent = 'Submit failed — please try again.';
      status.classList.add('form-status-error');
    }
  }
}

function resolveHref(block) {
  const link = block.querySelector('a[href]');
  if (link) return link.getAttribute('href');
  const cell = block.firstElementChild && block.firstElementChild.firstElementChild;
  if (cell) return (cell.textContent || '').trim();
  return '';
}

export default async function decorate(block) {
  const href = resolveHref(block);

  if (!href) {
    block.innerHTML = '<p class="form-status form-status-error">No form definition path found.</p>';
    return;
  }

  const fields = await fetchFormDefinition(href);

  const form = document.createElement('form');
  form.classList.add('form');
  form.action = href.endsWith('.json') ? href.replace(/\.json$/, '') : href;
  form.method = 'POST';

  if (fields.length === 0) {
    const placeholder = document.createElement('p');
    placeholder.classList.add('form-status', 'form-status-placeholder');
    placeholder.textContent = `Form definition not yet available at ${href}. Author the Sheet to populate fields.`;
    form.appendChild(placeholder);
  } else {
    fields.forEach((field) => {
      form.appendChild(createField(field));
    });
    if (!fields.some((f) => f.type === 'submit')) {
      form.appendChild(createField({ type: 'submit', label: 'Submit' }));
    }
  }

  const status = document.createElement('p');
  status.classList.add('form-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  form.appendChild(status);

  form.addEventListener('submit', (e) => handleSubmit(e, form.action));

  block.replaceChildren(form);
}
