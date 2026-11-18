import { Router } from '../lib/http';
import * as agent from './agent';
import * as auth from './auth';
import * as connections from './connections';
import * as dashboard from './dashboard';
import * as discounts from './discounts';
import * as people from './people';
import * as hooks from './hooks';
import * as kb from './kb';
import * as recovery from './recovery';
import * as sales from './sales';
import * as support from './support';
import * as testing from './testing';
import * as voice from './voice';

/** Every API route in one place. Each module owns its own paths. */
export function buildRouter(): Router {
  const r = new Router();
  auth.register(r);
  agent.register(r);
  dashboard.register(r);
  people.register(r);
  kb.register(r);
  voice.register(r);
  recovery.register(r);
  discounts.register(r);
  sales.register(r);
  support.register(r);
  connections.register(r);
  hooks.register(r);
  testing.register(r);
  return r;
}
