/**
 * Validation worker pool — G1.
 * Separate from the main CADWorkerPool so clash/tool-path jobs don't block
 * interactive renders. Sized to (hardwareConcurrency - 1), capped to [2, 4].
 */

import { buildWorkerFiles } from './catalog.js';

const POOL_SIZE = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));

class ValidationWorkerPool {
    constructor(size) {
        this.size = size;
        this.workers = [];
        this.queue = [];
        this.callbacks = new Map();
        this._dispatchCount = 0;
        this._hitCount = 0;
    }

    _spawn() {
        const id = Math.random().toString(36).slice(2, 9);
        const worker = new Worker(new URL('../cad.worker.js', import.meta.url), { type: 'module' });
        const entry = { id, worker, busy: false, jobId: null };

        worker.onmessage = ({ data }) => {
            if (data.type === 'ready') {
                entry.busy = false;
                this._drain();
            } else if (data.type === 'result') {
                entry.busy = false;
                const cb = this.callbacks.get(data.jobId);
                if (cb) { cb(data); this.callbacks.delete(data.jobId); }
                this._drain();
            }
        };

        worker.onerror = () => {
            this.workers = this.workers.filter(w => w.id !== id);
            const cb = this.callbacks.get(entry.jobId);
            if (cb) { cb({ ok: false, error: 'Worker crash' }); this.callbacks.delete(entry.jobId); }
            setTimeout(() => this._drain(), 50);
        };

        worker.postMessage({ type: 'init' });
        this.workers.push(entry);
        return entry;
    }

    _drain() {
        if (this.queue.length === 0) return;
        let idle = this.workers.find(w => !w.busy);
        if (!idle && this.workers.length < this.size) {
            this._spawn(); // will re-drain on 'ready'
            return;
        }
        if (!idle) return;
        const job = this.queue.shift();
        idle.busy = true;
        idle.jobId = job.jobId;
        idle.worker.postMessage(job);
    }

    dispatch(job, callback) {
        this._dispatchCount++;
        if (job.sourceCode && !job.files) {
            job.files = buildWorkerFiles(job.sourceCode);
        }
        this.callbacks.set(job.jobId, callback);
        this.queue.push(job);
        this._drain();
    }

    /** Stats for debugging — how many jobs dispatched vs. short-circuited by broad-phase. */
    stats() {
        return { dispatched: this._dispatchCount, poolSize: this.size, queueDepth: this.queue.length };
    }
}

export const validationPool = new ValidationWorkerPool(POOL_SIZE);
