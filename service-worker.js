const CACHE_NAME = 'kinaflix-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/view.html',
  '/admin.html',
  '/style.css',
  '/app.js',
  '/player.js',
  '/chat.js',
  '/firebase-config.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js'
];

// Install Service Worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

// Activate Service Worker
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Strategy: Cache First, Network Fallback
self.addEventListener('fetch', event => {
  // Skip Firebase and external resources
  if (event.request.url.includes('firebase') || 
      event.request.url.includes('cdnjs')) {
    return;
  }
  
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response;
        }
        
        return fetch(event.request)
          .then(response => {
            // Don't cache if not a valid response
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            
            // Clone the response
            const responseToCache = response.clone();
            
            caches.open(CACHE_NAME)
              .then(cache => {
                cache.put(event.request, responseToCache);
              });
            
            return response;
          })
          .catch(() => {
            // Return offline page for HTML requests
            if (event.request.headers.get('accept').includes('text/html')) {
              return caches.match('/index.html');
            }
          });
      })
  );
});

// Handle periodic updates
self.addEventListener('periodicsync', event => {
  if (event.tag === 'update-content') {
    event.waitUntil(updateContent());
  }
});

async function updateContent() {
  // Background content updates can be implemented here
  console.log('Updating content in background...');
}
