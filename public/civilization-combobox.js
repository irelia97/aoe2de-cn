import { civilizationPinyin } from './civilization-pinyin.js?v=1';

let nextListId = 0;

const normalizeSearch = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '');
export function civilizationMatches(choice, query) {
  const term = normalizeSearch(query);
  if (!term) return true;
  const syllables = String(choice.pinyin || civilizationPinyin[choice.value] || '').split(/\s+/).filter(Boolean);
  const full = syllables.join('');
  return [choice.label, choice.search, full, full.replaceAll('v','u'), syllables.map(part => part[0]).join('')]
    .some(value => normalizeSearch(value).includes(term));
}

export function searchableCivilizationSelect(select) {
  const choices = [...select.options].map(option => ({
    value:option.value,
    label:option.textContent.trim(),
    search:option.dataset.search || option.value,
    icon:option.dataset.icon || '',
    pinyin:option.dataset.pinyin || civilizationPinyin[option.value] || '',
  }));
  const wrapper = document.createElement('span');
  wrapper.className = 'civ-combobox';
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'civ-combobox-input';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = '输入中文、英文或拼音搜索';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-label', select.getAttribute('aria-label') || '输入民族名称搜索');
  const selectedIcon = document.createElement('img');
  selectedIcon.className = 'civ-combobox-selected-icon';
  selectedIcon.alt = '';
  selectedIcon.hidden = true;
  selectedIcon.addEventListener('error', () => {selectedIcon.hidden = true;wrapper.classList.remove('has-icon');});
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'civ-combobox-toggle';
  toggle.setAttribute('aria-label', '展开民族列表');
  toggle.setAttribute('aria-expanded', 'false');
  const list = document.createElement('span');
  list.className = 'civ-combobox-options';
  list.id = `civ-combobox-list-${++nextListId}`;
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  input.setAttribute('aria-controls', list.id);
  select.after(wrapper);
  wrapper.append(select, input, selectedIcon, toggle, list);
  select.tabIndex = -1;

  let matches = [], activeIndex = -1;
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const sync = () => {
    const selected = choices.find(choice => choice.value === select.value);
    input.value = selected?.label || '';
    selectedIcon.hidden = !selected?.icon;
    wrapper.classList.toggle('has-icon', Boolean(selected?.icon));
    if (selected?.icon) selectedIcon.src = selected.icon;
    close();
  };
  const choose = choice => {
    if (!choice) return;
    close();
    input.value = choice.label;
    selectedIcon.hidden = !choice.icon;
    wrapper.classList.toggle('has-icon', Boolean(choice.icon));
    if (choice.icon) selectedIcon.src = choice.icon;
    if (select.value !== choice.value) {
      select.value = choice.value;
      select.dispatchEvent(new Event('change', {bubbles:true}));
    }
  };
  const render = query => {
    matches = choices.filter(choice => civilizationMatches(choice, query));
    activeIndex = matches.findIndex(choice => choice.value === select.value);
    list.replaceChildren();
    for (const [index, choice] of matches.entries()) {
      const option = document.createElement('button');
      option.type = 'button';
      option.id = `${list.id}-option-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(choice.value === select.value));
      option.dataset.index = String(index);
      if (choice.icon) {
        const icon = document.createElement('img');
        icon.src = choice.icon;
        icon.alt = '';
        icon.loading = 'lazy';
        option.append(icon);
      }
      const name = document.createElement('span');
      name.textContent = choice.label;
      option.append(name);
      list.append(option);
    }
    if (!matches.length) {
      const empty = document.createElement('span');
      empty.className = 'civ-combobox-empty';
      empty.textContent = '没有匹配的民族';
      list.append(empty);
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-expanded', 'true');
  };
  const move = direction => {
    if (list.hidden) render('');
    if (!matches.length) return;
    activeIndex = (activeIndex + direction + matches.length) % matches.length;
    const option = list.querySelector(`[data-index="${activeIndex}"]`);
    input.setAttribute('aria-activedescendant', option.id);
    option.scrollIntoView({block:'nearest'});
  };
  input.addEventListener('focus', () => input.select());
  input.addEventListener('click', () => render(input.value === choices.find(choice => choice.value === select.value)?.label ? '' : input.value));
  toggle.addEventListener('click', () => list.hidden ? render('') : close());
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { sync();return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault();move(event.key === 'ArrowDown' ? 1 : -1);return; }
    if (event.key === 'Enter' && !list.hidden) {
      event.preventDefault();
      choose(matches[activeIndex] || (matches.length === 1 ? matches[0] : null));
    }
  });
  list.addEventListener('click', event => choose(matches[Number(event.target.closest('[data-index]')?.dataset.index)]));
  document.addEventListener('pointerdown', event => { if (!wrapper.contains(event.target)) sync(); });
  input.addEventListener('blur', () => setTimeout(() => {if (!wrapper.contains(document.activeElement)) sync();}, 120));
  select.addEventListener('change', sync);
  sync();
  return {sync};
}
