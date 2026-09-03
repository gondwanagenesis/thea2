// M21 spine — public surface. The compose wiring imports exactly this barrel:
// loadSpineConfig + OpenCodeRunner (+ FakeRunner for hermetic presets). The
// module is self-contained so the SpineRunner seam lands as a three-line diff.

export * from './types.js';
export * from './config.js';
export * from './events.js';
export * from './session.js';
export * from './fake.js';
export * from './runner.js';
export * from './gates.js';
