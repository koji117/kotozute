// キーの画面（desktop/key.html）と地図のデータの画面（desktop/data.html）が使う。どれも引数を main が確かめる。
//   setKey：渡せるのは「保存するキー」か null（キーなしで使う）だけ。
//   data：今の様子を聞く、作り始める、止める、終了する（どれも引数なし）。main から様子が届くと onState の関数を呼ぶ。
// sandbox の画面の preload は CommonJS にする（ESM の preload は sandbox では使えない）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kotozute', {
  setKey: (key) => ipcRenderer.invoke('key', key),
  data: {
    state: () => ipcRenderer.invoke('data:state'),
    start: () => ipcRenderer.invoke('data:start'),
    stop: () => ipcRenderer.invoke('data:stop'),
    quit: () => ipcRenderer.invoke('data:quit'),
    onState: (f) => { ipcRenderer.on('data:state', (_e, s) => f(s)); },
  },
});
