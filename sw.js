const CACHE_NAME = 'ff-league-v3';

importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyAd9e5eLTZkxVyimuJFoCV_M_RflsFlQHc',
  authDomain: 'ff-leauge.firebaseapp.com',
  databaseURL: 'https://ff-leauge-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'ff-leauge',
  storageBucket: 'ff-leauge.firebasestorage.app',
  messagingSenderId: '26073423984',
  appId: '1:26073423984:web:f14329a6fa1506ec14b5'
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  const n = payload.notification || {};
  const d = payload.data || {};

  const title = n.title || d.title || 'FF LEAGUE';
  const body = n.body || d.body || 'Tournament starts in 10 minutes.';
  const url = d.url || './';

  return self.registration.showNotification(title, {
    body: body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: d.tag || ('ff-league-' + Date.now()),
    renotify: true,
    data: {
      url: url
    }
  });
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  const url =
    event.notification &&
    event.notification.data &&
    event.notification.data.url
      ? event.notification.data.url
      : './';

  event.waitUntil(
    clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then(function(clientList) {

      for (const client of clientList) {
        if ('focus' in client) {
          if ('navigate' in client) {
            client.navigate(url);
          }
          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(url);
      }

      return null;
    })
  );
});

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request).catch(function() {
      return caches.match(event.request);
    })
  );
});
