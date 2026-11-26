'use strict';
/**
 * Server-Sent Events, one stream per project.
 *
 * Event types: hello (once, on connect), job, log, activity, files, chat,
 * and heartbeat. Every event carries a JSON object as its data. Text in the
 * data is written in the language of the stream: the ?lang= it was opened
 * with, else the interface language of the project at the time of the event.
 */

const i18n = require('./i18n');

class EventHub {
  /**
   * @param {{heartbeatMs?: number, languageOf?: (projectId: string) => string}} [options]
   */
  constructor({ heartbeatMs = 15000, languageOf = null } = {}) {
    this.clients = new Map(); // project id -> Set<{ res, lang }>
    this.languageOf = languageOf || (() => i18n.DEFAULT_LANG);
    this.seq = 0;
    this.timer = setInterval(() => this.heartbeat(), heartbeatMs);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Attach a response as an event stream for a project.
   * @param {string|null} lang an explicit language for this stream, or null
   *   to follow the project's interface language
   */
  subscribe(projectId, req, res, hello, lang = null) {
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
    const client = { res, lang: i18n.normalize(lang) };
    set.add(client);
    this.write(res, 'hello', i18n.localize(client.lang || this.resolve(projectId), hello || {}));
    const drop = () => {
      set.delete(client);
      if (!set.size) this.clients.delete(projectId);
    };
    req.on('close', drop);
    res.on('error', drop);
  }

  resolve(projectId) {
    try {
      return i18n.normalize(this.languageOf(projectId)) || i18n.DEFAULT_LANG;
    } catch (err) {
      return i18n.DEFAULT_LANG;
    }
  }

  write(res, type, data) {
    this.seq += 1;
    try {
      res.write(`id: ${this.seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      // the client went away; the close handler removes it
    }
  }

  /** Send an event to every stream of a project, each in its own language. */
  emit(projectId, type, data) {
    const set = this.clients.get(projectId);
    if (!set) return;
    const byLang = new Map();
    let projectLang = null;
    for (const client of set) {
      if (!client.lang && !projectLang) projectLang = this.resolve(projectId);
      const lang = client.lang || projectLang;
      if (!byLang.has(lang)) byLang.set(lang, i18n.localize(lang, data));
      this.write(client.res, type, byLang.get(lang));
    }
  }

  heartbeat() {
    const at = new Date().toISOString();
    for (const set of this.clients.values()) {
      for (const client of set) this.write(client.res, 'heartbeat', { at });
    }
  }

  close() {
    clearInterval(this.timer);
    for (const set of this.clients.values()) {
      for (const client of set) {
        try { client.res.end(); } catch (err) { /* ignore */ }
      }
    }
    this.clients.clear();
  }
}

module.exports = { EventHub };
