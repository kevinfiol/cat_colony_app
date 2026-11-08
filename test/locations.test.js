import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCoordinates, readColonyLocation, searchAddresses } from '../src/locations.js';

const form = (values) => new Map(Object.entries(values));

test('coordinate locations accept zero and boundaries, and reject missing, malformed or out-of-range values', () => {
  assert.deepEqual(parseCoordinates('0', '0'), { lat: 0, lng: 0 });
  assert.deepEqual(parseCoordinates('-90', '180'), { lat: -90, lng: 180 });
  for (const [lat, lng] of [
    ['', '-80'],
    ['25', ' '],
    [null, null],
    ['25abc', '-80'],
    ['NaN', '-80'],
    ['Infinity', '-80'],
    ['91', '0'],
    ['0', '-181'],
  ]) {
    assert.equal(parseCoordinates(lat, lng), null);
  }
  assert.deepEqual(readColonyLocation(form({ lat: '25.5', lng: '-80.5' })), {
    lat: 25.5,
    lng: -80.5,
    address: null,
  });
});

test('a selected address is saved only with its own coordinates', () => {
  const selected = {
    lat: '25.5',
    lng: '-80.5',
    address: '101 Fictional Lane, Demo City',
    address_search: '101 Fictional Lane, Demo City',
    address_lat: '25.5',
    address_lng: '-80.5',
    location_mode: 'address',
  };
  assert.equal(readColonyLocation(form(selected)).address, selected.address);
  assert.throws(() => readColonyLocation(form({ ...selected, lat: '25.6' })), /do not match/);
  assert.throws(
    () => readColonyLocation(form({ ...selected, address_search: 'Different fictional street' })),
    /Choose an address suggestion/,
  );
  assert.throws(
    () => readColonyLocation(form({ lat: '25.5', lng: '-80.5', address: selected.address })),
    /do not match/,
  );
  assert.throws(
    () =>
      readColonyLocation(
        form({ lat: '25.5', lng: '-80.5', address_search: 'Unselected fictional address' }),
      ),
    /Choose an address suggestion/,
  );
  assert.throws(
    () => readColonyLocation(form({ lat: '25.5', lng: '-80.5', location_mode: 'address' })),
    /Choose a Florida address/,
  );
  assert.deepEqual(readColonyLocation(form({ lat: '25.5', lng: '-80.5', location_mode: 'pin' })), {
    lat: 25.5,
    lng: -80.5,
    address: null,
  });
});

test('address lookup uses bounded queries, converts GeoJSON coordinates, and ignores duplicates and invalid results', async (t) => {
  let requested;
  const request = t.mock.method(globalThis, 'fetch', async (url) => {
    requested = new URL(url);
    return Response.json({
      features: [
        {
          geometry: { type: 'Point', coordinates: [-80.5, 25.5] },
          properties: {
            housenumber: '101',
            street: 'Fictional Lane',
            city: 'Demo City',
            state: 'Florida',
            countrycode: 'us',
          },
        },
        {
          geometry: { type: 'Point', coordinates: [-80.5, 25.5] },
          properties: {
            housenumber: '101',
            street: 'Fictional Lane',
            city: 'Demo City',
            state: 'Florida',
            countrycode: 'us',
          },
        },
        {
          geometry: { type: 'Point', coordinates: [999, 25.5] },
          properties: { name: 'Invalid coordinates' },
        },
        { geometry: { type: 'Polygon', coordinates: [] }, properties: { name: 'Not a point' } },
      ],
    });
  });
  assert.deepEqual(await searchAddresses('ab'), []);
  assert.deepEqual(await searchAddresses('x'.repeat(201)), []);
  assert.deepEqual(await searchAddresses(undefined), []);
  assert.equal(request.mock.callCount(), 0);
  const results = await searchAddresses('101 Fictional Lane');
  assert.deepEqual(results, [
    { lat: 25.5, lng: -80.5, address: '101 Fictional Lane, Demo City, Florida' },
  ]);
  assert.equal(requested.searchParams.get('q'), '101 Fictional Lane, Florida');
  assert.equal(requested.searchParams.get('limit'), '20');
  assert.equal(requested.searchParams.get('countrycode'), 'US');
  assert.equal(requested.searchParams.get('bbox'), '-87.64,24.39,-79.97,31.01');
  assert.equal(requested.searchParams.get('lat'), '25.7617');
});

test('suggestions exclude other countries and nearby states, including places inside the Florida bounding box', async (t) => {
  const feature = (name, state, countrycode = 'US', coordinates = [-84.5, 30.7]) => ({
    geometry: { type: 'Point', coordinates },
    properties: { name, state, countrycode },
  });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      features: [
        feature('Foreign match', 'Florida', 'CA'),
        feature('Neighboring state', 'Georgia'),
        feature('Another neighboring state', 'Alabama'),
        feature('Missing state', undefined),
        feature('Wrong coordinates', 'Florida', 'US', [10, 50]),
        feature('Fictional South Spot', 'Florida', 'US', [-80.5, 25.5]),
        feature('Fictional Panhandle Spot', 'FL', 'us', [-87.2, 30.4]),
        feature('Fictional Keys Spot', 'US-FL', 'US', [-81.78, 24.55]),
      ],
    }),
  );
  const results = await searchAddresses('Fictional');
  assert.deepEqual(
    results.map((result) => result.address),
    ['Fictional South Spot, Florida', 'Fictional Panhandle Spot, FL', 'Fictional Keys Spot, US-FL'],
  );
});

test('shows up to ten Florida suggestions and preserves a query that already includes FL', async (t) => {
  let requested;
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested = new URL(url);
    return Response.json({
      features: Array.from({ length: 12 }, (_, index) => ({
        geometry: { type: 'Point', coordinates: [-80.5, 25.5] },
        properties: {
          housenumber: String(100 + index),
          street: 'Fictional Lane',
          state: 'Florida',
          countrycode: 'US',
        },
      })),
    });
  });
  const results = await searchAddresses('Fictional Lane, FL');
  assert.equal(results.length, 10);
  assert.equal(requested.searchParams.get('q'), 'Fictional Lane, FL');
});

test('lookup failures remain failures so the UI can offer coordinate entry', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 429 }));
  await assert.rejects(searchAddresses('Fictional Lane'), /unavailable/);
  request.mock.mockImplementation(async () => Response.json({ unexpected: [] }));
  await assert.rejects(searchAddresses('Fictional Lane'), /Invalid address lookup response/);
});
