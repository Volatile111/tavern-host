// Panel-wide events ('state', 'line', 'removed', 'job') that main.ts forwards to connected browsers.
import { EventEmitter } from 'node:events';

export const events = new EventEmitter();
events.setMaxListeners(100);
