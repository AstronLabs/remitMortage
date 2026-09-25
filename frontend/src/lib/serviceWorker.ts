// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Service Worker Registration and Management
 * Handles offline caching and network state detection
 */

export interface ServiceWorkerConfig {
  onUpdate?: (registration: ServiceWorkerRegistration) => void;
  onSuccess?: (registration: ServiceWorkerRegistration) => void;
  onOffline?: () => void;
  onOnline?: () => void;
}

/**
 * Register service worker for offline support
 */
export function registerServiceWorker(config?: ServiceWorkerConfig) {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    console.warn('[ServiceWorker] Not supported in this browser');
    return;
  }

  window.addEventListener('load', () => {
    const swUrl = '/service-worker.js';

    navigator.serviceWorker
      .register(swUrl)
      .then((registration) => {
        console.log('[ServiceWorker] Registered successfully');

        // Check for updates periodically
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (!newWorker) return;

          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed') {
              if (navigator.serviceWorker.controller) {
                // New version available
                console.log('[ServiceWorker] New content available');
                config?.onUpdate?.(registration);
              } else {
                // Content cached for offline use
                console.log('[ServiceWorker] Content cached for offline use');
                config?.onSuccess?.(registration);
              }
            }
          });
        });
      })
      .catch((error) => {
        console.error('[ServiceWorker] Registration failed:', error);
      });

    // Monitor online/offline status
    window.addEventListener('online', () => {
      console.log('[ServiceWorker] Network status: ONLINE');
      config?.onOnline?.();
    });

    window.addEventListener('offline', () => {
      console.log('[ServiceWorker] Network status: OFFLINE');
      config?.onOffline?.();
    });
  });
}

/**
 * Unregister service worker
 */
export function unregisterServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready
      .then((registration) => {
        registration.unregister();
        console.log('[ServiceWorker] Unregistered');
      })
      .catch((error) => {
        console.error('[ServiceWorker] Unregister failed:', error);
      });
  }
}

/**
 * Check if currently offline
 */
export function isOffline(): boolean {
  return !navigator.onLine;
}

/**
 * Clear all service worker caches
 */
export async function clearServiceWorkerCache(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  const registration = await navigator.serviceWorker.ready;
  if (registration.active) {
    registration.active.postMessage({ type: 'CLEAR_CACHE' });
  }

  // Also clear caches directly
  if ('caches' in window) {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith('remitmortgage-'))
        .map((name) => caches.delete(name))
    );
  }
}

/**
 * Force service worker to skip waiting and activate
 */
export async function updateServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  const registration = await navigator.serviceWorker.ready;
  if (registration.waiting) {
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    window.location.reload();
  }
}
