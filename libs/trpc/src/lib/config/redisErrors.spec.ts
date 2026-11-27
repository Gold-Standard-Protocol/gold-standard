import { EventEmitter } from 'node:events';
import { reportErrorsOnce } from './redisErrors';

describe('reportErrorsOnce', () => {
  it('reports the first error of an outage and stays quiet for the retries after it', () => {
    const emitter = new EventEmitter();
    const lines: string[] = [];
    reportErrorsOnce(emitter, 'Price queue', { report: (line) => lines.push(line) });

    emitter.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    emitter.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'));

    expect(lines).toEqual(['Price queue: connect ECONNREFUSED 127.0.0.1:6379']);
  });

  it('stays quiet after a ready event when nothing re-arms it', () => {
    const emitter = new EventEmitter();
    const lines: string[] = [];
    reportErrorsOnce(emitter, 'Price queue', { report: (line) => lines.push(line) });

    emitter.emit('error', new Error('first'));
    emitter.emit('ready');
    emitter.emit('error', new Error('second'));

    expect(lines).toEqual(['Price queue: first']);
  });

  it('reports the next outage again once the connection is ready', () => {
    const emitter = new EventEmitter();
    const lines: string[] = [];
    reportErrorsOnce(emitter, 'Indexer Redis', { rearmOn: emitter, report: (line) => lines.push(line) });

    emitter.emit('error', new Error('first'));
    emitter.emit('ready');
    emitter.emit('error', new Error('second'));

    expect(lines).toEqual(['Indexer Redis: first', 'Indexer Redis: second']);
  });

  it('keeps an error with no listener of its own from throwing out of the emitter', () => {
    const emitter = new EventEmitter();
    reportErrorsOnce(emitter, 'Queue', { report: () => undefined });
    expect(() => emitter.emit('error', new Error('boom'))).not.toThrow();
  });
});
