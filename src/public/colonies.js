const add = document.getElementById('add');
const form = add.querySelector('form');
const hint = document.getElementById('hint');
const search = document.getElementById('address-search');
const suggestions = document.getElementById('address-suggestions');
const addressHint = document.getElementById('address-hint');
const addressFields = document.getElementById('address-fields');
const coordinateFields = document.getElementById('coordinate-fields');
const fields = form.elements;
let results = [];
let active = -1;
let timer;
let lookup;
let pick;

// Coordinate entry and address search still work if the map cannot load.
const map = window.L ? L.map('map').setView([25.7617, -80.1918], 12) : null;
if (map) {
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const markers = [];
  for (const li of document.querySelectorAll('li[data-lat]')) {
    const point = [Number(li.dataset.lat), Number(li.dataset.lng)];
    if (!point.every(Number.isFinite)) continue;
    const marker = L.marker(point).addTo(map).bindTooltip(li.dataset.name);
    marker.on('click', () => (location.href = `/admin/colonies/${li.dataset.id}`));
    markers.push(marker);
  }
  if (markers.length)
    map.fitBounds(L.featureGroup(markers).getBounds(), { padding: [30, 30], maxZoom: 15 });
  map.on('click', ({ latlng }) => {
    const point = latlng.wrap();
    setPin(point.lat, point.lng);
  });
} else {
  document.getElementById('map').textContent =
    'Map unavailable. Search for a Florida address or choose coordinate entry above.';
}

function setMode(mode) {
  const byAddress = mode === 'address';
  fields.location_mode.value = mode;
  addressFields.hidden = !byAddress;
  coordinateFields.hidden = byAddress;
  search.disabled = !byAddress;
  search.required = byAddress;
  fields.lat.readOnly = fields.lng.readOnly = byAddress;
  search.setCustomValidity(
    byAddress && !fields.address.value
      ? 'Choose a Florida address suggestion, or use map pin / coordinates.'
      : '',
  );
  cancelLookup();
}

for (const radio of form.querySelectorAll('[name="location_mode"]')) {
  radio.addEventListener('change', () => {
    setMode(radio.value);
    if (radio.value === 'pin') clearAddress();
    hint.textContent =
      radio.value === 'address'
        ? 'Choose a Florida address to fill the coordinates and place the pin.'
        : 'Drop a pin on the map, drag it, or enter latitude and longitude.';
  });
}

function cancelLookup() {
  clearTimeout(timer);
  lookup?.abort();
  results = [];
  suggestions.replaceChildren();
  closeSuggestions();
}

function closeSuggestions() {
  suggestions.hidden = true;
  search.setAttribute('aria-expanded', 'false');
  search.removeAttribute('aria-activedescendant');
  suggestions.children[active]?.setAttribute('aria-selected', 'false');
  active = -1;
}

function openSuggestions() {
  if (!results.length || document.activeElement !== search) return;
  suggestions.hidden = false;
  search.setAttribute('aria-expanded', 'true');
}

function highlight(index) {
  active = (index + results.length) % results.length;
  for (let i = 0; i < suggestions.children.length; i++) {
    suggestions.children[i].setAttribute('aria-selected', String(i === active));
  }
  const option = suggestions.children[active];
  search.setAttribute('aria-activedescendant', option.id);
  option.scrollIntoView({ block: 'nearest' });
}

function clearAddress() {
  cancelLookup();
  search.value = '';
  search.setCustomValidity(
    search.required ? 'Choose a Florida address suggestion, or use map pin / coordinates.' : '',
  );
  fields.address.value = fields.address_lat.value = fields.address_lng.value = '';
  addressHint.textContent =
    'Choose a Florida suggestion to fill the coordinates and place the pin. Add the city or ZIP code to narrow the search.';
}

function setPin(lat, lng, address = '', center = false) {
  setMode(address ? 'address' : 'pin');
  clearAddress();
  fields.lat.value = lat.toFixed(6);
  fields.lng.value = lng.toFixed(6);
  if (address) {
    search.value = fields.address.value = address;
    fields.address_lat.value = fields.lat.value;
    fields.address_lng.value = fields.lng.value;
    search.setCustomValidity('');
    addressHint.textContent = 'Address and coordinates are synced. Check the pin on the map below.';
  }
  showPin(center);
}

function showPin(center = false) {
  if (map) {
    const point = [Number(fields.lat.value), Number(fields.lng.value)];
    if (pick) pick.setLatLng(point);
    else {
      pick = L.marker(point, { draggable: true, autoPan: true, title: 'New colony location' })
        .addTo(map)
        .bindTooltip('New colony location');
      pick.on('dragend', () => {
        const position = pick.getLatLng().wrap();
        setPin(position.lat, position.lng);
      });
    }
    if (center) map.setView(point, 18);
  }
  hint.textContent = `Pin: ${fields.lat.value}, ${fields.lng.value}. ${fields.address.value ? 'Matches the selected address.' : 'Ready to save as a map location.'}`;
  hint.classList.remove('missing');
  add.open = true;
}

function validCoordinates() {
  return (
    fields.lat.value !== '' &&
    fields.lng.value !== '' &&
    fields.lat.checkValidity() &&
    fields.lng.checkValidity()
  );
}

for (const field of [fields.lat, fields.lng]) {
  field.addEventListener('input', () => {
    clearAddress();
    // Remove the old pin while the coordinate pair is incomplete.
    if (!validCoordinates()) {
      pick?.remove();
      pick = null;
      hint.textContent = 'Enter a valid latitude and longitude, or drop a pin on the map.';
    } else showPin();
  });
  field.addEventListener('change', () => {
    if (validCoordinates()) setPin(Number(fields.lat.value), Number(fields.lng.value), '', true);
  });
}

search.addEventListener('input', () => {
  const match = results.find((result) => result.address === search.value);
  if (match) return setPin(match.lat, match.lng, match.address, true);
  cancelLookup();
  fields.address.value = fields.address_lat.value = fields.address_lng.value = '';
  const query = search.value.trim();
  search.setCustomValidity('Choose a Florida address suggestion, or use map pin / coordinates.');
  if (query.length < 3) {
    addressHint.textContent = query
      ? 'Type at least 3 characters for Florida address suggestions.'
      : 'Choose a Florida address, or use map pin / coordinates.';
    return;
  }
  addressHint.textContent = 'Searching…';
  timer = setTimeout(async () => {
    const controller = new AbortController();
    lookup = controller;
    try {
      const response = await fetch(`/admin/addresses?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Lookup unavailable');
      const data = await response.json();
      if (controller.signal.aborted || search.value.trim() !== query) return;
      results = data.results;
      suggestions.replaceChildren(
        ...results.map((result, index) => {
          const option = document.createElement('li');
          option.id = `address-option-${index}`;
          option.dataset.index = index;
          option.setAttribute('role', 'option');
          option.setAttribute('aria-selected', 'false');
          option.textContent = result.address;
          return option;
        }),
      );
      openSuggestions();
      addressHint.textContent = results.length
        ? 'Florida results. Choose an address to sync its coordinates and pin.'
        : 'No matching Florida addresses. Add a city or ZIP code, or use map pin / coordinates.';
    } catch {
      if (!controller.signal.aborted)
        addressHint.textContent =
          'Address search is unavailable. Choose map pin / coordinates to continue.';
    }
  }, 600);
});

search.addEventListener('keydown', (event) => {
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length) {
    event.preventDefault();
    openSuggestions();
    highlight(
      event.key === 'ArrowDown' ? active + 1 : active === -1 ? results.length - 1 : active - 1,
    );
  } else if (event.key === 'Enter' && !suggestions.hidden) {
    event.preventDefault();
    if (active >= 0) {
      const result = results[active];
      setPin(result.lat, result.lng, result.address, true);
    }
  } else if (event.key === 'Escape' && !suggestions.hidden) {
    event.preventDefault();
    closeSuggestions();
  }
});
search.addEventListener('focus', openSuggestions);
suggestions.addEventListener('pointerdown', (event) => event.preventDefault());
suggestions.addEventListener('click', (event) => {
  const option = event.target.closest('[data-index]');
  if (!option) return;
  const result = results[Number(option.dataset.index)];
  setPin(result.lat, result.lng, result.address, true);
  search.focus();
});
document.addEventListener('click', (event) => {
  if (event.target !== search && !suggestions.contains(event.target)) closeSuggestions();
});
search.addEventListener('blur', closeSuggestions);

search.addEventListener('invalid', () => {
  setMode('address');
  add.open = true;
});

form.addEventListener('submit', (event) => {
  if (validCoordinates() && search.checkValidity()) return;
  event.preventDefault();
  hint.textContent =
    'Choose a Florida address, or use map pin / coordinates and enter a valid location.';
  hint.classList.add('missing');
  form.reportValidity();
});
