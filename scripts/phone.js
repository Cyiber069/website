// Starts Nightshift reachable from other devices on the same network (token still required).
process.env.HOST = '0.0.0.0';
require('../server/index.js');
