const CACHE = 'travel-planner-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

// 설치 — 핵심 파일 캐시
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// 활성화 — 오래된 캐시 삭제
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// 요청 처리 — API 호출은 항상 네트워크, 나머지는 캐시 우선
self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  // Anthropic API는 캐시 안 함
  if (url.indexOf('api.anthropic.com') !== -1) return;

  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) return cached;
      return fetch(e.request).then(function(response) {
        // 정상 응답이면 캐시에 저장
        if (response && response.status === 200 && response.type === 'basic') {
          var clone = response.clone();
          caches.open(CACHE).then(function(cache) {
            cache.put(e.request, clone);
          });
        }
        return response;
      }).catch(function() {
        // 오프라인이고 캐시도 없으면 index.html 반환
        return caches.match('./index.html');
      });
    })
  );
});
