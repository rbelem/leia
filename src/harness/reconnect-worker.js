// Reconnect heartbeat for the harness page (dev tooling only).
//
// Firefox heavily throttles setTimeout/setInterval on pages whose window is
// occluded (and in background tabs), which stalls the harness's WS reconnect
// loop for tens of seconds and makes leia-ctl flaky. Timer callbacks inside a
// dedicated Worker are NOT occlusion-throttled, so this worker acts as a
// reliable heartbeat: the page reconnects whenever it receives a tick and its
// socket is closed.
setInterval(() => self.postMessage("tick"), 500);
