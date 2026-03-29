
(function(){
  const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
  const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
  const ORS_DIRECTIONS_URL = 'https://api.openrouteservice.org/v2/directions/foot-walking';

  const state = {
    map: null,
    markers: null,
    routeLine: null,
    destination: null,
    hotels: [],
    detours: []
  };

  function $(id){ return document.getElementById(id); }
  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
  function safeJsonGet(key){
    try { return JSON.parse(localStorage.getItem(key)); }
    catch(e){ return null; }
  }
  function safeJsonSet(key, value){
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch(e){}
  }
  function escapeHtml(str){
    return String(str || '').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  }
  function haversineMeters(a, b){
    const R = 6371000;
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const x = Math.sin(dLat/2) ** 2 + Math.sin(dLng/2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function approxWalkSecondsByDistance(meters){
    return Math.round((meters * 1.23) / 1.33); // zig-zag 보정 후 초속 1.33m
  }
  function formatMinutes(seconds, approx){
    const min = Math.max(1, Math.round(seconds / 60));
    return approx ? `약 ${min}분` : `${min}분`;
  }
  function formatMeters(meters){
    if (!meters && meters !== 0) return '-';
    if (meters >= 1000) return `${(meters/1000).toFixed(1)}km`;
    return `${Math.round(meters)}m`;
  }
  function googleTransitUrl(origin, dest){
    return `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&destination=${dest.lat},${dest.lng}&travelmode=transit`;
  }
  function googleWalkUrl(origin, dest){
    return `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&destination=${dest.lat},${dest.lng}&travelmode=walking`;
  }
  function getORSKey(){
    return (window.APP_CONFIG && window.APP_CONFIG.ORS_API_KEY || '').trim();
  }
  function average(list){
    if (!list.length) return 0;
    return list.reduce((a,b) => a+b, 0) / list.length;
  }

  async function geocodePlace(query){
    const cacheKey = `free:geo:${query.toLowerCase()}`;
    const cached = safeJsonGet(cacheKey);
    if (cached) return cached;
    const url = `${NOMINATIM_URL}?format=jsonv2&q=${encodeURIComponent(query)}&limit=1`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('장소 검색에 실패했습니다. 잠시 후 다시 시도해 주세요.');
    const data = await res.json();
    if (!data || !data.length) return null;
    const hit = data[0];
    const result = {
      name: hit.display_name,
      lat: parseFloat(hit.lat),
      lng: parseFloat(hit.lon)
    };
    safeJsonSet(cacheKey, result);
    return result;
  }

  async function overpassQuery(query){
    const res = await fetch(OVERPASS_URL, { method: 'POST', body: query });
    if (!res.ok) throw new Error('주변 장소 데이터를 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    const data = await res.json();
    return data.elements || [];
  }

  async function findNearbyHotels(lat, lng, radius){
    const query = `
      [out:json][timeout:25];
      (
        node(around:${radius},${lat},${lng})["tourism"="hotel"];
        way(around:${radius},${lat},${lng})["tourism"="hotel"];
        relation(around:${radius},${lat},${lng})["tourism"="hotel"];
        node(around:${radius},${lat},${lng})["tourism"="guest_house"];
        way(around:${radius},${lat},${lng})["tourism"="guest_house"];
      );
      out center tags;
    `;
    const list = await overpassQuery(query);
    return list.map(x => ({
      id: String(x.id),
      name: x.tags && x.tags.name ? x.tags.name : 'Unnamed stay',
      lat: x.lat || (x.center && x.center.lat),
      lng: x.lon || (x.center && x.center.lon),
      website: x.tags && (x.tags.website || x.tags['contact:website']) || '',
      stars: x.tags && x.tags.stars || '',
      kind: x.tags && (x.tags.tourism || ''),
      brand: x.tags && (x.tags.brand || x.tags.operator || '') || ''
    })).filter(x => x.lat && x.lng);
  }

  async function findNearbyStations(lat, lng, radius){
    const query = `
      [out:json][timeout:25];
      (
        node(around:${radius},${lat},${lng})["railway"="train_station_entrance"];
        node(around:${radius},${lat},${lng})["railway"="subway_entrance"];
        node(around:${radius},${lat},${lng})["railway"="station"];
      );
      out center tags;
    `;
    const list = await overpassQuery(query);
    return list.map(x => ({
      id: String(x.id),
      name: x.tags && x.tags.name ? x.tags.name : 'Unnamed station',
      lat: x.lat || (x.center && x.center.lat),
      lng: x.lon || (x.center && x.center.lon),
      type: x.tags && x.tags.railway || ''
    })).filter(x => x.lat && x.lng);
  }

  async function findDetourSpots(lat, lng, radius){
    const query = `
      [out:json][timeout:25];
      (
        node(around:${radius},${lat},${lng})["amenity"="cafe"];
        node(around:${radius},${lat},${lng})["tourism"="attraction"];
        node(around:${radius},${lat},${lng})["leisure"="park"];
        node(around:${radius},${lat},${lng})["tourism"="museum"];
      );
      out center tags;
    `;
    const list = await overpassQuery(query);
    return list.map(x => ({
      id: String(x.id),
      name: x.tags && x.tags.name ? x.tags.name : 'Unnamed spot',
      lat: x.lat || (x.center && x.center.lat),
      lng: x.lon || (x.center && x.center.lon),
      kind: (x.tags && (x.tags.amenity || x.tags.tourism || x.tags.leisure)) || ''
    })).filter(x => x.lat && x.lng);
  }

  async function getWalkingEstimate(from, to){
    const orsKey = getORSKey();
    if (!orsKey) {
      const dist = haversineMeters(from, to);
      return { distanceMeters: dist, durationSeconds: approxWalkSecondsByDistance(dist), approx: true };
    }
    try {
      const res = await fetch(ORS_DIRECTIONS_URL, {
        method: 'POST',
        headers: {
          'Authorization': orsKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ coordinates: [[from.lng, from.lat], [to.lng, to.lat]] })
      });
      if (!res.ok) throw new Error('ors');
      const data = await res.json();
      const feature = data.features && data.features[0];
      const summary = feature && feature.properties && feature.properties.summary;
      if (!summary) throw new Error('ors-summary');
      return { distanceMeters: summary.distance || 0, durationSeconds: summary.duration || 0, approx: false };
    } catch(e) {
      const dist = haversineMeters(from, to);
      return { distanceMeters: dist, durationSeconds: approxWalkSecondsByDistance(dist), approx: true };
    }
  }

  function initMap(){
    if (state.map || typeof window.L === 'undefined' || !$('freeMap')) return;
    state.map = L.map('freeMap').setView([35.6762, 139.6503], 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(state.map);
    state.markers = L.layerGroup().addTo(state.map);
  }

  function resetMap(){
    if (!state.map || !state.markers) return;
    state.markers.clearLayers();
    if (state.routeLine) {
      state.map.removeLayer(state.routeLine);
      state.routeLine = null;
    }
  }

  function drawFreeMap(){
    initMap();
    if (!state.map || !state.markers || !state.destination) return;
    resetMap();
    const pts = [];
    const dest = state.destination;
    pts.push([dest.lat, dest.lng]);
    L.marker([dest.lat, dest.lng]).addTo(state.markers).bindPopup(`<b>${escapeHtml(dest.shortLabel || '목적지')}</b><br>${escapeHtml(dest.name)}`);

    state.hotels.slice(0, 3).forEach((hotel, idx) => {
      pts.push([hotel.lat, hotel.lng]);
      L.marker([hotel.lat, hotel.lng]).addTo(state.markers).bindPopup(`<b>${idx+1}. ${escapeHtml(hotel.name)}</b><br>${escapeHtml(hotel.station && hotel.station.name ? hotel.station.name : '가까운 역 정보 없음')}`);
    });

    state.detours.slice(0, 3).forEach(spot => {
      L.circleMarker([spot.lat, spot.lng], { radius: 6, color: '#185FA5', fillColor: '#185FA5', fillOpacity: 0.6 }).addTo(state.markers).bindPopup(escapeHtml(spot.name));
      pts.push([spot.lat, spot.lng]);
    });

    if (pts.length > 1) {
      state.map.fitBounds(pts, { padding: [18, 18] });
    } else {
      state.map.setView([dest.lat, dest.lng], 14);
    }

    $('freeMapMeta').innerHTML = [
      `<div class="map-chip">목적지 1개</div>`,
      `<div class="map-chip">숙소 ${state.hotels.length}개 비교</div>`,
      `<div class="map-chip">들름 후보 ${state.detours.length}개</div>`,
      `<div class="map-chip">도보 ${getORSKey() ? '실측 우선' : '예상값'}</div>`
    ].join('');
  }

  function renderHotels(list){
    const el = $('freeHotelResults');
    if (!list.length) {
      el.innerHTML = '<div class="free-empty">근처 숙소를 찾지 못했습니다. 다른 역명이나 동네명으로 다시 검색해 보세요.</div>';
      return;
    }
    el.innerHTML = list.map((hotel, idx) => {
      const walkText = hotel.stationWalk ? `${hotel.station && hotel.station.name ? escapeHtml(hotel.station.name) : '가까운 역'}까지 도보 ${formatMinutes(hotel.stationWalk.durationSeconds, hotel.stationWalk.approx)}` : '가까운 역 정보 없음';
      const distanceText = hotel.stationWalk ? formatMeters(hotel.stationWalk.distanceMeters) : '-';
      const scoreText = Math.round(hotel.score);
      return `
        <div class="free-card">
          <div class="free-title">${idx + 1}. ${escapeHtml(hotel.name)}</div>
          <div class="muted">추천점수 ${scoreText} / 100</div>
          <div style="margin-top:8px;font-size:13px;line-height:1.6">
            <div><b>목적지까지 거리</b>: ${formatMeters(hotel.destinationMeters)}</div>
            <div><b>가까운 역</b>: ${walkText}</div>
            <div><b>도보 거리</b>: ${distanceText}</div>
          </div>
          <div class="free-meta">
            ${hotel.kind ? `<span class="free-pill">${escapeHtml(hotel.kind)}</span>` : ''}
            ${hotel.brand ? `<span class="free-pill">${escapeHtml(hotel.brand)}</span>` : ''}
            ${hotel.stars ? `<span class="free-pill">별 ${escapeHtml(hotel.stars)}</span>` : ''}
            ${hotel.station && hotel.station.type ? `<span class="free-pill">역 타입 ${escapeHtml(hotel.station.type)}</span>` : ''}
          </div>
          <div class="free-links">
            ${hotel.website ? `<a href="${escapeHtml(hotel.website)}" target="_blank" rel="noopener noreferrer">공식 사이트</a>` : ''}
            <a href="${googleWalkUrl(hotel, state.destination)}" target="_blank" rel="noopener noreferrer">도보 보기</a>
            <a href="${googleTransitUrl(hotel, state.destination)}" target="_blank" rel="noopener noreferrer">대중교통 보기</a>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderDetours(list){
    const el = $('freeDetourResults');
    if (!list.length) {
      el.innerHTML = '<div class="free-empty">근처에 추천할 만한 들름 장소를 찾지 못했습니다.</div>';
      return;
    }
    el.innerHTML = list.map((spot, idx) => `
      <div class="free-card">
        <div class="free-title">${idx + 1}. ${escapeHtml(spot.name)}</div>
        <div class="muted">${escapeHtml(spot.kind || 'spot')}</div>
        <div class="free-links">
          <a href="${googleWalkUrl(state.destination, spot)}" target="_blank" rel="noopener noreferrer">도보 보기</a>
          <a href="https://www.google.com/maps/search/?api=1&query=${spot.lat},${spot.lng}" target="_blank" rel="noopener noreferrer">지도 열기</a>
        </div>
      </div>
    `).join('');
  }

  async function buildHotelRanking(destination, hotels, stations, limit){
    const dedup = [];
    const seen = new Set();
    hotels.forEach(hotel => {
      const key = `${(hotel.name || '').toLowerCase()}|${hotel.lat.toFixed(4)}|${hotel.lng.toFixed(4)}`;
      if (!seen.has(key)) {
        seen.add(key);
        dedup.push(hotel);
      }
    });

    const withNearest = dedup.map(hotel => {
      const nearest = stations.length ? stations.slice().sort((a,b) => haversineMeters(hotel, a) - haversineMeters(hotel, b))[0] : null;
      return {
        ...hotel,
        station: nearest || null,
        destinationMeters: haversineMeters(hotel, destination)
      };
    }).sort((a,b) => a.destinationMeters - b.destinationMeters).slice(0, Math.max(limit, 3) + 2);

    const out = [];
    for (const hotel of withNearest) {
      let stationWalk = null;
      if (hotel.station) {
        stationWalk = await getWalkingEstimate(hotel, hotel.station);
        await sleep(180);
      }
      let score = 0;
      if (stationWalk) {
        if (stationWalk.durationSeconds <= 8 * 60) score += 35;
        else if (stationWalk.durationSeconds <= 12 * 60) score += 25;
        else score += 12;
      } else {
        score += 8;
      }

      if (hotel.destinationMeters <= 700) score += 30;
      else if (hotel.destinationMeters <= 1200) score += 22;
      else if (hotel.destinationMeters <= 1800) score += 14;
      else score += 8;

      if (hotel.website) score += 10;
      if (hotel.stars) score += 8;
      if (hotel.brand) score += 5;
      if ((hotel.kind || '').includes('hotel')) score += 5;

      out.push({ ...hotel, stationWalk, score });
    }

    return out.sort((a,b) => b.score - a.score).slice(0, limit);
  }

  function clearFreeResults(){
    state.destination = null;
    state.hotels = [];
    state.detours = [];
    $('freeSummary').textContent = '여행지를 입력하고 버튼을 누르면 근처 숙소와 가장 가까운 역을 찾아줍니다.';
    $('freeHotelResults').innerHTML = '<div class="free-empty">아직 검색 전입니다.</div>';
    $('freeDetourResults').innerHTML = '<div class="free-empty">아직 검색 전입니다.</div>';
    $('freeMapMeta').innerHTML = '';
    resetMap();
    if (state.map) state.map.setView([35.6762, 139.6503], 11);
  }

  async function runFreeSearch(){
    const query = ($('freeDestinationInput').value || '').trim();
    if (!query) {
      alert('여행지나 동네 이름을 입력하세요. 예: Tokyo Station, Shibuya, Osaka');
      return;
    }
    const radius = Number($('freeRadius').value || 1800);
    const hotelLimit = Number($('freeHotelLimit').value || 3);
    $('freeSearchBtn').disabled = true;
    $('freeSummary').textContent = '무료 공개 데이터를 불러오는 중입니다...';

    try {
      initMap();
      const destination = await geocodePlace(query);
      if (!destination) {
        $('freeSummary').textContent = '장소를 찾지 못했습니다. 다른 도시명이나 역명으로 다시 시도해 주세요.';
        return;
      }
      destination.shortLabel = query;
      state.destination = destination;

      const [hotels, stations, detours] = await Promise.all([
        findNearbyHotels(destination.lat, destination.lng, radius),
        findNearbyStations(destination.lat, destination.lng, Math.max(900, Math.round(radius * 0.9))),
        findDetourSpots(destination.lat, destination.lng, 700)
      ]);

      const rankedHotels = await buildHotelRanking(destination, hotels, stations, hotelLimit);
      state.hotels = rankedHotels;
      state.detours = detours.slice(0, 5);

      $('freeSummary').innerHTML = `${escapeHtml(destination.name)} 기준으로 숙소 ${rankedHotels.length}개와 들름 후보 ${state.detours.length}개를 정리했습니다.${getORSKey() ? ' 도보 시간은 openrouteservice 우선 계산입니다.' : ' 도보 시간은 무료 근사치 또는 공개 경로 계산 fallback입니다.'}`;
      renderHotels(rankedHotels);
      renderDetours(state.detours);
      drawFreeMap();
    } catch (err) {
      $('freeSummary').textContent = `불러오기에 실패했습니다: ${err.message || err}`;
    } finally {
      $('freeSearchBtn').disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', function(){
    initMap();
    const searchBtn = $('freeSearchBtn');
    const clearBtn = $('freeClearBtn');
    const input = $('freeDestinationInput');
    if (searchBtn) searchBtn.addEventListener('click', runFreeSearch);
    if (clearBtn) clearBtn.addEventListener('click', clearFreeResults);
    if (input) {
      input.addEventListener('keydown', function(e){
        if (e.key === 'Enter') runFreeSearch();
      });
    }
  });
})();
