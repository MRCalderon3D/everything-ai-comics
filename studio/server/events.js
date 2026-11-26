'use strict';
/**
 * Server-Sent Events, one stream per project.
 *
 * Event types: hello (once, on connect), job, log, activity, files, chat,
 * and heartbeat. Every event carries a JSON object as its data.
 */

class EventHub {
  constructor({ heartbeatMs = 15000 } = {}) {
    this.clients = new Map(); // project id -> Set<res>
    this.seq = 0;
    this.timer = setInterval(() => this.heartbeat(), heartbeatMs);
    if (this.timer.unref) this.timer.unref();
  }

  /** Attach a response as an event stream for a project. */
  subscribe(projectId, req, res, hello) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write('retry: 2000\n\n');
    if (!this.clients.has(projectId)) this.clients.set(projectId, new Set());
    const set = this.clients.get(projectId);
    set.add(res);
    this.write(res, 'hello', hello || {});
    const drop = () => {
      set.delete(res);
      if (!set.size) this.clients.delete(projectId);
    };
    req.on('close', drop);
    res.on('error', drop);
  }

  write(res, type, data) {
    this.seq += 1;
    try {
      res.write(`id: ${this.seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      // the client went away; the close handler removes it
    }
  }

  emit(projectId, type, data) {
    const set = this.clients.get(projectId);
    if (!set) return;
    for (const res of set) this.write(res, type, data);
  }

  heartbeat() {
    const at = new Date().toISOString();
    for (const set of this.clients.values()) {
      for (const res of set) this.write(res, 'heartbeat', { at });
    }
  }

  close() {
    clearInterval(this.timer);
    for (const set of this.clients.values()) {
      for (const res of set) {
        try { res.end(); } catch (err) { /* ignore */ }
      }
    }
    this.clients.clear();
  }
}

module.exports = { EventHub };
