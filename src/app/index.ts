// M20 app — public surface. Tests import from here; nothing in src/ does
// (app-not-imported-anywhere law: the composition root is the top).

export { loadConfig, secretShaped, ConfigError } from './config.js';
export type { Thea2Config, ConfigIssue, ConfigErrorCode } from './config.js';
export { compose } from './compose.js';
export type { ComposePreset, ComposeOpts, System, SystemPaths } from './compose.js';
export { makePipeline, UNDELIVERED_HEAD } from './pipeline.js';
export type { Pipeline, PipelineDeps } from './pipeline.js';
export { makeEmbedder } from './embedder.js';
export { startThead } from './thead.js';
export type { TheadHandle } from './thead.js';
export { cliMain, NOT_BUILT } from './cli.js';
export type { CliIo } from './cli.js';
export { main } from './main.js';
