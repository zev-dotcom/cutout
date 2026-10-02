/* Smith service worker: push notifications and a click-through to the thread.
   No caching: the app always loads fresh from the network. */
self.addEventListener("install", function(){ self.skipWaiting(); });
self.addEventListener("activate", function(e){ e.waitUntil(self.clients.claim()); });

self.addEventListener("push", function(e){
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = {}; }
  var count = d.count || 0;
  var title = d.test ? "Smith" : "Smith · " + (d.title || "new message");
  var body = d.body || (d.test ? "Notifications are working." : (d.mention ? "mentioned you" + (count > 1 ? " · " + count + " new messages" : "") : count + " new message" + (count === 1 ? "" : "s")));
  var opts = {
    body: body,
    icon: "icons/icon-192.png",
    badge: "icons/badge-96.png",
    tag: d.thread_id || "smith",       // one notification per thread, updated in place
    renotify: true,
    data: { thread_id: d.thread_id || null }
  };
  var jobs = [self.registration.showNotification(title, opts)];
  if (self.navigator && self.navigator.setAppBadge && typeof d.total === "number") {
    jobs.push(d.total > 0 ? self.navigator.setAppBadge(d.total) : self.navigator.clearAppBadge());
  }
  e.waitUntil(Promise.all(jobs.map(function(p){ return Promise.resolve(p).catch(function(){}); })));
});

self.addEventListener("notificationclick", function(e){
  e.notification.close();
  var tid = e.notification.data && e.notification.data.thread_id;
  var hash = tid ? "#t=" + encodeURIComponent(tid) : "";
  var url = new URL("./" + hash, self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(list){
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf(self.registration.scope) === 0) {
        if (tid) c.postMessage({ type: "open-thread", thread_id: tid });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
