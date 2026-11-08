// Addresses and map pins share one saved coordinate pair.
const FLORIDA_BOUNDS = [-87.64, 24.39, -79.97, 31.01];
export function parseCoordinates(latitude, longitude) {
  if (
    latitude == null ||
    longitude == null ||
    String(latitude).trim() === '' ||
    String(longitude).trim() === ''
  )
    return null;
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return null;
  return { lat, lng };
}

export function readColonyLocation(form) {
  const address = form.get('address')?.trim() || null;
  if (form.get('location_mode') === 'address' && !address) {
    throw new Error(
      'Choose a Florida address suggestion, or use the map pin / coordinates option.',
    );
  }
  const point = parseCoordinates(form.get('lat'), form.get('lng'));
  if (!point)
    throw new Error(
      'Drop a pin or enter a valid latitude (−90 to 90) and longitude (−180 to 180).',
    );
  const search = form.get('address_search')?.trim();
  if (search && search !== address)
    throw new Error('Choose an address suggestion, or clear the address search to use your pin.');
  if (address) {
    const source = parseCoordinates(form.get('address_lat'), form.get('address_lng'));
    if (!source || source.lat !== point.lat || source.lng !== point.lng) {
      throw new Error(
        'The address and pin do not match. Select the address again, or clear it to use your pin.',
      );
    }
  }
  return { ...point, address };
}

export async function searchAddresses(query) {
  if (typeof query !== 'string' || query.trim().length < 3 || query.length > 200) return [];
  const search = query.trim();
  const url = new URL(process.env.GEOCODER_URL || 'https://photon.komoot.io/api/');
  url.search = new URLSearchParams({
    q: /\b(?:florida|fl)\b/i.test(search) ? search : `${search}, Florida`,
    limit: '20',
    lang: 'en',
    countrycode: 'US',
    bbox: FLORIDA_BOUNDS.join(','),
    lat: '25.7617',
    lon: '-80.1918',
  });
  // Bias toward Miami, without sending saved colony coordinates to the provider.
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Address lookup unavailable');
  const data = await response.json();
  if (!Array.isArray(data.features)) throw new Error('Invalid address lookup response');
  const results = [];
  for (const feature of data.features) {
    if (feature.geometry?.type !== 'Point') continue;
    const [lng, lat] = feature.geometry.coordinates || [];
    const p = feature.properties || {};
    const point = parseCoordinates(lat, lng);
    const state = String(p.state || p.statecode || '')
      .trim()
      .toLowerCase();
    if (
      !point ||
      String(p.countrycode).toUpperCase() !== 'US' ||
      !['florida', 'fl', 'us-fl'].includes(state)
    )
      continue;
    // A bounding box also includes parts of neighboring states, so require state metadata too.
    const [west, south, east, north] = FLORIDA_BOUNDS;
    if (point.lng < west || point.lng > east || point.lat < south || point.lat > north) continue;
    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    const parts = [
      p.name,
      street,
      p.city || p.town || p.village,
      p.state,
      p.postcode,
      p.country,
    ].filter((part) => typeof part === 'string' && part.trim());
    const address = [...new Set(parts)].join(', ');
    if (!address || results.some((result) => result.address === address)) continue;
    results.push({ ...point, address });
    if (results.length === 10) break;
  }
  return results;
}
