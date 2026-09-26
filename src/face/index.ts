// v9 face (plan thea2-v9-parity.md): the Mini App and voice mode — Diego's
// window onto her (feelings with their causes, thoughts, what she is doing)
// and the live call line. She is never shown any of it.

export { startFaceServer, type FaceServer, type FaceServerDeps } from './server.js';
export { nowView, affectHistory, whyView, mindView, familyView, moneyView, SOURCE_WORDS, type FaceSources } from './data.js';
export { makeLive, liveInstructions, CALL_FRAME, LIVE_MODEL, LIVE_VOICES, LIVE_PRICE_PER_MIN, type Live, type LiveDeps, type SidebandSocket } from './live.js';
