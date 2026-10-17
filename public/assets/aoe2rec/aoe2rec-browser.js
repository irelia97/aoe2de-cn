import * as glue from './aoe2rec_js_bg.js';

const wasmResponse = await fetch(new URL('./aoe2rec_js_bg.wasm', import.meta.url));
if (!wasmResponse.ok) throw new Error(`录像解析器加载失败（HTTP ${wasmResponse.status}）`);
const wasmModule = await WebAssembly.instantiateStreaming(wasmResponse, {
  './aoe2rec_js_bg.js': glue
});
glue.__wbg_set_wasm(wasmModule.instance.exports);
wasmModule.instance.exports.__wbindgen_start();

export const {
  GameSettings,
  Player,
  Replay,
  SavegameHeader,
  SavegameSummary,
  Team,
  parse_rec,
  parse_rec_summary
} = glue;
