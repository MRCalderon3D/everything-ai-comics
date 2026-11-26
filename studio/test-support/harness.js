'use strict';
/**
 * Test harness for the studio: start a server on a free port with a
 * temporary home, in fake mode, and talk to it over HTTP the way the browser
 * does. Used by tests/studio-*.test.js and by the script that records the
 * examples in studio/docs/api.md.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server');

/**
 * @param {{home?: string, fake?: boolean, fakeTools?: string[], heartbeatMs?: number, env?: object}} [options]
 */
async function start(options = {}) {
  const home = options.home || fs.mkdtempSync(path.join(os.tmpdir(), 'comics-studio-test-'));
  const app = createServer({
    port: 0,
    home,
    fake: options.fake !== false,
    fakeTools: options.fakeTools,
    heartbeatMs: options.heartbeatMs,
  });
  const { url, port } = await app.listen();

  /** JSON request. Returns { status, body, headers }. */
  async function api(method, route, body, headers = {}) {
    const init = { method, headers: Object.assign({}, headers) };
    if (body !== undefined) {
      init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
      init.body = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    }
    const res = await fetch(url + route, init);
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (err) {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  /** Raw request, for uploads and file downloads. Returns { status, buffer, headers }. */
  async function raw(method, route, body, headers = {}) {
    const res = await fetch(url + route, { method, headers, body });
    return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  }

  /** Wait until a job leaves the queue: done, failed, cancelled or needs_decision. */
  async function waitJob(projectId, jobId, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await api('GET', `/api/projects/${projectId}/jobs/${jobId}`);
      const job = res.body && res.body.job;
      if (job && !['queued', 'running'].includes(job.status)) return job;
      if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish in ${timeoutMs} ms (status ${job && job.status})`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  /** Start an operation and wait for it. Returns the finished job. */
  async function runOp(projectId, op, params = {}, timeoutMs) {
    const res = await api('POST', `/api/projects/${projectId}/ops`, { op, params });
    if (res.status !== 202) {
      const err = new Error(`${op} was refused: ${res.status} ${JSON.stringify(res.body)}`);
      err.response = res;
      throw err;
    }
    return waitJob(projectId, res.body.job.id, timeoutMs);
  }

  /** Upload bytes under a file name. Returns the upload object. */
  async function upload(projectId, name, buffer, contentType = 'application/octet-stream') {
    const res = await fetch(`${url}/api/projects/${projectId}/uploads?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': contentType }, body: buffer,
    });
    const body = await res.json();
    if (res.status !== 201) {
      const err = new Error(`upload refused: ${res.status} ${JSON.stringify(body)}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body.upload;
  }

  /**
   * A project ready for pages: set up, style defined from a preset, look page
   * drawn and approved, one character with an approved turnaround.
   * @returns {Promise<string>} the project id
   */
  async function seedProject(title = 'Seed Project', extra = {}) {
    const created = await api('POST', '/api/projects', Object.assign({
      title, description: 'A ferry pilot finds a stowaway and hides him.', pages: 2,
    }, extra));
    if (created.status !== 201) throw new Error(`project not created: ${JSON.stringify(created.body)}`);
    const id = created.body.project.id;
    const expectDone = (job, what) => {
      if (job.status !== 'done') throw new Error(`${what}: ${job.status} ${JSON.stringify(job.error)}`);
      return job;
    };
    expectDone(await waitJob(id, created.body.job.id), 'project.setup');
    expectDone(await runOp(id, 'style.define', { preset: 'ligne-claire' }), 'style.define');
    const look = expectDone(await runOp(id, 'style.look', {}), 'style.look');
    let res = await api('POST', `/api/projects/${id}/approve/asset`, { candidate: look.result.candidate_id });
    if (res.status !== 200) throw new Error(`look not approved: ${JSON.stringify(res.body)}`);
    const character = expectDone(await runOp(id, 'character.create', { name: 'Mara', description: 'A ferry pilot.' }), 'character.create');
    res = await api('POST', `/api/projects/${id}/approve/asset`, { candidate: character.result.sheet.candidate_id });
    if (res.status !== 200) throw new Error(`character not approved: ${JSON.stringify(res.body)}`);
    return id;
  }

  /**
   * Open the event stream of a project. Returns { events, waitFor, close }:
   * events is the list received so far, each { type, data }.
   */
  function openEvents(projectId) {
    const http = require('http');
    const events = [];
    const waiters = [];
    let buffer = '';
    const req = http.get(`${url}/api/projects/${projectId}/events`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const event = { type: 'message', data: null, id: null, status: res.statusCode, contentType: res.headers['content-type'] };
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event.type = line.slice(7);
            else if (line.startsWith('id: ')) event.id = line.slice(4);
            else if (line.startsWith('data: ')) {
              try { event.data = JSON.parse(line.slice(6)); } catch (err) { event.data = line.slice(6); }
            }
          }
          if (event.data === null && event.type === 'message') continue; // the retry line
          events.push(event);
          for (const w of waiters.slice()) {
            if (w.pred(event)) {
              waiters.splice(waiters.indexOf(w), 1);
              clearTimeout(w.timer);
              w.resolve(event);
            }
          }
        }
      });
    });
    req.on('error', () => {});
    return {
      events,
      waitFor(pred, timeoutMs = 10000) {
        const found = events.find(pred);
        if (found) return Promise.resolve(found);
        return new Promise((resolve, reject) => {
          const w = { pred, resolve };
          w.timer = setTimeout(() => {
            waiters.splice(waiters.indexOf(w), 1);
            reject(new Error(`no matching event in ${timeoutMs} ms (got ${events.map((e) => e.type).join(',')})`));
          }, timeoutMs);
          waiters.push(w);
        });
      },
      close() {
        req.destroy();
      },
    };
  }

  async function close({ keep = false } = {}) {
    await app.close();
    if (!keep && !options.home) {
      try {
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
      } catch (err) {
        // a file still held open on Windows: the OS temp cleaner takes it
      }
    }
  }

  return { app, url, port, home, api, raw, waitJob, runOp, upload, seedProject, openEvents, close };
}

module.exports = { start };
